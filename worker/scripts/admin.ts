// Admin tasks for one league, run against production from worker/ (RUNBOOK.md, at the repo root, says when to use which).
// <league> is anything that names it: one of its thebenchpress.app page URLs, its Sleeper link or league ID, or its slug.
// It uses your own logins: wrangler (D1, Workflows) and, for refunds, the Stripe CLI. The app holds no Stripe keys.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const USAGE = `node scripts/admin.ts <command> <league>

  comp <league>      Turn it on for free (your leagues, friends, prizes). Prints its editor link.
  off <league>       Turn it off: no more recaps, and its page goes back to the free preview.
  refund <league>    Refund its Stripe payment in full, then turn it off. Asks first.
  refund <cs_...>    Refund one checkout that /health flagged (it couldn't turn a league on). Asks first.
  link <league>      Print its private editor link, for fixing any line by hand.
  redo <page URL>    Rewrite one post now (a Claude call or three). The old post stays up until the new one lands.
                     Or: redo <league> <week> [weekly | day-YYYY-MM-DD]. Asks first.
  takedown <league>  Delete its pages and posts, every season, for good. Asks first.`;

const ORIGIN = "https://thebenchpress.app";
const STRIPE_ACCOUNT = "acct_14UR4QGQzLQ7kipM"; // where the Payment Link lives (an ID, not a secret)

type League = { league_id: string; slug: string; name: string; season: string; paid_via: string | null; edit_key: string | null };
type Ref = { id?: string; slug?: string; season?: string; week?: string; day?: string };

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const sql = (query: string): any[] => JSON.parse(run("npx", ["wrangler", "d1", "execute", "fantasy-recap", "--remote", "--json", "--command", query]))[0].results;
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
async function ask(question: string) { // anything but y (including no input at all) leaves things as they are
  process.stdout.write(`${question} [y/N] `);
  const rl = createInterface({ input: process.stdin });
  const answer = await new Promise<string>((done) => { rl.once("line", done); rl.once("close", () => done("")); });
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error("left as is");
}

/** A page URL (which can also name a season, week and game day), a Sleeper link, a league ID, or a slug. */
function parse(arg: string): Ref {
  const url = URL.canParse(arg) ? new URL(arg) : null;
  if (url?.origin === ORIGIN) {
    const [slug, season, week] = url.pathname.split("/").filter(Boolean);
    return { slug, season, week, day: url.hash.slice(1) || undefined };
  }
  const id = url ? url.pathname.match(/\/leagues\/(\d{6,24})/)?.[1] : arg.match(/^\d{6,24}$/)?.[0];
  return id ? { id } : { slug: arg };
}

async function find(arg: string, add = false): Promise<League> {
  const { id, slug = "", season } = parse(arg);
  if (id && add) await fetch(`${ORIGIN}/${id}`, { redirect: "manual" }); // the site adds a league the first time anyone looks it up
  if (!id && !/^[a-z0-9-]{1,64}$/.test(slug)) throw new Error(`can't tell which league "${arg}" is\n\n${USAGE}`);
  const where = id ? `league_id = ${q(id)}` : `slug = ${q(slug)}${season && /^\d{4}$/.test(season) ? ` AND season = ${q(season)}` : ""}`;
  const row = sql(`SELECT league_id, slug, name, season, paid_via, edit_key FROM leagues WHERE ${where} ORDER BY season DESC LIMIT 1`)[0];
  if (!row) throw new Error(`no league "${arg}" on ${ORIGIN}${id ? " (is it a Sleeper football league?)" : ""}`);
  return row;
}

const home = (lg: League) => `${ORIGIN}/${lg.slug}/`;
const editor = (lg: League) => `${home(lg)}edit?key=${lg.edit_key
  ?? sql(`UPDATE leagues SET edit_key = COALESCE(edit_key, lower(hex(randomblob(16)))) WHERE league_id = ${q(lg.league_id)} RETURNING edit_key`)[0].edit_key}`;
const turnOff = (lg: League) => sql(`UPDATE leagues SET paid_via = NULL WHERE league_id = ${q(lg.league_id)}`);

