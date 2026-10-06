// Game-day facts: where every matchup stands after one NFL game day (Thursday, Sunday, Monday...), for the quick
// updates between weekly recaps. Same source as the weekly facts; Sleeper's matchup points are live mid-week.
import { type J, pairs, pointsKey, roster, type Source, stager } from "./facts.ts";
import { fsum, maxBy, pyround, sortBy } from "./py.ts";

export const weekday = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error under 2e-7). */
function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + Math.sign(x) * erf);
}

/** `day` is the game date as Sleeper's schedule writes it (US Eastern), e.g. "2026-10-04". */
export async function buildDay(sl: Source, week: number, day: string): Promise<J> {
  const [lg, users, rosters, P] = await Promise.all([sl.league(), sl.users(), sl.rosters(), sl.players()]);
  const season: string = lg.season, pts_key = pointsKey(lg);
  const { teams, team, slots, info, fits, name } = roster(lg, users, rosters, P);
  const playoffs = week >= (lg.settings.playoff_week_start || 99);
  const [matchups, projections, schedule, stats, brackets, before] = await Promise.all([sl.matchups(week), sl.projections(season, week),
    sl.schedule(season), sl.stats(season, week), playoffs ? sl.brackets() : [[], []] as [J[], J[]], playoffs ? sl.matchups(week - 1, []) : []]);
  const stage = stager(lg.settings, brackets);
  const proj = new Map<string, number>(projections.map((x: J) => [x.player_id, (x.stats || {})[pts_key] || 0]));
  const games: J[] = schedule.filter((x: J) => x.week === week);
  const dates = [...new Set(games.map((x) => x.date as string))].sort();
  const nfl = new Map<string, J>(games.flatMap((x) => [[x.home, x], [x.away, x]]));
  // As of the end of `day`: done (played earlier this week), today, later (still to play then, even if it's over by
  // now: a late or backfilled update tells the story as it stood), or bye (no game, or no team).
  const status = (pid: string) => {
    const x = nfl.get(info(pid).team);
    if (!x) return "bye";
    if (x.date > day || x.status !== "complete") return "later";
    return x.date === day ? "today" : "done";
  };
  const line = (pid: string) => {
    const s = stats[pid] || {};
    return [["pass_yd", "pass yds"], ["pass_td", "pass TD"], ["pass_int", "INT"], ["rush_yd", "rush yds"], ["rush_td", "rush TD"],
      ["rec", "rec"], ["rec_yd", "rec yds"], ["rec_td", "rec TD"], ["fum_lost", "fumbles lost"]]
      .filter(([k]) => s[k!]).map(([k, label]) => `${s[k!]} ${label}`).join(", ");
  };
  const full = (pid: string): string => info(pid).full_name || name(pid);
  const sigma = (pids: string[]) => fsum(pids.map((p) => (0.5 * (proj.get(p) ?? 0) + 2) ** 2)); // ponytail: a player's spread ~ half his projection

  const ms = matchups.filter((m: J) => m.matchup_id);
  const side = (m: J) => {
    const st: string[] = m.starters.filter((p: string) => p !== "0");
    const later = st.filter((p) => status(p) === "later");
    const pts = fsum(st.filter((p) => status(p) !== "later").map((p) => m.players_points[p] ?? 0));
    const projLeft = pyround(fsum(later.map((p) => proj.get(p) ?? 0)), 1);
    return {
      team: team.get(m.roster_id), pts: pyround(pts, 2), left: later.length, proj_left: projLeft,
      proj_final: pyround(pts + projLeft, 1),
      still_to_play: later.map((p) => ({ player: full(p), nfl: info(p).team, when: weekday(nfl.get(info(p).team).date), proj: proj.get(p) ?? null })),
      played_today: sortBy(st.filter((p) => status(p) === "today"), (p) => -(m.players_points[p] ?? 0))
        .map((p) => ({ player: full(p), pts: m.players_points[p] ?? 0, proj: proj.get(p) ?? null, line: line(p) })),
      _later: later,
    };
  };
  const out = pairs(ms).map(([ma, mb], i) => {
    const a = side(ma), b = side(mb), st = stage(week, ma.roster_id, mb.roster_id);
    const leg1 = (m: J): number => (st?.leg === 2 ? before.find((x: J) => x.roster_id === m.roster_id)?.points ?? 0 : 0); // two-week rounds count both
    const ta = leg1(ma) + a.pts, tb = leg1(mb) + b.pts;
    const spread = Math.sqrt(sigma(a._later) + sigma(b._later));
    const pa = spread ? phi((leg1(ma) + a.proj_final - (leg1(mb) + b.proj_final)) / spread) : ta > tb ? 1 : ta < tb ? 0 : 0.5;
    const pct = (p: number) => (spread ? Math.min(99, Math.max(1, Math.round(100 * p))) : Math.round(100 * p));
    const { _later: _a, ...sa } = a, { _later: _b, ...sb } = b;
    const x: J = { key: String(i + 1), final: !a.left && !b.left, margin: pyround(Math.abs(ta - tb), 2),
      a: { ...sa, win_pct: pct(pa) }, b: { ...sb, win_pct: pct(1 - pa) } };
    if (st) x.stage = st.leg === 2 ? { ...st, a_total: pyround(ta, 2), b_total: pyround(tb, 2) } : st;
    return x;
  });

  // The day across the league: who carried, who flopped, and which benches hurt.
  const started: J[] = ms.flatMap((m: J) => m.starters.filter((p: string) => p !== "0" && status(p) === "today")
    .map((p: string) => ({ player: full(p), team: team.get(m.roster_id), pts: m.players_points[p] ?? 0, proj: proj.get(p) ?? null, line: line(p) })));
  const stars = sortBy(started, (x) => -x.pts).slice(0, 3);
  const duds = sortBy(started.filter((x) => x.proj), (x) => x.pts - x.proj).slice(0, 3).filter((x) => x.pts < x.proj);
  const blunders: J[] = ms.flatMap((m: J) => m.players.filter((b: string) => !m.starters.includes(b) && status(b) === "today").flatMap((b: string) => {
    const bp = m.players_points[b] ?? 0;
    const sat = maxBy(slots.map((slot, i) => [m.starters[i], slot] as [string, string])
      .filter(([s, slot]) => s && s !== "0" && fits(b, slot) && ["done", "today"].includes(status(s))), ([s]) => bp - (m.players_points[s] ?? 0));
    if (!sat) return [];
    const sp = m.players_points[sat[0]] ?? 0;
    return bp - sp > 5 ? [{ team: team.get(m.roster_id), bench: full(b), bench_pts: bp, started: full(sat[0]), started_pts: sp, gain: pyround(bp - sp, 2) }] : [];
  }));
  const later = dates.filter((d) => d > day);
  return {
    league: lg.name, season, week, day, day_name: weekday(day), final: !later.length || out.every((x) => x.final),
    next_day: later.length ? weekday(later[0]!) : null, teams,
    scoring: ({ pts_ppr: "full-PPR", pts_half_ppr: "half-PPR" } as Record<string, string>)[pts_key] ?? "standard",
    games: out, stars, duds, bench_blunders: sortBy(blunders, (x) => -x.gain).slice(0, 3),
  };
}

/** Whether a game day earns this league a quick hit. Skipping is free; posting is a Claude call (about $0.10). */
export function worthPosting(f: J): boolean {
  // Default: post when at least one of the league's starters played that day, so a Thursday game nobody started stays quiet.
  return f.stars.length > 0;
}
