// Recorded weeks (both leagues, real copy where the GitHub-era sites ran it) must build the same facts and render the
// same page as they did when the engine was Python. The golden files are that engine's last output; never regenerate
// them to make a change pass. A change that should alter old weeks' facts or pages is the rare exception.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "../src/facts.ts";
import { page } from "../src/render.ts";
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
