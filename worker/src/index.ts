// The hosted version: every league's pages at /<slug>, a cron that decides what's due, a Workflow that writes each
// recap (with retries), and a Stripe webhook that turns a league on. Leagues and recaps live in D1.
import Anthropic from "@anthropic-ai/sdk";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import SHELL from "./page.html";
import GAMEDAY from "./prompts/gameday.md";
import PUNCHUP from "./prompts/punchup.md";
import WRITER from "./prompts/writer.md";
import { editor } from "./editor.ts";
import { build, type J, pairs } from "./facts.ts";
import { buildDay, weekday, worthPosting } from "./live.ts";
import { csp, dayPage, dayTail, feedPage, feedStrip, finish, fine, html, landing, messagePage, paidPage, type Post, previewBanner, type Site,
  termsPage, waitingPage } from "./pages.ts";
import { displayName, page } from "./render.ts";
import { type Due, due } from "./schedule.ts";
import { API, get, players, SCHEDULE, sleeper } from "./sleeper.ts";
import { paidLeague, verify } from "./stripe.ts";
import { ask, askLater, fillBrief, GAMEDAY_SCHEMA, research, type Spend, templateCopy } from "./writer.ts";

interface Env {
  DB: D1Database;
  RECAP: Workflow<Job>;
  ANTHROPIC_API_KEY?: string; // secret; without it weekly recaps ship with plain labels and game-day updates are skipped
  STRIPE_WEBHOOK_SECRET?: string; // secret
  BRAND: string;
  PRICE: string;
  PAYMENT_LINK: string; // a Stripe Payment Link; the league ID rides along as client_reference_id
  EXAMPLE: string; // slug of a league to show off on the landing page
  ORIGIN: string; // the canonical address, e.g. https://thebenchpress.app
}
interface Job { league_id: string; season: string; week: number; kind: string; delay?: number } // delay: seconds before it starts
interface League {
  league_id: string; slug: string; name: string; season: string; paid_via: string | null; intro: string; lore: string; edit_key: string | null;
}

const LLM = { retries: { limit: 3, delay: "2 minutes", backoff: "exponential" }, timeout: "20 minutes" } as const; // rides out ~15 minutes of API trouble
const RESERVED = new Set(["go", "stripe", "api", "admin", "about", "pricing", "terms", "paid", "health", "robots-txt", "favicon-ico"]);

