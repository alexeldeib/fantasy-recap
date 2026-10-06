// SQL that copies a GitHub-hosted site's saved weeks (weeks/*.json) into D1, so the hosted version shows the same recaps.
// Usage: node scripts/import-site.ts <site repo> <slug> [paid_via] > import.sql
//        npx wrangler d1 execute fantasy-recap --remote --file import.sql
// paid_via defaults to 'showcase': shown, never written (the GitHub site keeps writing it). Use 'comp' to hand it over.
import { readdirSync, readFileSync } from "node:fs";

const [dir, slug, paidVia = "showcase"] = process.argv.slice(2);
if (!dir || !slug) throw new Error("usage: node scripts/import-site.ts <site repo> <slug> [paid_via]");
const toml = readFileSync(`${dir}/league.toml`, "utf8");
const setting = (k: string) => toml.match(new RegExp(`^${k} = "(.*)"`, "m"))?.[1] ?? "";
const q = (s: unknown) => (s === null || s === undefined ? "NULL" : `'${String(s).replaceAll("'", "''")}'`);
const docs = readdirSync(`${dir}/weeks`).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(`${dir}/weeks/${n}`, "utf8")));
const id = setting("league_id"), first = docs[0].facts;
console.log(`INSERT OR REPLACE INTO leagues (league_id, slug, name, season, paid_via, intro) VALUES (${[id, slug, first.league, first.season, paidVia, setting("intro")].map(q).join(", ")});`);
for (const d of docs) {
  const { locked: _locked, ...doc } = d;
  console.log(`INSERT OR REPLACE INTO recaps (league_id, season, week, kind, status, headline, doc) VALUES (${[id, d.facts.season, d.facts.week].map(q).join(", ")}, 'weekly', 'done', ${q(d.copy.headline)}, ${q(JSON.stringify(doc))});`);
}
