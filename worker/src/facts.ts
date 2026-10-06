// League data -> facts: games, trophies, gems, standings, power rankings. Ported line for line from the original Python
// engine; test/golden.test.ts checks recorded weeks still build exactly the facts that engine built.
import { first, fixed, fsum, g, maxBy, minBy, pyround, signed, sortBy } from "./py.ts";

export type J = any; // Sleeper's JSON, as it comes

/** Where build() gets a league's data: the live Sleeper API, or a recorded week in the tests. */
export interface Source {
  league(): Promise<J>;
  users(): Promise<J>;
  rosters(): Promise<J>;
  matchups(week: number, fallback?: J): Promise<J>;
  transactions(week: number): Promise<J>;
  players(): Promise<J>;
  stats(season: string, week: number): Promise<J>;
  projections(season: string, week: number): Promise<J>;
  schedule(season: string): Promise<J>;
  brackets(): Promise<[J[], J[]]>; // the playoffs' winners and losers brackets
}

export const FLEX: Record<string, Set<string>> = {
  FLEX: new Set(["RB", "WR", "TE"]), SUPER_FLEX: new Set(["QB", "RB", "WR", "TE"]),
  REC_FLEX: new Set(["WR", "TE"]), WRRB_FLEX: new Set(["WR", "RB"]),
};
export const HURT = new Set(["Out", "IR", "Doubtful", "Sus", "PUP", "NA"]);
/** Trophies about lineup calls. Best ball has none: Sleeper starts each team's best possible lineup itself. */
const LINEUP_CALLS = new Set(["heartbreaker", "best_mgr", "worst_mgr", "best_bench", "bench_mvp"]);
export const STATS: [string, string][] = [["pass_yd", "pass yds"], ["pass_td", "pass TD"], ["pass_int", "INT"],
  ["rush_yd", "rush yds"], ["rush_td", "rush TD"], ["rec", "rec"], ["rec_yd", "rec yds"], ["rec_td", "rec TD"],
  ["fum_lost", "fumbles lost"]];

export function pairs(matchups: J[]): J[][] {
  const games = new Map<number, J[]>();
  for (const m of matchups) if (m.matchup_id) games.set(m.matchup_id, [...(games.get(m.matchup_id) ?? []), m]);
  return [...games].sort((a, b) => a[0] - b[0]).map(([, g]) => g).filter((g) => g.length === 2);
}

