// The hosted version: every league's pages at /<slug>, a cron that decides what's due, a Workflow that writes each
// recap (with retries), and a Stripe webhook that turns a league on. Leagues and recaps live in D1.
import Anthropic from "@anthropic-ai/sdk";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import SHELL from "../../fantasy_recap/templates/page.html";
import PUNCHUP from "../../fantasy_recap/prompts/punchup.md";
import WRITER from "../../fantasy_recap/prompts/writer.md";
import GAMEDAY from "./prompts/gameday.md";
import { build, type J, pairs } from "./facts.ts";
import { buildDay, weekday, worthPosting } from "./live.ts";
import { dayPage, dayTail, feedPage, feedStrip, finish, fine, landing, messagePage, type Post, previewBanner, type Site, waitingPage } from "./pages.ts";
import { displayName, page } from "./render.ts";
import { type Due, due } from "./schedule.ts";
import { API, get, players, SCHEDULE, sleeper } from "./sleeper.ts";
import { paidLeague, verify } from "./stripe.ts";
import { ask, fillBrief, GAMEDAY_SCHEMA, research, type Spend, templateCopy, weeklyCast } from "./writer.ts";

interface Env {
  DB: D1Database;
  RECAP: Workflow<Job>;
  ANTHROPIC_API_KEY?: string; // secret; without it weekly recaps ship with plain labels and game-day updates are skipped
  STRIPE_WEBHOOK_SECRET?: string; // secret
  BRAND: string;
  PRICE: string;
  PAYMENT_LINK: string; // a Stripe Payment Link; the league ID rides along as client_reference_id
  EXAMPLE: string; // slug of a league to show off on the landing page
}
interface Job { league_id: string; season: string; week: number; kind: string }
interface League { league_id: string; slug: string; name: string; season: string; paid_via: string | null; intro: string; lore: string }

const LLM = { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "20 minutes" } as const;
const RESERVED = new Set(["go", "stripe", "api", "admin", "about", "pricing", "robots-txt", "favicon-ico"]);

export class RecapWorkflow extends WorkflowEntrypoint<Env, Job> {
  async run(event: WorkflowEvent<Job>, step: WorkflowStep) {
    const { league_id, season, week, kind } = event.payload;
    const db = this.env.DB;
    const save = (status: string, doc: J = null) => step.do(`save (${status})`, async () => {
      await db.prepare("UPDATE recaps SET status = ?, headline = ?, doc = ?, updated_at = CURRENT_TIMESTAMP WHERE league_id = ? AND season = ? AND week = ? AND kind = ?")
        .bind(status, doc?.copy?.headline ?? null, doc && JSON.stringify(doc), league_id, season, week, kind).run();
      return status;
    });
    const league = await step.do("league", () => db.prepare("SELECT * FROM leagues WHERE league_id = ?").bind(league_id).first<League>());
    if (!league) return save("skipped");
    const day = kind.startsWith("day-") ? kind.slice(4) : null;
    const sl = sleeper(league_id, db);
    let facts: J;
    try {
      facts = await step.do("facts", { retries: { limit: 3, delay: "2 minutes", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        if (!pairs(await sl.matchups(week, [])).length) return null; // no games this week: a bye, or the league's season is over
        return day ? buildDay(sl, week, day) : build(sl, week);
      });
    } catch (err) {
      console.error(`facts failed for ${league_id} ${kind} week ${week}: ${err}`);
      return save("failed");
    }
    if (!facts || (day && !worthPosting(facts))) return save("skipped");
    if (!this.env.ANTHROPIC_API_KEY) return day ? save("skipped") : save("done", { facts, copy: templateCopy(facts) });
    const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY, maxRetries: 4 });
    const lore: string[] = JSON.parse(league.lore || "[]");

