// A recorded week of Sleeper responses, served through the same interface build() uses live.
import { readFileSync } from "node:fs";
import type { J, Source } from "../src/facts.ts";

export function replay(file: string): Source & { data: J } {
  const data = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
  const at = (key: string, fallback?: J) => {
    if (key in data) return Promise.resolve(data[key]);
    if (fallback !== undefined) return Promise.resolve(fallback);
    throw new Error(`fixture has no ${key}`);
  };
  return {
    data,
    league: () => at("league:"), users: () => at("users:"), rosters: () => at("rosters:"), players: () => at("players:"),
    matchups: (w, fallback) => at(`matchups:${w}`, fallback), transactions: (w) => at(`transactions:${w}`, []),
    stats: (s, w) => at(`stats:${s}:${w}`, {}), projections: (s, w) => at(`projections:${s}:${w}`, []),
    schedule: (s) => at(`schedule:${s}`, []),
  };
}
