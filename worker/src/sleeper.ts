// Sleeper's public API from the Worker: read-only, no key. The NFL player list is cached in D1, since Sleeper asks
// apps to fetch it at most once a day.
import type { J, Source } from "./facts.ts";

export const API = "https://api.sleeper.app/v1";
const PROJECTIONS = (season: string, week: number) => `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular`
  + "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF";
export const SCHEDULE = (season: string) => `https://api.sleeper.com/schedule/nfl/regular/${season}`;

/** Fetch JSON. Required endpoints throw; optional ones pass a fallback. Sleeper answers an unknown league with null. */
export async function get(url: string, fallback?: J): Promise<J> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "fantasy-recap" } }); // api.sleeper.com 403s requests without one
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (body === null && fallback === undefined) throw new Error("not found");
    return body ?? fallback;
  } catch (err) {
    if (fallback === undefined) throw new Error(`Sleeper ${url.split("?")[0]}: ${err}`);
    return fallback;
  }
}

const FIELDS = ["position", "fantasy_positions", "first_name", "last_name", "full_name", "team", "injury_status"];
const FANTASY = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"]);

/** The NFL player list, trimmed to the fields and positions the recaps use (about 1 MB, from Sleeper's 15). */
export async function players(db?: D1Database, refresh = false): Promise<J> {
  if (db && !refresh) {
    const row = await db.prepare("SELECT value FROM cache WHERE key = 'players'").first<{ value: string }>();
    if (row) return JSON.parse(row.value);
  }
  const slim: J = {};
  for (const [id, p] of Object.entries<J>(await get(`${API}/players/nfl`))) {
    if (!(p.fantasy_positions ?? [p.position]).some((x: string) => FANTASY.has(x))) continue;
    slim[id] = Object.fromEntries(FIELDS.filter((k) => p[k] != null).map((k) => [k, p[k]]));
  }
  await db?.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES ('players', ?, CURRENT_TIMESTAMP)").bind(JSON.stringify(slim)).run();
  return slim;
}

export function sleeper(leagueId: string, db?: D1Database): Source {
  const base = `${API}/league/${leagueId}`;
  return {
    league: () => get(base), users: () => get(`${base}/users`), rosters: () => get(`${base}/rosters`),
    matchups: (week, fallback) => get(`${base}/matchups/${week}`, fallback), transactions: (week) => get(`${base}/transactions/${week}`, []),
    stats: (season, week) => get(`${API}/stats/nfl/regular/${season}/${week}`, {}), projections: (season, week) => get(PROJECTIONS(season, week), []),
    schedule: (season) => get(SCHEDULE(season), []), players: () => players(db),
  };
}
