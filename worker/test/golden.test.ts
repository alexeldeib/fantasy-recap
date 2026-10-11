// Recorded weeks (both leagues, real copy where the GitHub-era sites ran it) must build the same facts and render the
// same page as they did when the engine was Python. The golden files are that engine's last output; never regenerate
// them to make a change pass. A change that should alter old weeks' facts or pages is the rare exception.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "../src/facts.ts";
import { page } from "../src/render.ts";
import { buildDay } from "../src/live.ts";
import { trimProjections, trimStats } from "../src/sleeper.ts";
import { replay } from "./replay.ts";

const SHELL = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

for (const name of ["dd-week2", "dd-week3", "dd-week4", "ll-week1", "ll-week3"]) {
  test(`same facts and page as ever: ${name}`, async () => {
    const want = JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), "utf8"));
    const f = plain(await build(replay(`${name}.json`), want.facts.week));
    for (const k of Object.keys(want.facts)) assert.deepEqual(f[k], want.facts[k], `facts.${k}`);
    assert.deepEqual(Object.keys(f).sort(), Object.keys(want.facts).sort());
    const got = page(SHELL, f, want.copy, `https://example.com/${f.season}/${f.week}/`, [{ facts: f, copy: want.copy }], "https://example.com/");
    if (got !== want.page) {
      const i = [...got].findIndex((ch, j) => ch !== [...want.page][j]);
      assert.fail(`page differs at ${i}:\n  got  ${[...got].slice(i - 80, i + 80).join("")}\n  want ${[...want.page].slice(i - 80, i + 80).join("")}`);
    }
  });
}

test("best ball: no trophies about lineup calls, since Sleeper sets every lineup", async () => {
  const data = replay("dd-week4.json").data;
  const f = await build(replay({ ...data, "league:": { ...data["league:"], settings: { ...data["league:"].settings, best_ball: 1 } } }), 4);
  assert.equal(f.best_ball, true);
  const keys = f.awards.map((a: { key: string }) => a.key);
  for (const k of ["heartbreaker", "best_mgr", "worst_mgr", "best_bench", "bench_mvp"]) assert.ok(!keys.includes(k), k);
  assert.ok(keys.includes("high") && keys.includes("mvp"));
});

test("stats and projections trimmed for D1 build exactly the same facts", async () => {
  const trim = (data: any) => Object.fromEntries(Object.entries(data).map(([k, v]) =>
    [k, k.startsWith("stats:") ? trimStats(v) : k.startsWith("projections:") ? trimProjections(v as any[]) : v]));
  for (const name of ["dd-week2", "dd-week3", "dd-week4", "ll-week1", "ll-week3"]) {
    const data = replay(`${name}.json`).data, week = Number(name.slice(-1));
    assert.deepEqual(plain(await build(replay(trim(data)), week)), plain(await build(replay(data), week)), name);
  }
  const live = replay("sleeper-live-week4.json").data;
  assert.deepEqual(plain(await buildDay(replay(trim(live)), 4, "2026-10-04")), plain(await buildDay(replay(live), 4, "2026-10-04")), "a game day");
});

test("a recap's archived Sleeper inputs rebuild exactly the same facts", async () => {
  const { recorder } = await import("../src/sleeper.ts");
  for (const [name, run] of [
    ["dd-week4.json", (s: any) => build(s, 4)],
    ["sleeper-live-week4.json", (s: any) => buildDay(s, 4, "2026-10-04")],
  ] as const) {
    const rec = recorder(replay(name));
    const facts = plain(await run(rec.source));
    const snap = rec.snapshot();
    assert.deepEqual(plain(await run(replay(JSON.parse(JSON.stringify(snap))))), facts, name);
    assert.ok(Object.keys(snap["players:"]).length < Object.keys(replay(name).data["players:"]).length + 1, "only this league's players");
  }
});