    if (day) { // a game-day quick hit: one pass, shared news
      const earlier = await step.do("earlier", () => copies(db, league_id, season, week, kind));
      const lastRecap = await step.do("last recap", async () => {
        const row = await db.prepare("SELECT doc FROM recaps WHERE league_id = ? AND season = ? AND week = ? AND kind = 'weekly' AND status = 'done'")
          .bind(league_id, season, week - 1).first<{ doc: string }>();
        return row ? (({ headline, signoff }) => ({ headline, signoff }))(JSON.parse(row.doc).copy) : null;
      });
      const [news, newsCost] = await step.do("news", { timeout: "12 minutes" }, () => dayNews(db, client, day, week, season))
        .catch(() => [null, null] as [null, null]); // best effort
      const kindOf = [`${facts.teams.length}-team`, facts.scoring, "fantasy football league"].filter(Boolean).join(" ");
      const brief = fillBrief(GAMEDAY, facts, `You write the game-day updates for ${displayName(facts.league)}, a ${kindOf} of friends on Sleeper.`, lore);
      try {
        const [copy, model, cost] = await step.do("write", LLM, () => ask(client, brief, { facts, earlier, last_recap: lastRecap, news }, GAMEDAY_SCHEMA, "medium"));
        return save("done", { facts, copy: { ...copy, by: model, news }, cost: total([newsCost, cost]) });
      } catch (err) {
        console.error(`game-day copy failed for ${league_id} ${kind}: ${err}`);
        return save("failed");
      }
    }

    // The weekly recap: research, draft, punch-up. Any failure falls back a step, so the numbers always ship.
    const earlier = await step.do("earlier", () => copies(db, league_id, season, week, "weekly"));
    const [news, researchCost] = await step.do("research", { timeout: "8 minutes" }, async () => {
      try {
        return await research(client.withOptions({ timeout: 300_000, maxRetries: 1 }), `NFL Week ${week} of the ${season} season just finished.`, weeklyCast(facts));
      } catch (err) {
        console.warn(`skipped the web research (${err})`);
        return [null, null] as [null, null];
      }
    });
    const costs: (Spend | null)[] = [researchCost];
    const brief = fillBrief(WRITER, facts, league.intro, lore);
    let copy: J;
    try {
      const [draft, model, draftCost] = await step.do("draft", LLM, () => ask(client, brief, { facts, previous_weeks: earlier, news }, undefined, "high", "draft"));
      costs.push(draftCost);
      try {
        const [final, m, punchCost] = await step.do("punch-up", LLM, () =>
          ask(client, `${brief}\n\n---\n\n${PUNCHUP}`, { facts, previous_weeks: earlier, news, draft }, undefined, "high", "punch-up"));
        costs.push(punchCost);
        copy = { ...final, by: `${m} (draft + punch-up)`, news };
      } catch {
        copy = { ...draft, by: `${model} (draft only)`, news }; // the draft is real copy already
      }
    } catch (err) {
      console.error(`weekly copy failed for ${league_id} week ${week}: ${err}`);
      copy = templateCopy(facts);
    }
    return save("done", { facts, copy, cost: total(costs) });
  }
}

/** A recap's Claude bill: each step's usage and the dollars, at list prices. */
const total = (steps: (Spend | null)[]) => {
  const done = steps.filter((x): x is Spend => !!x);
  return { usd: Math.round(done.reduce((n, x) => n + x.usd, 0) * 1e4) / 1e4, steps: done };
};

/** This season's earlier copy of one kind, oldest first, so the writer doesn't repeat itself. */
async function copies(db: D1Database, league: string, season: string, week: number, kind: string): Promise<J[]> {
  const sql = kind === "weekly"
    ? "SELECT week, doc FROM recaps WHERE league_id = ? AND season = ? AND kind = 'weekly' AND status = 'done' AND week < ? ORDER BY week"
    : "SELECT week, doc FROM recaps WHERE league_id = ? AND season = ? AND kind LIKE 'day-%' AND status = 'done' AND week = ? AND kind < ? ORDER BY kind";
  const { results } = await db.prepare(sql).bind(league, season, week, ...(kind === "weekly" ? [] : [kind])).all<{ week: number; doc: string }>();
  return results.map((r) => {
    const { by: _by, news: _news, ...c } = JSON.parse(r.doc).copy;
    return { week: r.week, ...c };
  });
}

const SEARCHING = "\u0000searching";

/** One web search per game day, shared by every league: the day's big plays and memes. The cron queues every league at
 *  once, so the first to arrive claims the search and the rest wait for it rather than each paying for their own. */
