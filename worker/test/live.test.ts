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
