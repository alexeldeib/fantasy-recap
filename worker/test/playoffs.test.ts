// Playoffs: brackets name each game, a two-week final is only led after its first leg, and the two-week total decides it.
// Double Dipper's real weeks 2-4, replayed as a bracket: week 2's first two games are the semifinals, the winners meet in
// a final over weeks 3 and 4, and the losers play for third. Roster 5 leads the final by 29.30 after week 3; roster 8
// wins week 4 by 43.90 and takes the title.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build, type J } from "../src/facts.ts";
import { buildDay } from "../src/live.ts";
import { dayPage } from "../src/pages.ts";
import { page } from "../src/render.ts";
import { replay } from "./replay.ts";

const SHELL = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
const SITE = { brand: "Test", origin: "https://example.com", price: "$1", payLink: "" };
const ROUNDS: Record<number, number[][]> = { 2: [[5, 10], [8, 2]], 3: [[5, 8], [10, 2]], 4: [[5, 8], [10, 2]] };

/** Recorded weeks as the bracket above. Teams without a game get no matchup ID, as eliminated teams do on Sleeper. */
function bracket(data: J): J {
  const d = structuredClone(data);
  d["league:"].settings = { ...d["league:"].settings, playoff_week_start: 2, playoff_round_type: 1, playoff_teams: 4 };
  for (const [w, games] of Object.entries(ROUNDS)) {
    for (const m of d[`matchups:${w}`] ?? []) m.matchup_id = games.findIndex((g) => g.includes(m.roster_id)) + 1 || null;
  }
  d["brackets:"] = [[
    { r: 1, m: 1, t1: 5, t2: 10, w: 5, l: 10 }, { r: 1, m: 2, t1: 8, t2: 2, w: 8, l: 2 },
    { r: 2, m: 3, t1: 5, t2: 8, p: 1, t1_from: { w: 1 }, t2_from: { w: 2 } },
    { r: 2, m: 4, t1: 10, t2: 2, p: 3, t1_from: { l: 1 }, t2_from: { l: 2 } },
  ], []];
  return d;
}
const week = (w: number) => build(replay(bracket(replay("dd-week4.json").data)), w);
const awards = (f: J) => f.awards.map((a: J) => a.key);
const html = (f: J) => page(SHELL, f, {}, `https://example.com/2026/${f.week}/`, [], "https://example.com/");

test("a one-week round: named games and every results trophy", async () => {
  const f = await week(2);
  assert.deepEqual(f.games.map((x: J) => x.stage), [{ name: "Semifinal" }, { name: "Semifinal" }]);
  for (const k of ["blowout", "close", "lucky", "unlucky"]) assert.ok(awards(f).includes(k), k);
});

test("after a two-week final's first leg, the leader only leads", async () => {
  const f = await week(3);
  assert.deepEqual(f.games.map((x: J) => [x.stage.name, x.stage.leg]), [["Championship", 1], ["3rd-place game", 1]]);
  assert.deepEqual([f.games[0].win.pts, f.games[0].lose.pts, f.games[0].margin], [130.58, 101.28, 29.3]);
  for (const k of ["blowout", "close", "heartbreaker", "lucky", "unlucky"]) assert.ok(!awards(f).includes(k), `no ${k} trophy yet`);
  assert.equal(f.champion, undefined);
  assert.deepEqual(f.next.games[0].stage, { name: "Championship", leg: 2, legs: 2, a_leg1: 130.58, b_leg1: 101.28 }, "next week's preview carries leg 1");
  assert.match(html(f), /leads .*Championship · leg 1 of 2/s);
});

test("after the second leg, the two-week total crowns the champion", async () => {
  const f = await week(4);
  const final = f.games[0];
  assert.deepEqual([final.stage.name, final.stage.leg, final.stage.win_total, final.stage.lose_total, final.margin],
    ["Championship", 2, 238.1, 223.5, 14.6]);
  assert.equal(final.win.pts, 136.82, "the winner on the total also won the week");
  assert.equal(f.champion, final.win.team);
  const close = f.awards.find((a: J) => a.key === "close"), blow = f.awards.find((a: J) => a.key === "blowout");
  assert.match(close.stat, /^by 14\.60 over .* on aggregate$/);
  assert.match(blow.stat, /^by 128\.22 over .* on aggregate$/);
  assert.ok(!awards(f).includes("lucky") && !awards(f).includes("unlucky"), "luck is a one-week game's trophy");
  assert.match(html(f), /Two-week total: 238\.10 to 223\.50/);
});

test("a game day in the second leg: the total decides who's ahead", async () => {
  const live = { ...replay("sleeper-live-week4.json").data, "matchups:3": replay("dd-week4.json").data["matchups:3"] };
  const f = await buildDay(replay(bracket(live)), 4, "2026-10-04");
  const final = f.games.find((x: J) => x.stage?.name === "Championship");
  assert.equal(final.stage.leg, 2);
  assert.equal(final.stage.a_total, Math.round((130.58 + final.a.pts) * 100) / 100, "roster 5: leg 1 plus today");
  assert.equal(final.stage.b_total, Math.round((101.28 + final.b.pts) * 100) / 100);
  assert.equal(final.a.win_pct + final.b.win_pct, 100);
  assert.match(dayPage(SHELL, [{ facts: f, copy: {} }], SITE, "https://example.com/x/", "https://example.com/x/", [], ""),
    /Championship · leg 2 of 2.*Two-week total/s);
});