async function dayNews(db: D1Database, client: Anthropic, day: string, week: number, season: string): Promise<[string | null, Spend | null]> {
  const key = `news:${day}`;
  const claimed = (await db.prepare("INSERT OR IGNORE INTO cache (key, value) VALUES (?, ?)").bind(key, SEARCHING).run()).meta.changes;
  if (!claimed) {
    for (let i = 0; i < 40; i++) { // up to ~7 minutes; a search takes one to three
      const hit = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
      if (hit && hit.value !== SEARCHING) return [hit.value || null, null]; // another league paid for this one
      await new Promise((r) => setTimeout(r, 10_000));
    }
    return [null, null]; // ponytail: a search that died mid-claim leaves this day without news; clear its cache row to retry
  }
  let news: string | null = null, cost: Spend | null = null;
  try {
    [news, cost] = await research(client.withOptions({ timeout: 300_000, maxRetries: 1 }), `The NFL's ${weekday(day)} games (Week ${week} of the ${season} season) just finished.`, new Map(), 10);
  } catch (err) {
    console.warn(`no news for ${day} (${err})`);
  }
  await db.prepare("UPDATE cache SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?").bind(news ?? "", key).run();
  return [news, cost];
}

/** Queue recaps that aren't written yet. A recap's row is claimed first, so each one runs once however often this is called. */
async function enqueue(env: Env, season: string, jobs: Due[], only?: string): Promise<number> {
  const leagues = only ? [{ league_id: only }] : (await env.DB.prepare(
    "SELECT league_id FROM leagues WHERE season = ? AND paid_via IS NOT NULL AND paid_via != 'showcase'").bind(season).all<{ league_id: string }>()).results;
  const want = leagues.flatMap((l) => jobs.map((j) => ({ league_id: l.league_id, season, week: j.week, kind: j.kind })));
  if (!want.length) return 0;
  const claimed = await env.DB.batch(want.map((j) =>
    env.DB.prepare("INSERT OR IGNORE INTO recaps (league_id, season, week, kind, status) VALUES (?, ?, ?, ?, 'pending')").bind(j.league_id, j.season, j.week, j.kind)));
  const fresh = want.filter((_, i) => claimed[i]!.meta.changes);
  for (let i = 0; i < fresh.length; i += 100) {
    await env.RECAP.createBatch(fresh.slice(i, i + 100).map((params) => ({ id: `${params.league_id}-${params.season}-${params.week}-${params.kind}`, params })));
  }
  return fresh.length;
}

/** Turn a league on: Stripe says it's paid. The first recap is the latest finished week, written now. */
async function activate(env: Env, leagueId: string, session: string) {
  const row = await findOrAdd(env, leagueId);
  if (!row) return console.error(`paid for ${leagueId}, which isn't a Sleeper football league (checkout ${session}): refund it`);
  await env.DB.prepare("UPDATE leagues SET paid_via = ? WHERE league_id = ? AND (paid_via IS NULL OR paid_via = 'showcase')").bind(session, leagueId).run();
  const week = Number((await get(`${API}/league/${leagueId}`)).settings.last_scored_leg || 0);
  if (week) await enqueue(env, row.season, [{ week, kind: "weekly" }], leagueId);
}