const [command = "", arg = "", ...rest] = process.argv.slice(2);
try {
  if (command === "comp") {
    const lg = await find(arg, true);
    if (lg.paid_via && !["comp", "showcase"].includes(lg.paid_via)) throw new Error(`${lg.slug} is already paid for (${lg.paid_via})`);
    sql(`UPDATE leagues SET paid_via = 'comp' WHERE league_id = ${q(lg.league_id)}`);
    console.log(`comped ${lg.name} (${lg.season}): ${home(lg)}\neditor, private: ${editor(lg)}`);
    console.log(`Recaps start with the next game day. To write its latest week now: node scripts/admin.ts redo ${lg.slug} <week>`);
  } else if (command === "off") {
    const lg = await find(arg);
    turnOff(lg);
    console.log(`${lg.slug} is off (it was ${lg.paid_via ?? "off already"}). Its posts stay stored; takedown deletes them.`);
    if (lg.paid_via?.startsWith("cs_")) console.log(`It was bought in Stripe checkout ${lg.paid_via}: refund it in the dashboard if it's owed.`);
  } else if (command === "refund") {
    const lg = /^cs_(live|test)_\w+$/.test(arg) ? null : await find(arg), session = lg ? lg.paid_via ?? "" : arg;
    if (!/^cs_(live|test)_\w+$/.test(session)) throw new Error(`${lg?.slug} wasn't bought through Stripe (paid_via: ${lg?.paid_via})`);
    const live = session.startsWith("cs_live_");
    const stripe = (...args: string[]) => {
      const out = run("stripe", [...args, ...(live ? ["--live"] : [])]);
      return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); // past any banner lines
    };
    if (live) run("stripe", ["switch", "context", STRIPE_ACCOUNT, "--live"]);
    try {
      const s = stripe("checkout", "sessions", "retrieve", session);
      await ask(`${s.payment_intent ? `Refund $${(s.amount_total / 100).toFixed(2)} to ${s.customer_details?.email ?? "the buyer"}`
        : "Nothing was charged (a free-season code), so no refund"}${lg ? `, and turn off ${lg.name} (${lg.season})` : ""}?`);
      if (s.payment_intent) {
        const r = stripe("refunds", "create", "-d", `payment_intent=${s.payment_intent}`);
        console.log(`refund ${r.id}: ${r.status}`);
      }
    } finally {
      if (live) run("stripe", ["switch", "context", STRIPE_ACCOUNT]); // back to the sandbox, so nothing else runs live by accident
    }
    sql(`DELETE FROM cache WHERE key = ${q(`refund:${session}`)}`); // clears /health's flag, if it had one
    if (lg) {
      turnOff(lg);
      console.log(`${lg.slug} is off.`);
    }
  } else if (command === "link") {
    console.log(editor(await find(arg)));
  } else if (command === "redo") {
    const p = parse(arg), lg = await find(arg);
    const season = lg.season, week = p.week ?? rest[0] ?? "", kind = p.day ? `day-${p.day}` : rest[1] ?? "weekly";
    if (!(Number(week) >= 1 && Number(week) <= 18 && /^\d+$/.test(week)) || !/^(weekly|day-\d{4}-\d{2}-\d{2})$/.test(kind)) throw new Error(USAGE);
    await ask(`Rewrite ${lg.slug}'s week ${week} ${kind === "weekly" ? "recap" : kind}? It replaces the post, hand edits included.`);
    // The row has to exist for the Workflow to save into; an existing post stays up until the rewrite replaces it.
    sql(`INSERT OR IGNORE INTO recaps (league_id, season, week, kind, status) VALUES (${q(lg.league_id)}, ${q(season)}, ${Number(week)}, ${q(kind)}, 'pending')`);
    const id = `${lg.league_id}-${season}-${week}-${kind}-${Date.now()}`; // a fresh instance ID, so a rerun never collides with an earlier one
    run("npx", ["wrangler", "workflows", "trigger", "recap", JSON.stringify({ league_id: lg.league_id, season, week: Number(week), kind }), "--id", id]);
    console.log(`queued ${id}: watch it with npx wrangler workflows instances describe recap ${id}`);
  } else if (command === "takedown") {
    const lg = await find(arg);
    await ask(`Delete every page and post of ${lg.name} (/${lg.slug}), all seasons, for good?${lg.paid_via?.startsWith("cs_") ? " It's paid: refund it first if that's owed." : ""}`);
    sql(`DELETE FROM recaps WHERE league_id IN (SELECT league_id FROM leagues WHERE slug = ${q(lg.slug)})`);
    sql(`DELETE FROM leagues WHERE slug = ${q(lg.slug)}`);
    console.log(`deleted /${lg.slug}. Anyone with its Sleeper league ID can still open a fresh free preview.`);
  } else {
    throw new Error(USAGE);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
