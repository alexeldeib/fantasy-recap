// Claude writes the jokes: web research for real plays, a draft, then a punch-up pass. Structured JSON out.
// The weekly recap mirrors fantasy_recap/writer.py; the game-day update is new here.
import Anthropic from "@anthropic-ai/sdk";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { J } from "./facts.ts";
import { displayName } from "./render.ts";

export const MODEL = "claude-opus-5-5";

const LINES = {
  type: "array", items: { type: "object", additionalProperties: false, required: ["key", "line"],
    properties: { key: { type: "string" }, line: { type: "string" } } },
};
export const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "dek", "hero_value", "hero_caption", "pen_notes", "story_title", "story", "power_lines",
    "award_lines", "game_lines", "preview_lines", "signoff"],
  properties: {
    headline: { type: "string" }, dek: { type: "string" }, hero_value: { type: "string" }, hero_caption: { type: "string" },
    pen_notes: { type: "array", items: { type: "string" } }, story_title: { type: "string" },
    story: { type: "array", items: { type: "string" } }, power_lines: LINES, award_lines: LINES, game_lines: LINES,
    preview_lines: LINES, signoff: { type: "string" },
  },
};
export const GAMEDAY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["headline", "dek", "game_lines", "pen_notes", "signoff"],
  properties: {
    headline: { type: "string" }, dek: { type: "string" }, game_lines: LINES,
    pen_notes: { type: "array", items: { type: "string" } }, signoff: { type: "string" },
  },
};

const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 8 } as const;

/** Opus 5.5 list prices: per token, and per web search. */
const PRICE = { input: 4e-6, output: 20e-6, cache_read: 0.2e-6, cache_write: 5e-6, search: 0.01 };
type Usage = Pick<Anthropic.Usage, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"> & {
  server_tool_use?: { web_search_requests?: number | null } | null;
};
export interface Spend { step: string; input: number; output: number; cache_read: number; cache_write: number; searches: number; usd: number }

/** What one step's calls cost, from the usage the API reports. Saved with each recap, so pricing rests on real numbers.
 *  `rate` is 0.5 for Batch API calls, which bill at half price. */
export function spend(step: string, usages: Usage[], rate = 1): Spend {
  const sum = (f: (u: Usage) => number | null | undefined) => usages.reduce((n, u) => n + (f(u) ?? 0), 0);
  const t = { input: sum((u) => u.input_tokens), output: sum((u) => u.output_tokens), cache_read: sum((u) => u.cache_read_input_tokens),
    cache_write: sum((u) => u.cache_creation_input_tokens), searches: sum((u) => u.server_tool_use?.web_search_requests) };
  const usd = t.input * PRICE.input + t.output * PRICE.output + t.cache_read * PRICE.cache_read + t.cache_write * PRICE.cache_write + t.searches * PRICE.search;
  return { step, ...t, usd: Math.round(usd * rate * 1e4) / 1e4 };
}

/** Best effort: web-search real NFL moments (big plays, bloopers, memes), for these players or (no players) the whole slate. */
export async function research(client: Anthropic, when: string, who: Map<string, string>, uses = 8): Promise<[string | null, Spend]> {
  const focus = who.size ? "Focus on these players, who are on a fantasy league's rosters (their fantasy team in parentheses):\n"
    + [...who].map(([p, t]) => `${p} (${t})`).join("; ") : "Cover the biggest moments across all of those games.";
  const ask = `${when} Search the web for the real-life moments fans are talking about: huge plays, bloopers, bizarre `
    + `moments, viral memes, sideline drama. ${focus}`
    + `\n\nReply with up to ${uses} short bullets: the player, what happened, why people are talking about it, and one source URL. `
    + "Only include on-field moments that the league, a team or an established sports outlet confirms. "
    + "Skip injuries and anything off the field: legal, personal or health news.";
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: ask }];
  let msg: Anthropic.Message | undefined;
  const usages: Usage[] = [];
  for (let i = 0; i < 5; i++) { // a server-side search can pause mid-turn; resending the paused turn resumes it
    msg = await client.messages.create({ model: MODEL, max_tokens: 16000, tools: [{ ...WEB_SEARCH, max_uses: uses }],
      messages, output_config: { effort: "medium" } });
    usages.push(msg.usage);
    if (msg.stop_reason !== "pause_turn") break;
    messages = [messages[0]!, { role: "assistant", content: msg.content }];
  }
  return [msg!.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || null, spend("research", usages)];
}