const slugify = (name: string): string => {
  const s = displayName(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return !s ? "league" : /^\d+$/.test(s) ? `league-${s}` : s; // all digits would read as a league ID
};

/** A league's row, adding it (with a fresh slug, or last season's) the first time anyone looks it up. */
async function findOrAdd(env: Env, id: string): Promise<League | null> {
  const find = () => env.DB.prepare("SELECT * FROM leagues WHERE league_id = ?").bind(id).first<League>();
  const row = await find();
  if (row) return row;
  const lg = await get(`${API}/league/${id}`, null);
  if (!lg || lg.sport !== "nfl") return null;
  const prev = lg.previous_league_id
    ? await env.DB.prepare("SELECT slug FROM leagues WHERE league_id = ?").bind(lg.previous_league_id).first<{ slug: string }>() : null;
  let slug = prev?.slug;
  for (let i = 1; !slug; i++) { // ponytail: check-then-insert; two leagues claiming one name in the same second could share it
    const s = i === 1 ? slugify(lg.name) : `${slugify(lg.name)}-${i}`;
    if (!RESERVED.has(s) && !(await env.DB.prepare("SELECT 1 FROM leagues WHERE slug = ? LIMIT 1").bind(s).first())) slug = s;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO leagues (league_id, slug, name, season, previous_league_id) VALUES (?, ?, ?, ?, ?)")
    .bind(id, slug, lg.name, String(lg.season), lg.previous_league_id ?? null).run();
  return find();
}

const html = (body: string, status = 200, maxAge = 60) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": `public, max-age=${maxAge}` } });

/** An unpaid league: its latest finished week with plain labels (no Claude, so it costs nothing), and the pass. */
async function preview(env: Env, site: Site, row: League): Promise<Response> {
  const lg = await get(`${API}/league/${row.league_id}`);
  const week = Number(lg.settings.last_scored_leg || 0);
  if (!week) return html(waitingPage(SHELL, site, lg, row.league_id, false));
  let doc = (await env.DB.prepare("SELECT doc FROM recaps WHERE league_id = ? AND season = ? AND week = ? AND kind = 'preview'")
    .bind(row.league_id, row.season, week).first<{ doc: string }>())?.doc;
  if (!doc) {
    const facts = await build(sleeper(row.league_id, env.DB), week);
    doc = JSON.stringify({ facts, copy: templateCopy(facts) });
    await env.DB.prepare("INSERT OR REPLACE INTO recaps (league_id, season, week, kind, status, headline, doc) VALUES (?, ?, ?, 'preview', 'done', ?, ?)")
      .bind(row.league_id, row.season, week, JSON.parse(doc).copy.headline, doc).run();
  }
  const d = JSON.parse(doc), home = `${site.origin}/${row.slug}/`;
  return html(finish(page(SHELL, d.facts, d.copy, `${home}${row.season}/${week}/`, [d], home,
    { banner: previewBanner(site, lg, row.league_id), fine: fine(site) })), 200, 300);
}

/** /<slug>, /<slug>/<season>/<week> and /<slug>/feed: the latest week (or the one asked for), recap first and its game-day
 *  updates under it; or every post. Each page opens with the "Latest" strip, so nothing new is ever a hunt away. */
async function leaguePage(env: Env, site: Site, key: string, season?: string, week?: number, feed = false): Promise<Response> {
  if (/^\d+$/.test(key)) { // a raw Sleeper ID: look it up (or add it), then send them to the league's page
    const row = await findOrAdd(env, key);
    if (!row) return html(messagePage(SHELL, site, "League not found", "That isn't a Sleeper football league ID. Copy your league's link from the Sleeper app or website and try again."), 404);
    return Response.redirect(`${site.origin}/${row.slug}/${season ? `${season}/${week}/` : ""}`, 302);
  }
  const row = await env.DB.prepare(`SELECT * FROM leagues WHERE slug = ?${season ? " AND season = ?" : ""} ORDER BY season DESC LIMIT 1`)
    .bind(...(season ? [key, season] : [key])).first<League>();
  if (!row) return html(messagePage(SHELL, site, "League not found", "No league lives at that address yet. Paste your Sleeper league link on the front page to find yours."), 404);
  if (!row.paid_via) return preview(env, site, row);
  const home = `${site.origin}/${row.slug}/`;
  // Every post, newest first: within a week the Tuesday recap comes after its game days.
  const posts = (await env.DB.prepare(`SELECT season, week, kind, headline, json_extract(doc, '$.copy.dek') AS dek FROM recaps
      WHERE league_id = ? AND status = 'done' AND kind != 'preview' ORDER BY week DESC, kind = 'weekly' DESC, kind DESC`)
    .bind(row.league_id).all<Post>()).results;
  // The week switcher: every week with a page, headed by its recap or, on a live week, its newest update.
  const weeks = [...new Map(posts.map((p) => [p.week, p] as const)).values()].reverse()
    .map((p) => ({ facts: { season: p.season, week: p.week }, copy: { headline: posts.find((q) => q.week === p.week)!.headline } }));
  if (feed) return html(feedPage(SHELL, site, row, posts, home, weeks));
  const target = week ?? posts[0]?.week;
  if (!target) return html(waitingPage(SHELL, site, { name: row.name, season: row.season }, row.league_id, true));
  const docs = (await env.DB.prepare("SELECT kind, doc FROM recaps WHERE league_id = ? AND week = ? AND status = 'done' AND kind != 'preview' ORDER BY kind DESC")
    .bind(row.league_id, target).all<{ kind: string; doc: string }>()).results;
  const weekly = docs.find((d) => d.kind === "weekly"), days = docs.filter((d) => d.kind.startsWith("day-")).map((d) => JSON.parse(d.doc));
  const url = `${home}${row.season}/${target}/`;
  if (weekly) {
    const d = JSON.parse(weekly.doc);
    return html(finish(page(SHELL, d.facts, d.copy, url, weeks, home, { banner: feedStrip(posts, home, target), tail: dayTail(days, false), fine: fine(site) })));
  }
  if (days.length) return html(dayPage(SHELL, days, site, url, home, weeks, feedStrip(posts, home, target)));
  return html(messagePage(SHELL, site, "No recap that week", `${row.name} has nothing for week ${target} yet.`), 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    const site: Site = { brand: env.BRAND, origin: url.origin, price: env.PRICE, payLink: env.PAYMENT_LINK };
    try {
      if (path === "/stripe/webhook") {
        if (req.method !== "POST") return new Response("POST only", { status: 405 });
        const event = await verify(await req.text(), req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? "");
        if (!event) return new Response("bad signature", { status: 400 });
        const paid = paidLeague(event);
        if (paid) await activate(env, paid.leagueId, paid.session); // a throw here returns 500, and Stripe retries
        return new Response("ok");
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (path === "/") {
        const ex = env.EXAMPLE && await env.DB.prepare("SELECT name FROM leagues WHERE slug = ? LIMIT 1").bind(env.EXAMPLE).first<{ name: string }>();
        return html(landing(SHELL, site, ex ? { slug: env.EXAMPLE, name: displayName(ex.name) } : undefined), 200, 300);
      }
      if (path === "/go") { // the landing page's box: a league link or a bare ID
        const id = (url.searchParams.get("league") ?? "").match(/\d{6,24}/)?.[0];
        return id ? Response.redirect(`${url.origin}/${id}`, 302)
          : html(messagePage(SHELL, site, "That's not a league link", "Paste the link to your league from Sleeper. It has a long number in it, like sleeper.com/leagues/1234567890/team."), 400);
      }
      if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      if (path === "/paid") { // Stripe's Payment Link sends buyers here with ?session={CHECKOUT_SESSION_ID}
        const row = await env.DB.prepare("SELECT slug FROM leagues WHERE paid_via = ?").bind(url.searchParams.get("session") ?? "").first<{ slug: string }>();
        if (row) return Response.redirect(`${url.origin}/${row.slug}/`, 302);
        return html(messagePage(SHELL, site, "Payment received", "Setting up your league now. This page checks again in a few seconds.")
          .replace("</head>", '<meta http-equiv="refresh" content="4"></head>'), 200, 0); // the webhook can trail the redirect by a moment
      }
      const m = path.match(/^\/([a-z0-9-]{1,64})(?:\/(feed)|\/(\d{4})\/(\d{1,2}))?\/?$/);
      if (!m) return html(messagePage(SHELL, site, "Page not found", "Nothing lives at that address."), 404);
      return await leaguePage(env, site, m[1]!, m[3], m[4] ? Number(m[4]) : undefined, !!m[2]);
    } catch (err) {
      console.error(err);
      return html(messagePage(SHELL, site, "Fumble", "Something broke on our end. Try again in a minute."), 500, 0);
    }
  },

  // Every 15 minutes: refresh the player list once a day, then queue whatever's due for every active league.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const state = await get(`${API}/state/nfl`);
    if (state.season_type !== "regular") return; // ponytail: fantasy seasons live in the regular season
    const season = String(state.season);
    ctx.waitUntil((async () => {
      const row = await env.DB.prepare("SELECT updated_at FROM cache WHERE key = 'players'").first<{ updated_at: string }>();
      if (!row || Date.now() - Date.parse(`${row.updated_at.replace(" ", "T")}Z`) > 20 * 3600e3) await players(env.DB, true);
    })());
    const jobs = due(await get(SCHEDULE(season), []), Date.now());
    if (jobs.length) console.log(`queued ${await enqueue(env, season, jobs)} recaps (due: ${jobs.map((j) => `${j.week}:${j.kind}`).join(", ")})`);
  },
};
