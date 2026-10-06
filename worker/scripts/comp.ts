// Turn a league on without a payment: your own leagues, friends, prizes. (For giveaways at scale, a 100%-off Stripe
// promotion code on the normal checkout does the same thing.) From then on the cron writes its recaps like any paid league's.
// Prints the league's private editor link too. A comp carries over when Sleeper renews the league.
// Usage: node scripts/comp.ts <Sleeper league link or ID> [--off]
import { execFileSync } from "node:child_process";

const ORIGIN = "https://thebenchpress.app";
const id = (process.argv[2] ?? "").match(/\d{6,24}/)?.[0];
if (!id) throw new Error("usage: node scripts/comp.ts <Sleeper league link or ID> [--off]");
const off = process.argv.includes("--off");
await fetch(`${ORIGIN}/${id}`, { redirect: "manual" }); // the site adds a league the first time anyone looks it up
const out = execFileSync("npx", ["wrangler", "d1", "execute", "fantasy-recap", "--remote", "--json", "--command",
  `UPDATE leagues SET paid_via = ${off ? "NULL" : "'comp'"}, edit_key = COALESCE(edit_key, lower(hex(randomblob(16))))
   WHERE league_id = '${id}' RETURNING slug, season, edit_key`], { stdio: ["ignore", "pipe", "inherit"] }).toString();
const row = JSON.parse(out)[0].results[0];
if (!row) throw new Error(`${id} isn't a Sleeper football league`);
console.log(`${off ? "un-comped" : "comped"} ${row.slug} (${row.season}): ${ORIGIN}/${row.slug}/`);
if (!off) console.log(`commissioner's editor (private): ${ORIGIN}/${row.slug}/edit?key=${row.edit_key}`);
