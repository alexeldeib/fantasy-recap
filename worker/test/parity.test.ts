// The port must build the same facts and render the same page as the Python engine, from the same recorded week.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/facts.ts";
import { page } from "../src/render.ts";
import { replay } from "./replay.ts";

const VENV = fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));
const PY = process.env.PYTHON ?? (existsSync(VENV) ? VENV : "python3"); // the Python engine, as the reference
export const python = (fixture: string, week: number, copy: unknown = null, site = "https://example.com/") =>
  JSON.parse(execFileSync(PY, [fileURLToPath(new URL("./python.py", import.meta.url)), fixture, String(week), site],
    { input: JSON.stringify(copy), maxBuffer: 1 << 26 }).toString());
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

export const WEEKS: [string, number][] = [["../../../tests/fixtures/sleeper-week3.json", 3], ["dd-week2.json", 2], ["dd-week4.json", 4], ["ll-week1.json", 1], ["ll-week3.json", 3]];

for (const [fixture, week] of WEEKS) {
  test(`facts match the Python engine: ${fixture}`, async () => {
    const want = python(fixture, week).facts;
    const got = plain(await build(replay(fixture), week));
    for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], `facts.${k}`);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  });
}

// Every saved week of both live sites, jokes and all: the port must render the same bytes.
const SHELL = readFileSync(new URL("../../fantasy_recap/templates/page.html", import.meta.url), "utf8");
for (const [dir, site] of [["double-dipper", "https://double-dip.alexeldeib.xyz/"], ["la-liga", "https://liga.alexeldeib.xyz/"]]) {
  const root = fileURLToPath(new URL(`../../../${dir}`, import.meta.url));
  test(`pages match the Python engine: ${dir}`, { skip: !existsSync(`${root}/weeks`) && "site repo not checked out next to the engine" }, () => {
    const want = JSON.parse(execFileSync(PY, [fileURLToPath(new URL("./site.py", import.meta.url)), root, site], { maxBuffer: 1 << 26 }).toString());
    const data = readdirSync(`${root}/weeks`).sort().map((n) => JSON.parse(readFileSync(`${root}/weeks/${n}`, "utf8")));
    for (const d of data) {
      const key = `${d.facts.season}/${d.facts.week}`;
      const got = page(SHELL, d.facts, d.copy, `${site}${key}/`, data, site);
      if (got !== want[key]) {
        const i = [...got].findIndex((ch, j) => ch !== [...want[key]][j]);
        assert.fail(`${dir} ${key} differs at ${i}:\n  got  ${[...got].slice(i - 80, i + 80).join("")}\n  want ${[...want[key]].slice(i - 80, i + 80).join("")}`);
      }
    }
  });
}
