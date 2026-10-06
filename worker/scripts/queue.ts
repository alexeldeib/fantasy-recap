// Write (or rewrite) one recap now, on production: claims its row, then starts its Workflow.
// Usage: node scripts/queue.ts <league id> <season> <week> <kind>      kind: weekly, or day-<date> like day-2026-10-04
// Works for any league, showcase or not; the cron only ever queues paid ones. Costs a Claude call or three.
import { execFileSync } from "node:child_process";

const [league, season, week, kind] = process.argv.slice(2);
if (!/^\d+$/.test(league ?? "") || !/^\d{4}$/.test(season ?? "") || !/^\d+$/.test(week ?? "") || !/^(weekly|day-\d{4}-\d{2}-\d{2})$/.test(kind ?? "")) {
  throw new Error("usage: node scripts/queue.ts <league id> <season> <week> <weekly|day-YYYY-MM-DD>");
}
const wrangler = (...args: string[]) => execFileSync("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "inherit"] }).toString();
wrangler("d1", "execute", "fantasy-recap", "--remote", "--command",
  `INSERT OR REPLACE INTO recaps (league_id, season, week, kind, status) VALUES ('${league}', '${season}', ${Number(week)}, '${kind}', 'pending')`);
const id = `${league}-${season}-${week}-${kind}-${Date.now()}`; // a fresh instance ID, so a rerun never collides with an old one
wrangler("workflows", "trigger", "recap", JSON.stringify({ league_id: league, season, week: Number(week), kind }), "--id", id);
console.log(`queued ${id}`);
