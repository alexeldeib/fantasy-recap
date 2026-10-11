// Sleeper's public API from the Worker: read-only, no key. What doesn't need asking twice is kept in D1 (kept()): the NFL
// player list for a day, as Sleeper asks; the NFL-wide stats, projections and schedule for minutes, so a burst of leagues
// asks once; and the cron's NFL state and schedule for as long as nothing can change (see schedule.ts scheduleAge).
import { type J, type Source, STATS } from "./facts.ts";

export const API = "https://api.sleeper.app/v1";
const PROJECTIONS = (season: string, week: number) => `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular`
  + "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF";
const SCHEDULE = (season: string) => `https://api.sleeper.com/schedule/nfl/regular/${season}`;

/** Fetch JSON. `fallback` stands in for data that isn't there: a 404, or the null Sleeper answers for an unknown league.
 *  Anything else that goes wrong (a 5xx, a 429, a timeout) throws, so a workflow step retries instead of mistaking an
 *  outage for "no games this week"; `soft` lets optional data fall back on those too. `ttl` (seconds) lets Cloudflare's
 *  cache answer repeats: the NFL-wide data every league in a burst asks for. */
export async function get(url: string, fallback?: J, ttl = 0, soft = false): Promise<J> {
  let body: J = null;
  try {
    const r = await fetch(url, { headers: { "user-agent": "fantasy-recap" }, // api.sleeper.com 403s requests without one
      ...(ttl && { cf: { cacheTtl: ttl, cacheEverything: true } }) });
    if (r.status !== 404) {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.json();
    }
  } catch (err) {
    if (soft && fallback !== undefined) return fallback;
    throw new Error(`Sleeper ${url.split("?")[0]}: ${err}`);
  }
  if (body !== null) return body;
  if (fallback === undefined) throw new Error(`Sleeper ${url.split("?")[0]}: not found`);
  return fallback;
}

const MINUTE = 60e3;

/** `fetch()`'s answer, kept in D1 under `key` for `maxAge` ms, or for as long as `maxAge(kept value)` says. An empty answer
 *  isn't kept, so one bad fetch can't blank a burst of leagues. */
export async function kept(db: D1Database, key: string, maxAge: number | ((value: J) => number), fetch: () => Promise<J>): Promise<J> {
  const row = await db.prepare("SELECT value, updated_at FROM cache WHERE key = ?").bind(key).first<{ value: string; updated_at: string }>();
  if (row) {
    const value = JSON.parse(row.value), age = Date.now() - Date.parse(`${row.updated_at.replace(" ", "T")}Z`);
    if (age < (typeof maxAge === "number" ? maxAge : maxAge(value))) return value;
  }
  const value = await fetch();
  if (value && Object.keys(value).length) {
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").bind(key, JSON.stringify(value)).run();
  }
  return value;
}

/** Only the stat lines the recaps print, for players who have any: a few percent of Sleeper's 1-2 MB. */
export const trimStats = (raw: J): J => Object.fromEntries(Object.entries<J>(raw ?? {}).flatMap(([pid, s]) => {
  const line = STATS.filter(([k]) => s?.[k]).map(([k]) => [k, s[k]]);
  return line.length ? [[pid, Object.fromEntries(line)]] : [];
}));
/** Only each player's projected points, in the three scorings. */
export const trimProjections = (raw: J[]): J[] => (raw ?? []).map((x: J) => ({ player_id: x.player_id,
  stats: Object.fromEntries(["pts_ppr", "pts_half_ppr", "pts_std"].filter((k) => x.stats?.[k] != null).map((k) => [k, x.stats[k]])) }));

/** The NFL schedule, kept in D1: for 10 minutes by default (a burst of recaps shares it), or as the cron says. */
export const nflSchedule = (db: D1Database, season: string, maxAge: number | ((s: J) => number) = 10 * MINUTE) =>
  kept(db, `schedule:${season}`, maxAge, () => get(SCHEDULE(season), []));

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
  // The NFL-wide data is the same for every league: kept 10 minutes, so a burst of recaps (2 seconds apart) asks once.
  // Stats, projections and transactions are extras: a recap can ship without them, so they fall back on errors too.
  const shared = (key: string, fetch: () => Promise<J>) => (db ? kept(db, key, 10 * MINUTE, fetch) : fetch());
  return {
    league: () => get(base), users: () => get(`${base}/users`), rosters: () => get(`${base}/rosters`),
    matchups: (week, fallback) => get(`${base}/matchups/${week}`, fallback), transactions: (week) => get(`${base}/transactions/${week}`, [], 0, true),
    stats: (season, week) => shared(`stats:${season}:${week}`, async () => trimStats(await get(`${API}/stats/nfl/regular/${season}/${week}`, {}, 0, true))),
    projections: (season, week) => shared(`projections:${season}:${week}`, async () => trimProjections(await get(PROJECTIONS(season, week), [], 0, true))),
    schedule: (season) => (db ? nflSchedule(db, season) : get(SCHEDULE(season), [])),
    players: () => players(db), brackets: () => Promise.all([get(`${base}/winners_bracket`, []), get(`${base}/losers_bracket`, [])]),
  };
}