/** One structured-output call. Throws on anything but a clean finish, so the workflow step can retry it. */
export async function ask(client: Anthropic, system: string, payload: J, schema: object = SCHEMA,
  effort: "low" | "medium" | "high" = "high", step = "write"): Promise<[J, string, Spend]> {
  // Streamed with room to think: 16k tokens ran out on a busy week and silently fell back to template copy.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 128000, // Opus 5.5's output ceiling; billed only for what's used
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    output_config: { effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason !== "end_turn") throw new Error(`stop_reason=${msg.stop_reason}`);
  // After a mid-stream fallback the new model continues the partial text, so the JSON spans text blocks.
  return [JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join("")), msg.model, spend(step, [msg.usage])];
}

export function templateCopy(f: J): J {
  const a = Object.fromEntries(f.awards.map((x: J) => [x.key, x]));
  const lead = a.heartbreaker || a.high;
  return {
    by: "template", headline: lead.label.toUpperCase(), dek: `${lead.team}: ${lead.stat}.`,
    hero_value: a.high.stat.split(" ")[0], hero_caption: `${a.high.team} led the week`,
    pen_notes: [], story_title: "", story: [], power_lines: [], award_lines: [], game_lines: [], preview_lines: [], signoff: "",
  };
}

/** The writer's brief, filled in for one league. */
export function fillBrief(brief: string, facts: J, intro = "", lore: string[] = []): string {
  const kind = [`${facts.teams.length}-team`, facts.scoring, "fantasy football league"].filter(Boolean).join(" ");
  intro ||= `You write the weekly recap for ${displayName(facts.league)}, a ${kind} of friends on Sleeper.`;
  const n = facts.teams.filter((t: J) => t.commish).length;
  const commish = !n ? [] : n === 1 ? ["The commissioner is the team with `commish: true`."]
    : [`The commissioners are the teams with \`commish: true\` (there are ${n}).`];
  const lines = [...lore, ...commish].map((x) => `- ${x}`).join("\n");
  return brief.replaceAll("{{intro}}", () => intro).replaceAll("{{lore}}", () => lines);
}

/** The Batch API version of ask(), for the weekly recap's long calls: submitted, slept on, collected. Half price, and no
 *  connection is held open for the minutes a high-effort draft takes. A batch that errors or expires is resubmitted up to
 *  twice, 20 minutes apart. No server-side fallback here (Batches reject it): a refusal throws, and the caller falls back
 *  to the draft or plain labels. */
export async function askLater(step: WorkflowStep, client: Anthropic, name: string, system: string, payload: J,
  schema: object = SCHEMA, effort: "low" | "medium" | "high" = "high"): Promise<[J, string, Spend]> {
  for (let attempt = 0; ; attempt++) {
    const id = await step.do(`${name}: submit ${attempt}`, async () => (await client.messages.batches.create({
      requests: [{ custom_id: name.replace(/[^\w-]/g, "-"), params: {
        model: MODEL, max_tokens: 128000, system, messages: [{ role: "user", content: JSON.stringify(payload) }],
        output_config: { effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      } }],
    })).id);
    for (let i = 0; ; i++) { // most finish in minutes; the API's ceiling is 24 hours
      await step.sleep(`${name}: wait ${attempt}.${i}`, i < 10 ? "30 seconds" : "2 minutes");
      if (await step.do(`${name}: check ${attempt}.${i}`, async () => (await client.messages.batches.retrieve(id)).processing_status === "ended")) break;
      if (i > 750) throw new NonRetryableError(`${name}: batch ${id} still running after a day`);
    }
    const out = await step.do(`${name}: collect ${attempt}`, async () => {
      for await (const r of await client.messages.batches.results(id)) {
        if (r.result.type !== "succeeded") return null; // errored or expired: worth another try
        const msg = r.result.message;
        if (msg.stop_reason !== "end_turn") throw new NonRetryableError(`${name}: stop_reason=${msg.stop_reason}`);
        return [JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join("")), msg.model, spend(name, [msg.usage], 0.5)] as [J, string, Spend];
      }
      return null;
    });
    if (out) return out;
    if (attempt >= 2) throw new NonRetryableError(`${name}: batch failed three times`);
    await step.sleep(`${name}: back off ${attempt}`, "20 minutes");
  }
}