export class RecapWorkflow extends WorkflowEntrypoint<Env, Job> {
  async run(event: WorkflowEvent<Job>, step: WorkflowStep) {
    const { league_id, season, week, kind, delay } = event.payload;
    const db = this.env.DB;
    if (delay) await step.sleep("stagger", delay * 1000);
    const save = (status: string, doc: J = null) => step.do(`save (${status})`, async () => {
      // A rewrite (admin redo) that fails or finds nothing leaves the post that was already up.
      await db.prepare(`UPDATE recaps SET status = ?, headline = ?, dek = ?, doc = ?, updated_at = CURRENT_TIMESTAMP
          WHERE league_id = ? AND season = ? AND week = ? AND kind = ?${status === "done" ? "" : " AND status != 'done'"}`)
        .bind(status, doc?.copy?.headline ?? null, doc?.copy?.dek ?? null, doc && JSON.stringify(slim(doc)), league_id, season, week, kind).run();
      return status;
    });
    // Only what the writer needs: a step's result is kept in the run's history, and the editor key doesn't belong there.
    const league = await step.do("league", () => db.prepare("SELECT intro, lore FROM leagues WHERE league_id = ?").bind(league_id)
      .first<Pick<League, "intro" | "lore">>());
    if (!league) return save("skipped");
    const day = kind.startsWith("day-") ? kind.slice(4) : null;
    const sl = sleeper(league_id, db);
    let facts: J;
    try {
      // Retries back off for about two hours, so a Sleeper outage on Tuesday morning delays the recap instead of losing it.
      facts = await step.do("facts", { retries: { limit: 6, delay: "2 minutes", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
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
      const [news, newsCost] = await step.do("news", { timeout: "12 minutes" }, () =>
        sharedNews(db, client, `news:${day}`, `The NFL's ${weekday(day)} games (Week ${week} of the ${season} season) just finished.`))
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

    // The weekly recap: the week's shared news, a draft, a punch-up. Any failure falls back a step, so the numbers always ship.
    const earlier = await step.do("earlier", () => copies(db, league_id, season, week, "weekly"));
    const [news, newsCost] = await step.do("news", { timeout: "12 minutes" }, () => weekNews(db, client, season, week))
      .catch(() => [null, null] as [null, null]); // best effort
    const costs: (Spend | null)[] = [newsCost];
    const brief = fillBrief(WRITER, facts, league.intro, lore);
    let copy: J;
    try {
      // Batched: half price, and nothing waits on a connection for the minutes a high-effort draft takes.
      const [draft, model, draftCost] = await askLater(step, client, "draft", brief, { facts, previous_weeks: earlier, news });
      costs.push(draftCost);
      try {
        const [final, m, punchCost] = await askLater(step, client, "punch-up", `${brief}\n\n---\n\n${PUNCHUP}`, { facts, previous_weeks: earlier, news, draft });
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

/** A stored recap leaves out what only the writer needed: the lineups, about half of a week's facts. */
const slim = (doc: J): J => (doc?.facts?.lineups ? { ...doc, facts: { ...doc.facts, lineups: undefined } } : doc);

/** One web search shared by every league (a game day's big plays and memes, or a week's): the first league to need it
 *  claims the search, the rest wait for it rather than each paying for their own (the cron queues every league at once). */
async function sharedNews(db: D1Database, client: Anthropic, key: string, when: string): Promise<[string | null, Spend | null]> {
  let claimed = (await db.prepare("INSERT OR IGNORE INTO cache (key, value) VALUES (?, ?)").bind(key, SEARCHING).run()).meta.changes;
  // A claim whose search died with it (a deploy or a timeout mid-search) is taken over after 10 minutes.
  claimed ||= (await db.prepare("UPDATE cache SET updated_at = CURRENT_TIMESTAMP WHERE key = ? AND value = ? AND updated_at < datetime('now', '-10 minutes')")
    .bind(key, SEARCHING).run()).meta.changes;
  if (!claimed) {
    for (let i = 0; i < 40; i++) { // up to ~7 minutes; a search takes one to three
      const hit = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
      if (hit && hit.value !== SEARCHING) return [hit.value || null, null]; // another league paid for this one
      await new Promise((r) => setTimeout(r, 10_000));
    }
    return [null, null]; // still searching after 7 minutes: write without news
  }
  let news: string | null = null, cost: Spend | null = null;
  try {
    [news, cost] = await research(client.withOptions({ timeout: 300_000, maxRetries: 1 }), when, new Map(), 10);
  } catch (err) {
    console.warn(`no news for ${key} (${err})`);
  }
  await db.prepare("UPDATE cache SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?").bind(news ?? "", key).run();
  return [news, cost];
}

/** A week's news for its recap: the week's game-day briefs, already searched and shared, or (if any is missing) one
 *  shared search for the whole week. Nothing is searched per league. */
async function weekNews(db: D1Database, client: Anthropic, season: string, week: number): Promise<[string | null, Spend | null]> {
  const dates = [...new Set<string>((await get(SCHEDULE(season), [])).filter((x: J) => x.week === week).map((x: J) => x.date))].sort();
  const briefs = await Promise.all(dates.map((d) => db.prepare("SELECT value FROM cache WHERE key = ?").bind(`news:${d}`).first<{ value: string }>()));
  if (dates.length && briefs.every((b) => b?.value && b.value !== SEARCHING)) {
    return [dates.map((d, i) => `${weekday(d)}:\n${briefs[i]!.value}`).join("\n\n"), null];
  }
  return sharedNews(db, client, `news:week:${season}-${week}`, `NFL Week ${week} of the ${season} season just finished.`);
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
  // ponytail: 2 seconds apart keeps a burst under Sleeper's 1,000 requests a minute (a weekly recap makes about 20): 30
  // leagues a minute, so 300 leagues take 10 minutes. Spread them wider, or cache more of Sleeper, past that.
  for (let i = 0; i < fresh.length; i += 100) {
    try {
      await env.RECAP.createBatch(fresh.slice(i, i + 100).map((params, j) =>
        ({ id: `${params.league_id}-${params.season}-${params.week}-${params.kind}`, params: { ...params, delay: 2 * (i + j) } })));
    } catch (err) { // release the claims not started yet, so the next tick tries them again (createBatch skips IDs it has)
      await env.DB.batch(fresh.slice(i).map((j) => env.DB.prepare("DELETE FROM recaps WHERE league_id = ? AND season = ? AND week = ? AND kind = ? AND status = 'pending'")
        .bind(j.league_id, j.season, j.week, j.kind)));
      throw err;
    }
  }
  return fresh.length;
}

/** Turn a league on: Stripe says it's paid. The first recap is the latest finished week, written now. A payment that can't
 *  turn anything on (no league named, not a football league, a league that's already on) is flagged for a refund instead:
 *  /health reports it, and /paid tells the buyer. */
async function activate(env: Env, leagueId: string | null, session: string) {
  const refund = async (why: string) => {
    console.error(`refund checkout ${session}: ${why}`);
    await env.DB.prepare("INSERT OR IGNORE INTO cache (key, value) VALUES (?, ?)").bind(`refund:${session}`, why).run();
  };
  const row = leagueId ? await findOrAdd(env, leagueId) : null;
  if (!leagueId || !row) return refund(leagueId ? `${leagueId} isn't a Sleeper football league` : "the checkout didn't name a league");
  const on = await env.DB.prepare("UPDATE leagues SET paid_via = ? WHERE league_id = ? AND (paid_via IS NULL OR paid_via IN ('showcase', ?))")
    .bind(session, leagueId, session).run(); // (the same session again is Stripe redelivering)
  if (!on.meta.changes) return refund(`${row.slug} was already on (${row.paid_via})`);
  // the editor key is the commissioner's login; /paid shows it
  await env.DB.prepare("UPDATE leagues SET edit_key = COALESCE(edit_key, ?) WHERE league_id = ?").bind(crypto.randomUUID().replaceAll("-", ""), leagueId).run();
  const week = Number((await get(`${API}/league/${leagueId}`)).settings.last_scored_leg || 0);
  if (week) await enqueue(env, row.season, [{ week, kind: "weekly" }], leagueId);
}

const slugify = (name: string): string => {
  const s = displayName(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return !s ? "league" : /^\d+$/.test(s) ? `league-${s}` : s; // all digits would read as a league ID
};

/** A league's row, adding it the first time anyone looks it up. A renewed league (Sleeper gives each season a new ID) keeps
 *  last season's address, writer's notes and editor link, and a comp carries over; a paid season doesn't. */
async function findOrAdd(env: Env, id: string): Promise<League | null> {
  const find = () => env.DB.prepare("SELECT * FROM leagues WHERE league_id = ?").bind(id).first<League>();
  const row = await find();
  if (row) return row;
  const lg = await get(`${API}/league/${id}`, null, 300); // cached: repeat lookups of one ID cost Sleeper nothing
  if (!lg || lg.sport !== "nfl") return null;
  const prev = lg.previous_league_id
    ? await env.DB.prepare("SELECT * FROM leagues WHERE league_id = ?").bind(lg.previous_league_id).first<League>() : null;
  let slug = prev?.slug;
  for (let i = 1; !slug; i++) { // ponytail: check-then-insert; two leagues claiming one name in the same second could share it
    const s = i === 1 ? slugify(lg.name) : `${slugify(lg.name)}-${i}`;
    if (!RESERVED.has(s) && !(await env.DB.prepare("SELECT 1 FROM leagues WHERE slug = ? LIMIT 1").bind(s).first())) slug = s;
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO leagues (league_id, slug, name, season, previous_league_id, paid_via, intro, lore, edit_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, slug, lg.name, String(lg.season), lg.previous_league_id ?? null,
    prev?.paid_via === "comp" ? "comp" : null, prev?.intro ?? "", prev?.lore ?? "[]", prev?.edit_key ?? null).run();
  return find();
}

/** Comped leagues that Sleeper renewed for this season: add the new league, which inherits the comp (findOrAdd). Sleeper
 *  links seasons only backwards (previous_league_id), so look through the commissioners' leagues for this season's. */
async function renewComps(env: Env, season: string) {
  const { results } = await env.DB.prepare(`SELECT league_id FROM leagues l WHERE paid_via = 'comp' AND season < ?
    AND NOT EXISTS (SELECT 1 FROM leagues n WHERE n.previous_league_id = l.league_id)`).bind(season).all<{ league_id: string }>();
  for (const { league_id } of results) {
    for (const u of (await get(`${API}/league/${league_id}/users`, [])).filter((u: J) => u.is_owner)) {
      const next = (await get(`${API}/user/${u.user_id}/leagues/nfl/${season}`, [])).find((l: J) => l.previous_league_id === league_id);
      if (next && await findOrAdd(env, next.league_id)) break;
    }
  }
}

/** Once a day, year-round: refresh the player list, tidy storage, and look for comped leagues Sleeper renewed. */
async function daily(env: Env, season: string) {
  const row = await env.DB.prepare("SELECT updated_at FROM cache WHERE key = 'players'").first<{ updated_at: string }>();
  if (row && Date.now() - Date.parse(`${row.updated_at.replace(" ", "T")}Z`) < 20 * 3600e3) return;
  await players(env.DB, true);
  await tidy(env.DB);
  await renewComps(env, season);
}

/** Drop what visitors and failures leave behind, so storage grows only with paid leagues' recaps (about
 *  0.5 MB a league a season). Previews and unpaid leagues come back on the next visit. */
async function tidy(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM recaps WHERE kind = 'preview' AND updated_at < datetime('now', '-14 days')"),
    db.prepare("UPDATE recaps SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND updated_at < datetime('now', '-2 days')"),
    db.prepare("DELETE FROM recaps WHERE status IN ('failed', 'skipped') AND updated_at < datetime('now', '-30 days')"),
    db.prepare("DELETE FROM cache WHERE key LIKE 'news:%' AND updated_at < datetime('now', '-21 days')"),
    db.prepare("DELETE FROM leagues WHERE paid_via IS NULL AND created_at < datetime('now', '-30 days') AND league_id NOT IN (SELECT league_id FROM recaps)"),
  ]);
}

/** An unpaid league: its latest finished week with plain labels (no Claude, so it costs nothing), and the pass. */
async function preview(env: Env, site: Site, row: League): Promise<Response> {
  const lg = await get(`${API}/league/${row.league_id}`, undefined, 300); // cached: a busy preview costs Sleeper one call per 5 minutes
  const week = Number(lg.settings.last_scored_leg || 0);
  if (!week) return html(waitingPage(SHELL, site, lg, row.league_id, false));
  let doc = (await env.DB.prepare("SELECT doc FROM recaps WHERE league_id = ? AND season = ? AND week = ? AND kind = 'preview'")
    .bind(row.league_id, row.season, week).first<{ doc: string }>())?.doc;
  if (!doc) {
    const facts = await build(sleeper(row.league_id, env.DB), week);
    doc = JSON.stringify({ facts, copy: templateCopy(facts) });
    await env.DB.prepare("INSERT OR REPLACE INTO recaps (league_id, season, week, kind, status, headline, doc) VALUES (?, ?, ?, 'preview', 'done', ?, ?)")
      .bind(row.league_id, row.season, week, JSON.parse(doc).copy.headline, JSON.stringify(slim(JSON.parse(doc)))).run();
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
  const posts = (await env.DB.prepare(`SELECT season, week, kind, headline, dek FROM recaps
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
    const res = await route(req, env);
    if (res.headers.get("content-type")?.startsWith("text/html")) res.headers.set("content-security-policy", await csp(SHELL));
    return res;
  },
  // Every 15 minutes: the daily chores (year-round), then whatever's due for every active league.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const state = await get(`${API}/state/nfl`), season = String(state.season);
    ctx.waitUntil(daily(env, season));
    if (state.season_type !== "regular") return; // ponytail: fantasy seasons live in the regular season
    const jobs = due(await get(SCHEDULE(season), []), Date.now());
    if (jobs.length) console.log(`queued ${await enqueue(env, season, jobs)} recaps (due: ${jobs.map((j) => `${j.week}:${j.kind}`).join(", ")})`);
  },
};

/** Every page and endpoint. HTML responses get the Content-Security-Policy on the way out (fetch, above). */
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  const site: Site = { brand: env.BRAND, origin: url.origin, price: env.PRICE, payLink: env.PAYMENT_LINK };
  // The POSTs (the webhook, the editor) are small; nothing gets to make the Worker buffer a big body before it's checked.
  if (req.method === "POST" && !(Number(req.headers.get("content-length")) <= 256 * 1024)) return new Response("Too large", { status: 413 });
  try {
    if (path === "/stripe/webhook") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      const event = await verify(await req.text(), req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? "");
      if (!event) return new Response("bad signature", { status: 400 });
      const paid = paidLeague(event);
      if (paid) await activate(env, paid.leagueId, paid.session); // a throw here returns 500, and Stripe retries
      return new Response("ok");
    }
    const m = path.match(/^\/([a-z0-9-]{1,64})(?:\/(feed|edit)|\/(\d{4})\/(\d{1,2}))?\/?$/);
    if (m?.[2] === "edit") return await editor(req, env.DB, site, SHELL, m[1]!); // the one form that POSTs
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
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /go\nDisallow: /paid\nDisallow: /stripe/\nDisallow: /*/edit\n");
    if (path === "/terms") return html(termsPage(SHELL, site), 200, 3600);
    if (path === "/health") { // for a monitor: 503 when anything failed, shipped without jokes or got stuck lately, or a payment needs a refund
      const h = await env.DB.prepare(`SELECT
          COUNT(CASE WHEN status = 'failed' AND updated_at > datetime('now', '-1 day') THEN 1 END) AS failed,
          COUNT(CASE WHEN status = 'done' AND kind = 'weekly' AND updated_at > datetime('now', '-1 day') AND json_extract(doc, '$.copy.by') = 'template' THEN 1 END) AS plain,
          COUNT(CASE WHEN status = 'pending' AND updated_at < datetime('now', '-6 hours') THEN 1 END) AS stuck,
          (SELECT COUNT(*) FROM cache WHERE key LIKE 'refund:%') AS refunds
        FROM recaps WHERE kind != 'preview'`).first<{ failed: number; plain: number; stuck: number; refunds: number }>();
      const ok = !h!.failed && !h!.plain && !h!.stuck && !h!.refunds;
      return Response.json({ ok, ...h }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
    }
    if (path === "/paid") { // Stripe's Payment Link sends buyers here with ?session={CHECKOUT_SESSION_ID}, which only they know
      const session = url.searchParams.get("session") ?? ""; // only a checkout ID: paid_via also holds 'comp' and 'showcase'
      const row = /^cs_(live|test)_[A-Za-z0-9]+$/.test(session) ? await env.DB.prepare("SELECT slug, name, edit_key FROM leagues WHERE paid_via = ? AND edit_key IS NOT NULL")
        .bind(session).first<{ slug: string; name: string; edit_key: string }>() : null;
      if (row) return html(paidPage(SHELL, site, row), 200, 0, true);
      if (await env.DB.prepare("SELECT 1 FROM cache WHERE key = ?").bind(`refund:${session}`).first()) {
        return html(messagePage(SHELL, site, "We'll refund this one", `This payment couldn't turn a league on: the league already has a season pass, or the checkout didn't say which league it was for. We'll refund it in full within a few days. Questions: support@${new URL(env.ORIGIN).hostname}.`), 200, 0, true);
      }
      return html(messagePage(SHELL, site, "Payment received", "Setting up your league now. This page checks again in a few seconds.")
        .replace("</head>", '<meta http-equiv="refresh" content="4"></head>'), 200, 0); // the webhook can trail the redirect by a moment
    }
    if (!m) return html(messagePage(SHELL, site, "Page not found", "Nothing lives at that address."), 404);
    return await leaguePage(env, site, m[1]!, m[3], m[4] ? Number(m[4]) : undefined, m[2] === "feed");
  } catch (err) {
    console.error(err);
    return html(messagePage(SHELL, site, "Fumble", "Something broke on our end. Try again in a minute."), 500, 0);
  }
}