export const ordinal = (n: number): string =>
  `${n}${10 <= n % 100 && n % 100 <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

/** Where a playoff pairing sits in Sleeper's brackets: { name }, plus { leg, legs: 2 } in a two-week round
 *  (playoff_round_type 1 makes the final round two weeks long, 2 makes every round). Null for any other game. */
export function stager(cfg: J, [winners, losers]: [J[], J[]]) {
  const start = Number(cfg.playoff_week_start) || 99, type = Number(cfg.playoff_round_type) || 0;
  const last = Math.max(0, ...winners.map((m: J) => m.r));
  const legs = (r: number) => (type === 2 || (type === 1 && r === last) ? 2 : 1);
  const opens = (r: number) => start + (type === 2 ? 2 * (r - 1) : r - 1);
  return (week: number, a: number, b: number): J => {
    for (const [consolation, ms] of [[false, winners], [true, losers]] as const) {
      const m = ms.find((m: J) => opens(m.r) <= week && week < opens(m.r) + legs(m.r) && [m.t1, m.t2].includes(a) && [m.t1, m.t2].includes(b));
      if (!m) continue;
      // ponytail: a losers bracket is a consolation ladder or a toilet bowl depending on settings, so no place names there
      const name = consolation ? (m.p === 1 ? "Consolation final" : "Consolation") : m.p === 1 ? "Championship"
        : m.p ? `${ordinal(m.p)}-place game` : m.r === last - 1 ? "Semifinal" : m.r === last - 2 ? "Quarterfinal" : `Playoff round ${m.r}`;
      return legs(m.r) === 2 ? { name, leg: week - opens(m.r) + 1, legs: 2 } : { name };
    }
    return null;
  };
}

export const zip = <A, B>(a: A[], b: B[]): [A, B][] => a.slice(0, b.length).map((x, i) => [x, b[i]!]);

/** str() of a Python float: 112.0 keeps its ".0". */
export const pyfloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const pointsKey = (lg: J): string => ({ 1: "pts_ppr", 0.5: "pts_half_ppr" } as Record<number, string>)[lg.scoring_settings.rec ?? 0] ?? "pts_std";

/** Who's who, shared by the weekly recap and the game-day updates. */
export function roster(lg: J, users: J[], rosters: J[], P: J) {
  const user = new Map(users.map((u: J) => [u.user_id, u]));
  const teams: J[] = [], team = new Map<number, string>();
  for (const r of sortBy(rosters, (r: J) => r.roster_id)) {
    const u = user.get(r.owner_id) ?? {};
    const manager = u.display_name || `team${r.roster_id}`;
    team.set(r.roster_id, (u.metadata ?? {}).team_name || manager);
    const avatar = (u.metadata ?? {}).avatar || (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : u.avatar ?? null);
    teams.push({ team: team.get(r.roster_id), manager, avatar, commish: Boolean(u.is_owner) });
  }
  const slots: string[] = lg.roster_positions.filter((s: string) => !["BN", "IR", "TAXI"].includes(s));
  const info = (pid: string): J => P[pid] ?? {};
  const fits = (pid: string, slot: string): boolean => {
    const p = info(pid);
    const pos: string[] = p.fantasy_positions?.length ? p.fantasy_positions : [p.position || "DEF"];
    const ok = FLEX[slot] ?? new Set([slot]);
    return pos.some((x) => ok.has(x));
  };
  const name = (pid: string): string => {
    const p = info(pid);
    if (pid === "0") return "an empty slot";
    if (p.position === "DEF" || !p.last_name) return `${pid} D/ST`;
    return `${first(p.first_name ?? "")}. ${p.last_name}`;
  };
  const optimal = (pp: Record<string, number>): number => {
    // ponytail: fill the pickiest slots first. Exact when slots nest (QB < FLEX < SUPER_FLEX);
    // overlapping flexes (REC_FLEX vs WRRB_FLEX) can come up a hair short.
    const left = new Map(Object.entries(pp));
    let total = 0.0;
    for (const slot of sortBy(slots, (s) => (FLEX[s] ?? new Set([s])).size)) {
      const best = maxBy([...left.keys()].filter((p) => fits(p, slot)), (p) => left.get(p)!);
      if (best !== undefined) {
        total += left.get(best)!;
        left.delete(best);
      }
    }
    return pyround(total, 2);
  };
  return { teams, team, slots, info, fits, name, optimal };
}

export async function build(sl: Source, weekArg?: number | string | null): Promise<J> {
  const [lg, users, rosters, P] = await Promise.all([sl.league(), sl.users(), sl.rosters(), sl.players()]);
  const season: string = lg.season, cfg = lg.settings;
  const week = Math.trunc(Number(weekArg || cfg.last_scored_leg || 0));
  if (week < 1) throw new Error("No scored weeks yet.");
  const pts_key = pointsKey(lg);
  const { teams, team, slots, info, fits, name, optimal } = roster(lg, users, rosters, P);

  // Season to date: record, all-play, bench points left.
  const weekly = new Map<number, J[]>(await Promise.all(
    Array.from({ length: week }, (_, i) => i + 1).map(async (w) => [w, await sl.matchups(w)] as [number, J[]])));
  const last_regular = Math.min(week, (cfg.playoff_week_start ?? 99) - 1);
  const rec = new Map<number, J>([...team.keys()].map((rid) =>
    [rid, { w: 0, l: 0, t: 0, hw: 0, h2h: 0, pf: 0.0, pa: 0.0, ap_w: 0, ap_l: 0, bench: 0.0, weeks: [] as number[] }]));
  const snaps = new Map<number, Map<number, [number, number]>>(); // week -> {rid: (all-play win rate, points for)} through that week
  for (let w = 1; w <= last_regular; w++) {
    const ms = weekly.get(w)!.filter((m: J) => m.matchup_id);
    const score = new Map<number, number>(ms.map((m: J) => [m.roster_id, m.points]));
    for (const m of ms) {
      const r = rec.get(m.roster_id), others = [...score].filter(([k]) => k !== m.roster_id).map(([, v]) => v);
      r.pf += m.points;
      r.weeks.push(m.points);
      r.bench += optimal(m.players_points) - m.points;
      r.ap_w += others.filter((v) => m.points > v).length;
      r.ap_l += others.filter((v) => m.points < v).length;
    }
    for (const [a, b] of pairs(ms)) {
      for (const [x, y] of [[a, b], [b, a]]) {
        const r = rec.get(x.roster_id);
        r.pa += y.points;
        r.h2h += 1;
        r.hw += Number(x.points > y.points);
        r[x.points > y.points ? "w" : x.points < y.points ? "l" : "t"] += 1;
      }
    }
    if (cfg.league_average_match) {
      const v = [...score.values()].sort((a, b) => a - b);
      const median = (v[Math.floor(v.length / 2) - 1]! + v[Math.floor(v.length / 2)]!) / 2;
      for (const [rid, p] of score) rec.get(rid)[p > median ? "w" : "l"] += 1;
    }
    snaps.set(w, new Map([...rec].map(([rid, r]) => [rid, [r.ap_w / Math.max(1, r.ap_w + r.ap_l), r.pf]])));
  }
  const standings = sortBy([...rec].map(([rid, r]) => {
    const ap = r.ap_w + r.ap_l;
    return {
      team: team.get(rid), w: r.w, l: r.l, t: r.t, pf: pyround(r.pf, 2), pa: pyround(r.pa, 2),
      all_play: `${r.ap_w}-${r.ap_l}`, bench_left: pyround(r.bench, 1),
      pa_per_game: r.h2h ? pyround(r.pa / r.h2h, 1) : 0,
      luck: pyround(r.hw - (ap ? r.ap_w / ap * r.h2h : 0), 2), weekly_scores: r.weeks,
    };
  }), (s) => [s.w + s.t / 2, s.pf], true);

  // This week, per team.
  const [stats, projections, transactions] = await Promise.all(
    [sl.stats(season, week), sl.projections(season, week), sl.transactions(week)]);
  const proj = new Map<string, number>(projections.map((x: J) => [x.player_id, (x.stats || {})[pts_key] || 0]));
  const line = (pid: string): string => {
    const s = stats[pid] || {};
    return STATS.filter(([k]) => s[k]).map(([k, label]) => `${g(s[k])} ${label}`).join(", ");
  };

  const ms: J[] = weekly.get(week)!.filter((m: J) => m.matchup_id);
  const stage = stager(cfg, week + 1 >= (cfg.playoff_week_start || 99) ? await sl.brackets() : [[], []]);
  const pointsIn = (w: number, rid: number): number => weekly.get(w)?.find((m: J) => m.roster_id === rid)?.points ?? 0;
  const card = new Map<number, J>(), lineups: Record<string, J> = {};
  for (const m of ms) {
    const rid = m.roster_id, pp = m.players_points, st: string[] = m.starters;
    const at = (p: string | null): number => (p === null ? 0 : pp[p] ?? 0);
    const bench: string[] = m.players.filter((p: string) => !st.includes(p));
    const opt = optimal(pp);
    const [gain, b, s] = maxBy(zip(st, slots).flatMap(([s, slot]) =>
      bench.filter((b) => fits(b, slot)).map((b) => [at(b) - at(s), b, s] as [number, string, string])), (x) => x)
      ?? [0, null, null];
    const top = maxBy(st.filter((p) => p !== "0"), at)!;
    card.set(rid, {
      team: team.get(rid), pts: m.points, opt, eff: opt ? pyround(100 * m.points / opt, 1) : 100.0,
      proj: proj.size ? pyround(fsum(st.map((p) => proj.get(p) ?? 0)), 1) : null,
      bench_pts: pyround(fsum(bench.map(at)), 2),
      top: { player: name(top), pts: at(top) },
      swap: gain > 0 ? { bench: name(b!), bench_pts: at(b), start: name(s!), start_pts: at(s), gain: pyround(gain, 2) } : null,
    });
    lineups[team.get(rid)!] = {
      started: zip(st, slots).filter(([p]) => p !== "0").map(([p, slot]) =>
        ({ slot, player: info(p).full_name || name(p), pts: at(p), proj: proj.get(p) ?? null, line: line(p) })),
      bench: bench.map((p) => ({ player: info(p).full_name || name(p), pos: info(p).position ?? null, pts: at(p), line: line(p) })),
    };
  }
  const games = pairs(ms).map(([a, b]) => {
    const st = stage(week, a.roster_id, b.roster_id);
    const total = (m: J) => m.points + (st?.leg === 2 ? pointsIn(week - 1, m.roster_id) : 0); // a second leg goes to the two-week total
    if (total(a) < total(b)) [a, b] = [b, a];
    const x: J = { win: card.get(a.roster_id), lose: card.get(b.roster_id), margin: pyround(total(a) - total(b), 2) };
    if (st) x.stage = st.leg === 2 ? { ...st, win_total: pyround(total(a), 2), lose_total: pyround(total(b), 2) } : st;
    return x;
  });

  // Trophies: the numbers are picked here; Claude only writes the jokes.
  const awards: J[] = [];
  const award = (key: string, emoji: string, label: string, who: string, stat: string, vs: J = null) =>
    awards.push({ key, emoji, label, team: who, stat, vs });
  const swapVs = (sw: J) => (sw ? { a: sw.bench, a_pts: sw.bench_pts, a_tag: "bench", b: sw.start, b_pts: sw.start_pts, b_tag: "started" } : sw ?? null);
  const vsProj = (t: J) => (t.proj ? ` (${signed(t.pts - t.proj, 1)} vs proj)` : "");

  const ranked = sortBy(card.values(), (t) => -t.pts);
  // A first leg decides nothing, and a two-week round's winner didn't win this week's game: they sit out the results trophies.
  const decided = games.filter((x) => x.stage?.leg !== 1), single = games.filter((x) => !x.stage?.leg);
  const agg = (x: J) => (x.stage?.leg ? " on aggregate" : "");
  const blow = maxBy(decided, (x) => x.margin), close = minBy(decided, (x) => x.margin);
  if (blow) award("blowout", "💣", "Biggest domination", blow.win.team, `by ${fixed(blow.margin, 2)} over ${blow.lose.team}${agg(blow)}`);
  award("high", "🥇", "Top score", ranked[0].team, `${fixed(ranked[0].pts, 2)}${vsProj(ranked[0])}`);
  award("low", "💩", "Biggest loser", ranked.at(-1).team, `${fixed(ranked.at(-1).pts, 2)}${vsProj(ranked.at(-1))}`);
  if (close) award("close", "🤏", "Closest game", close.win.team, `by ${fixed(close.margin, 2)} over ${close.lose.team}${agg(close)}`);
  const flips = decided.filter((x) => x.lose.swap && x.lose.swap.gain > x.margin).map((x) => [x.lose.swap.gain - x.margin, x] as [number, J]);
  if (flips.length) {
    const [by, x] = minBy(flips, (f) => f[0])!;
    award("heartbreaker", "💔", "Heartbreaker", x.lose.team,
      `lost by ${fixed(x.margin, 2)}${agg(x)}, one swap from winning by ${fixed(by, 2)}`, swapVs(x.lose.swap));
  }
  const best = maxBy(ranked, (t) => [t.eff, t.pts]), worst = minBy(ranked, (t) => [t.eff, t.pts]);
  award("best_mgr", "🔥", "Best manager", best.team, `${g(best.eff)}% of max (${fixed(best.opt, 2)})`);
  award("worst_mgr", "🤡", "Worst manager", worst.team, `${g(worst.eff)}% of max (${fixed(worst.opt, 2)})`, swapVs(worst.swap));
  const deep = maxBy(ranked, (t) => t.bench_pts);
  award("best_bench", "🪑", "Best bench", deep.team, `${fixed(deep.bench_pts, 2)} on the bench`);
  const starts: [number, string, number][] = ms.flatMap((m) =>
    m.starters.filter((p: string) => p !== "0").map((p: string) => [m.players_points[p] ?? 0, p, m.roster_id]));
  {
    const [pts, pid, rid] = maxBy(starts, (x) => x)!;
    award("mvp", "💪", "Best player", team.get(rid)!, `${name(pid)} ${fixed(pts, 2)}`);
  }
  const benched = maxBy(ms.flatMap((m) => m.players.filter((p: string) => !m.starters.includes(p))
    .map((p: string) => [m.players_points[p] ?? 0, p, m] as [number, string, J])), (x) => [x[0], x[1]]);
  if (benched) { // ponytail: Python raises on a week with no bench at all; this skips the trophy
    const [pts, pid, m] = benched;
    const sat = minBy(zip(m.starters as string[], slots).filter(([, slot]) => fits(pid, slot))
      .map(([s]) => [m.players_points[s] ?? 0, s] as [number, string]), (x) => x);
    award("bench_mvp", "🛋️", "Bench MVP", team.get(m.roster_id)!, `${name(pid)} ${fixed(pts, 2)}`,
      sat ? { a: name(pid), a_pts: pts, a_tag: "bench", b: name(sat[1]), b_pts: sat[0], b_tag: "started" } : null);
  }
  const diffs = starts.filter(([, pid]) => proj.get(pid)).map(([p, pid, rid]) => [p - proj.get(pid)!, p, pid, rid] as [number, number, string, number]);
  if (diffs.length) {
    let [d, p, pid, rid] = maxBy(diffs, (x) => x)!;
    award("over", "📈", "Overachiever", team.get(rid)!, `${name(pid)} ${fixed(p, 2)}, ${signed(d, 1)} vs proj`);
    [d, p, pid, rid] = minBy(diffs, (x) => x)!;
    award("under", "👎", "Underachiever", team.get(rid)!, `${name(pid)} ${fixed(p, 2)}, ${signed(d, 1)} vs proj`);
  }
  const lucky = minBy(single.map((x) => x.win), (t) => t.pts), unlucky = maxBy(single.map((x) => x.lose), (t) => t.pts);
  if (lucky) award("lucky", "🍀", "Lucky", lucky.team, `won with the ${ordinal(ranked.indexOf(lucky) + 1)}-best score`);
  if (unlucky) award("unlucky", "😡", "Unlucky", unlucky.team, `lost with the ${ordinal(ranked.indexOf(unlucky) + 1)}-best score`);

  // Gems: cross-roster comparisons a model won't reliably compute on its own.
  const gems: string[] = [];
  const scores = sortBy([...card.values()].map((t) => [t.pts, t.team] as [number, string]), (x) => x);
  const [low_pts, low_team] = scores[0]!;
  for (const t of card.values()) {
    const beaten = scores.filter(([p, n]) => p < t.bench_pts && n !== t.team).map(([, n]) => n);
    if (beaten.length) gems.push(`${t.team}'s bench (${fixed(t.bench_pts, 2)}) outscored these whole lineups: ${beaten.join(", ")}`);
    else if (t.team !== low_team && low_pts - t.bench_pts < 10) {
      gems.push(`${t.team}'s bench (${fixed(t.bench_pts, 2)}) finished ${fixed(low_pts - t.bench_pts, 2)} `
        + `behind ${low_team}'s whole lineup (${fixed(low_pts, 2)})`);
    }
  }
  const low_rid = [...card].find(([, t]) => t.team === low_team)![0];
  const low_starts = starts.filter(([, , rid]) => rid === low_rid).map(([p]) => p).sort((a, b) => a - b);
  for (const [pts, pid, rid] of sortBy(starts, (x) => x, true).slice(0, 3)) {
    let k = 0, total = 0.0;
    while (k < low_starts.length && total + low_starts[k]! < pts) {
      total += low_starts[k]!;
      k += 1;
    }
    if (k >= 2 && rid !== low_rid) {
      gems.push(`${name(pid)} (${fixed(pts, 2)}, ${team.get(rid)}) outscored ${low_team}'s ${k} lowest starters combined (${fixed(total, 2)})`);
    }
  }
  const game_of = new Map<string, number>(games.flatMap((x, i) => [[x.win.team, i], [x.lose.team, i]]));
  const near = minBy(scores.flatMap((a, i) => scores.slice(i + 1).filter((b) => game_of.get(a[1]) !== game_of.get(b[1]))
    .map((b) => [Math.abs(a[0] - b[0]), a, b] as [number, [number, string], [number, string]])), (x) => x);
  if (near) gems.push(`${near[1][1]} (${fixed(near[1][0], 2)}) and ${near[2][1]} (${fixed(near[2][0], 2)}) finished ${fixed(near[0], 2)} apart in different games`);
  for (const x of games) {
    if (x.win.proj && x.win.proj === x.lose.proj) {
      gems.push(`${x.win.team} and ${x.lose.team} were both projected for ${pyfloat(x.win.proj)}, then finished ${fixed(x.margin, 2)} apart`);
    }
  }
  const same_name = new Map<string, Map<string, [string, string, number]>>(); // a set of (pid, team, pts) per name
  for (const m of ms) {
    for (const p of m.players) {
      const v = [p, team.get(m.roster_id)!, m.players_points[p] ?? 0] as [string, string, number];
      same_name.set(name(p), (same_name.get(name(p)) ?? new Map()).set(JSON.stringify(v), v));
    }
    const words = new Set((team.get(m.roster_id)!.match(/[A-Za-z']{4,}/g) ?? []).map((w) => w.replace(/'s$/, "").toLowerCase()));
    for (const mm of ms) {
      for (const p of mm.players) {
        const pts = mm.players_points[p] ?? 0, started = mm.starters.includes(p);
        const notable = pts >= 20 || (started && pts <= 5) || (!started && pts >= 15); // only when the namesake did something
        if (notable && [(info(p).first_name ?? "").toLowerCase(), (info(p).last_name ?? "").toLowerCase()].some((x) => words.has(x))) {
          const how = mm.starters.includes(p) ? "started" : "benched";
          gems.push(`${team.get(m.roster_id)} shares a name with ${info(p).full_name ?? "None"}, who scored `
            + `${fixed(mm.players_points[p] ?? 0, 2)} (${how}) for ${team.get(mm.roster_id)}`);
        }
      }
    }
  }
  for (const [n, set] of same_name) {
    const v = [...set.values()];
    if (v.length > 1 && Math.max(...v.map(([, , pts]) => pts)) >= 20) {
      gems.push(`Two players named ${n}, on ` + v.map(([, t]) => t).sort().join(" and "));
    }
  }

  const pickups: J[] = [];
  for (const t of transactions) {
    if (t.status === "complete") {
      for (const [pid, rid] of Object.entries(t.adds || {}) as [string, number][]) {
        const m = ms.find((x) => x.roster_id === rid);
        pickups.push({ team: team.get(rid), player: name(pid), bid: (t.settings || {}).waiver_bid ?? null,
          pts: m ? m.players_points[pid] ?? 0 : 0, started: Boolean(m) && m.starters.includes(pid) });
      }
    }
  }
  const spend = maxBy(pickups.filter((x) => x.bid), (x) => x.bid);
  if (spend) award("big_spender", "💸", "Big spender", spend.team, `$${spend.bid} on ${spend.player}, ${fixed(spend.pts, 1)} pts`);

  // Next week: pairings, projections for the lineups as currently set, and lineup PSAs.
  let next: J = null;
  // Only the latest week gets a preview: lineups and injury tags are live data, wrong for past weeks. (>=, not ==: a
  // recap that runs before Sleeper marks the week scored is still the latest.)
  const latest = week >= Number(cfg.last_scored_leg || 0);
  const upcoming = latest ? (await sl.matchups(week + 1, [])).filter((m: J) => m.matchup_id) : [];
  if (upcoming.length) {
    const [nextProj, sched] = await Promise.all([sl.projections(season, week + 1), sl.schedule(season)]);
    const nproj = new Map<string, number>(nextProj.map((x: J) => [x.player_id, (x.stats || {})[pts_key] || 0]));
    const playing = new Set(sched.filter((x: J) => x.week === week + 1).flatMap((x: J) => [x.home, x.away]));
    const lineup = new Map<number, string[]>(rosters.map((r: J) => [r.roster_id, (r.starters || []).filter((p: string) => p !== "0")]));
    const projected = (rid: number) => (nproj.size ? pyround(fsum(lineup.get(rid)!.map((p) => nproj.get(p) ?? 0)), 1) : null);
    const out = new Set(upcoming.map((m: J) => m.roster_id)); // in the playoffs, only teams still playing
    const psa = [...lineup].filter(([rid]) => out.has(rid)).flatMap(([rid, st]) => st
      .filter((p) => HURT.has(info(p).injury_status) || (playing.size && !playing.has(info(p).team)))
      .map((p) => ({ team: team.get(rid), player: name(p), status: info(p).injury_status || "no game" })));
    next = { week: week + 1, psa, games: pairs(upcoming).map(([a, b]) => {
      const x: J = { a: team.get(a.roster_id), b: team.get(b.roster_id), a_proj: projected(a.roster_id), b_proj: projected(b.roster_id) };
      const st = stage(week + 1, a.roster_id, b.roster_id);
      if (st) x.stage = st.leg === 2 ? { ...st, a_leg1: pyround(pointsIn(week, a.roster_id), 2), b_leg1: pyround(pointsIn(week, b.roster_id), 2) } : st;
      return x;
    }) };
  }

  const final = games.find((x) => x.stage?.name === "Championship" && x.stage.leg !== 1);

  // Power rankings: season all-play win rate, then points for. Movement is vs the week before.
  const order = (w: number) => sortBy([...(snaps.get(w) ?? new Map()).keys()], (rid) => snaps.get(w)!.get(rid)!, true);
  const now = order(last_regular), before = order(last_regular - 1);
  const power = now.map((rid, i) => {
    const r = rec.get(rid);
    return {
      rank: i + 1, team: team.get(rid), prev: before.length ? before.indexOf(rid) + 1 : null,
      record: `${r.w}-${r.l}` + (r.t ? `-${r.t}` : ""), all_play: `${r.ap_w}-${r.ap_l}`, pf: pyround(r.pf, 2),
      this_week: card.has(rid) ? card.get(rid).pts : null,
    };
  });

  return {
    league: lg.name, season, week, playoff_teams: cfg.playoff_teams ?? null, teams,
    scoring: ({ pts_ppr: "full-PPR", pts_half_ppr: "half-PPR" } as Record<string, string>)[pts_key] ?? "standard",
    power, games, awards: cfg.best_ball ? awards.filter((a) => !LINEUP_CALLS.has(a.key)) : awards, gems, lineups, pickups, standings, next,
    ...(final && { champion: final.win.team }), ...(cfg.best_ball && { best_ball: true }),
  };
}
