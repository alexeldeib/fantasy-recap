// Claude writes the jokes: web research for real plays, a draft, then a punch-up pass. Structured JSON out.
// The weekly recap mirrors fantasy_recap/writer.py; the game-day update is new here.
import Anthropic from "@anthropic-ai/sdk";
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

/** Best effort: web-search real NFL moments (big plays, bloopers, memes), for these players or (no players) the whole slate. */
export async function research(client: Anthropic, when: string, who: Map<string, string>, uses = 8): Promise<string | null> {
  const focus = who.size ? "Focus on these players, who are on a fantasy league's rosters (their fantasy team in parentheses):\n"
    + [...who].map(([p, t]) => `${p} (${t})`).join("; ") : "Cover the biggest moments across all of those games.";
  const ask = `${when} Search the web for the real-life moments fans are talking about: huge plays, bloopers, bizarre `
    + `moments, viral memes, sideline drama. ${focus}`
    + `\n\nReply with up to ${uses} short bullets: the player, what happened, why people are talking about it, and one source URL. `
    + "Only include on-field moments that the league, a team or an established sports outlet confirms. "
    + "Skip injuries and anything off the field: legal, personal or health news.";
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: ask }];
  let msg: Anthropic.Message | undefined;
  for (let i = 0; i < 5; i++) { // a server-side search can pause mid-turn; resending the paused turn resumes it
    msg = await client.messages.create({ model: MODEL, max_tokens: 16000, tools: [{ ...WEB_SEARCH, max_uses: uses }],
      messages, output_config: { effort: "medium" } });
    if (msg.stop_reason !== "pause_turn") break;
    messages = [messages[0]!, { role: "assistant", content: msg.content }];
  }
  return msg!.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || null;
}

/** The players a weekly recap's research covers: every starter, plus benched players who scored big. */
export function weeklyCast(facts: J): Map<string, string> {
  const who = new Map<string, string>();
  for (const [team, lineup] of Object.entries<J>(facts.lineups)) {
    for (const x of [...lineup.started, ...lineup.bench.filter((b: J) => b.pts >= 15)]) if (!who.has(x.player)) who.set(x.player, team);
  }
  return who;
}

/** One structured-output call. Throws on anything but a clean finish, so the workflow step can retry it. */
export async function ask(client: Anthropic, system: string, payload: J, schema: object = SCHEMA,
  effort: "low" | "medium" | "high" = "high"): Promise<[J, string]> {
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
  return [JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join("")), msg.model];
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
