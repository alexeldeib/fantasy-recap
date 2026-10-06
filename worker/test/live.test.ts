// Game-day facts from a real mid-week moment: Double Dipper, week 4, after Sunday's games (Monday night still to play).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDay } from "../src/live.ts";
import { replay } from "./replay.ts";

test("after Sunday: who's ahead, who's left for Monday, and the day's highlights", async () => {
  const f = await buildDay(replay("sleeper-live-week4.json"), 4, "2026-10-04");
  assert.equal(f.day_name, "Sunday");
  assert.equal(f.next_day, "Monday");
  assert.equal(f.final, false);
  assert.equal(f.games.length, 5);
  for (const x of f.games) {
    assert.equal(x.a.win_pct + x.b.win_pct, 100, `game ${x.key} odds`);
    for (const s of [x.a, x.b]) for (const p of s.still_to_play) assert.equal(p.when, "Monday");
  }
  assert.ok(f.games.some((x: any) => x.a.left + x.b.left > 0), "someone plays on Monday night");
  assert.equal(f.stars.length, 3);
  // Recorded just after Monday night kicked off: Sleeper's totals already had a few live Monday points, which an
  // "after Sunday" update leaves out. Ours plus those must equal Sleeper's.
  const data = replay("sleeper-live-week4.json").data;
  const monday = new Set(data["schedule:2026"].filter((x: any) => x.week === 4 && x.date === "2026-10-05").flatMap((x: any) => [x.home, x.away]));
  const want = data["matchups:4"].map((m: any) => m.points - m.starters.filter((p: string) => monday.has(data["players:"][p]?.team))
    .reduce((n: number, p: string) => n + (m.players_points[p] ?? 0), 0)).map((x: number) => Math.round(x * 100) / 100).sort((a: number, b: number) => a - b);
  const ours = f.games.flatMap((x: any) => [x.a.pts, x.b.pts]).sort((a: number, b: number) => a - b);
  assert.deepEqual(ours, want, "points as they stood after Sunday");
  assert.ok(f.stars[0].pts >= f.stars[1].pts);
  console.log(JSON.stringify({ games: f.games.map((x: any) => `${x.a.team} ${x.a.pts} (${x.a.left} left, ${x.a.win_pct}%) vs ${x.b.team} ${x.b.pts} (${x.b.left} left, ${x.b.win_pct}%)`),
    stars: f.stars.map((s: any) => `${s.player} ${s.pts} ${s.team}`), duds: f.duds.map((s: any) => `${s.player} ${s.pts}/${s.proj}`),
    blunders: f.bench_blunders }, null, 1));
});

test("after Monday: every matchup is final", async () => {
  const f = await buildDay(replay("sleeper-live-week4.json"), 4, "2026-10-05");
  assert.equal(f.day_name, "Monday");
  assert.equal(f.next_day, null);
  assert.equal(f.final, true);
});

test("a backfilled Thursday update counts only Thursday's game", async () => {
  const thu = await buildDay(replay("sleeper-live-week4.json"), 4, "2026-10-01");
  const sun = await buildDay(replay("sleeper-live-week4.json"), 4, "2026-10-04");
  assert.equal(thu.next_day, "Sunday");
  const total = (f: any) => f.games.reduce((n: number, x: any) => n + x.a.pts + x.b.pts, 0);
  const left = (f: any) => f.games.reduce((n: number, x: any) => n + x.a.left + x.b.left, 0);
  assert.ok(total(thu) < total(sun) / 4, `Thursday ${total(thu)} vs Sunday ${total(sun)}`);
  assert.ok(left(thu) > left(sun) * 5, "nearly everyone was still to play after Thursday");
  for (const s of thu.stars) assert.ok(thu.games.some((x: any) => [...x.a.played_today, ...x.b.played_today].some((p: any) => p.player === s.player)));
});
