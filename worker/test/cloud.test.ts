// The hosted version's own logic: webhook signatures and what's due when.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, fields } from "../src/editor.ts";
import { due } from "../src/schedule.ts";
import { get } from "../src/sleeper.ts";
import { paidLeague, verify } from "../src/stripe.ts";
import { replay } from "./replay.ts";

const SECRET = "whsec_test_only_" + "x".repeat(24); // a made-up test value, not a real Stripe secret
async function sign(body: string, t: number, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("webhook: a signed, fresh, paid checkout activates its league; anything else doesn't", async () => {
  const now = 1_790_000_000;
  const event = { type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", client_reference_id: "1393873211271188480" } } };
  const body = JSON.stringify(event);
  const ok = await verify(body, await sign(body, now), SECRET, now);
  assert.deepEqual(paidLeague(ok), { leagueId: "1393873211271188480", session: "cs_test_1" });
  assert.equal(await verify(body + " ", await sign(body, now), SECRET, now), null, "tampered body");
  assert.equal(await verify(body, await sign(body, now, "whsec_wrong"), SECRET, now), null, "wrong secret");
  assert.equal(await verify(body, await sign(body, now - 600), SECRET, now), null, "replayed after 10 minutes");
  assert.equal(await verify(body, null, SECRET, now), null, "unsigned");
  assert.equal(paidLeague({ ...event, data: { object: { ...event.data.object, payment_status: "unpaid" } } }), null);
  assert.deepEqual(paidLeague({ ...event, data: { object: { ...event.data.object, payment_status: "no_payment_required" } } }),
    { leagueId: "1393873211271188480", session: "cs_test_1" }, "a 100%-off promotion code");
  assert.deepEqual(paidLeague({ ...event, data: { object: { ...event.data.object, client_reference_id: "x; drop table" } } }),
    { leagueId: null, session: "cs_test_1" }, "no league to turn on: flagged for a refund, never injected");
  assert.equal(paidLeague({ type: "charge.refunded" }), null);
});

test("schedule: game-day updates as each day finishes, the recap Tuesday morning", async () => {
  const sched = await replay("sleeper-live-week4.json").schedule("2026"); // week 4: Thu and Sun final, Mon not played yet
  const at = (iso: string) => due(sched, Date.parse(iso)).filter((d) => d.week >= 3).map((d) => `${d.week}:${d.kind}`);
  assert.deepEqual(at("2026-10-02T05:00:00Z"), ["3:weekly", "4:day-2026-10-01"], "Friday: Thursday's update (and week 3's recap, for a league that just signed up)");
  assert.deepEqual(at("2026-10-06T00:30:00Z"), ["4:day-2026-10-04"], "Monday evening: Sunday's update; Thursday's has aged out");
  const done = sched.map((x: any) => (x.week === 4 ? { ...x, status: "complete" } : x)); // after Monday night
  const later = (iso: string) => due(done, Date.parse(iso)).filter((d) => d.week === 4).map((d) => d.kind);
  assert.deepEqual(later("2026-10-06T04:00:00Z"), ["day-2026-10-04", "day-2026-10-05"], "Monday night: Monday's update joins");
  assert.deepEqual(later("2026-10-06T13:00:00Z"), ["day-2026-10-04", "day-2026-10-05", "weekly"], "Tuesday 9am Eastern: the recap");
  assert.deepEqual(later("2026-10-12T00:00:00Z"), [], "a week later, nothing for week 4 is due anymore");
  // Monday night never finishes (postponed): no Monday update, and the recap waits a day instead of forever.
  const stuck = (iso: string) => due(sched, Date.parse(iso)).filter((d) => d.week === 4).map((d) => d.kind);
  assert.deepEqual(stuck("2026-10-06T13:00:00Z"), ["day-2026-10-04"], "Tuesday: no recap yet with a game unfinished");
  assert.deepEqual(stuck("2026-10-07T13:00:00Z"), ["weekly"], "Wednesday: the recap goes out anyway");
});

test("editor: a form changes only lines the copy already has", () => {
  const copy = { by: "claude-opus-5-5", headline: "OLD", dek: "d", pen_notes: ["SEE ME"], story: ["p1", "p2"],
    power_lines: [{ key: "Mr. T's Team", line: "y" }], award_lines: [{ key: "high", line: "x" }] };
  const form: [string, string][] = [["headline", " NEW \r\n"], ["story.1", "P2"], ["story.5", "added?"], ["award_lines.high", "X"],
    ["award_lines.low", "added?"], ["power_lines.Mr. T's Team", "Y"], ["by", "me"], ["news", "spam"], ["key", "the key"], ["__proto__.x", "1"]];
  assert.deepEqual(apply(copy, form), { ...copy, headline: "NEW", story: ["p1", "P2"],
    power_lines: [{ key: "Mr. T's Team", line: "Y" }], award_lines: [{ key: "high", line: "X" }] });
  assert.equal(copy.headline, "OLD", "the stored copy isn't touched until it's saved");
  assert.deepEqual(fields({ awards: [{ key: "high", label: "Top score" }] }, copy).map(([name, label]) => `${name}=${label}`),
    ["headline=Headline", "dek=Dek, the line under the headline", "pen_notes.0=Red marker note 1 (22 characters at most)",
      "story.0=Rundown, paragraph 1", "story.1=Rundown, paragraph 2", "power_lines.Mr. T's Team=Power rankings: Mr. T's Team", "award_lines.high=Trophy: Top score"]);
});

test("webhook: a paid checkout that names no league still comes back, so it can be flagged for a refund", () => {
  const s = { id: "cs_live_9", payment_status: "paid" };
  assert.deepEqual(paidLeague({ type: "checkout.session.completed", data: { object: s } }), { leagueId: null, session: "cs_live_9" });
  assert.deepEqual(paidLeague({ type: "checkout.session.completed", data: { object: { ...s, client_reference_id: "x; drop table" } } }),
    { leagueId: null, session: "cs_live_9" });
  assert.equal(paidLeague({ type: "checkout.session.completed", data: { object: { ...s, payment_status: "unpaid" } } }), null);
});

test("sleeper: an outage throws (so a step retries); only missing data falls back, and extras fall back on anything", async () => {
  const real = globalThis.fetch;
  const answer = (status: number, body: unknown) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status }); };
  try {
    answer(503, {});
    await assert.rejects(get("https://api.sleeper.app/v1/league/1/matchups/4", []), /HTTP 503/, "an outage is not 'no games'");
    assert.deepEqual(await get("https://api.sleeper.com/projections/nfl/2026/4", [], 0, true), [], "an extra can do without");
    answer(429, {});
    await assert.rejects(get("https://api.sleeper.app/v1/league/1/winners_bracket", []), /HTTP 429/);
    answer(404, {});
    assert.deepEqual(await get("https://api.sleeper.app/v1/league/1/matchups/19", []), []);
    answer(200, null);
    assert.equal(await get("https://api.sleeper.app/v1/league/1", null), null, "Sleeper's null for an unknown league");
    await assert.rejects(get("https://api.sleeper.app/v1/league/1"), /not found/);
    answer(200, [{ matchup_id: 1 }]);
    assert.deepEqual(await get("https://api.sleeper.app/v1/league/1/matchups/4", []), [{ matchup_id: 1 }]);
  } finally {
    globalThis.fetch = real;
  }
});

test("preview: a finished season's league gets no buy button", async () => {
  const { previewBanner } = await import("../src/pages.ts");
  const site = { brand: "B", origin: "https://example.com", price: "$25", payLink: "https://buy.stripe.com/x" };
  assert.match(previewBanner(site, { name: "L", status: "in_season" }, "123456"), /client_reference_id=123456/);
  assert.doesNotMatch(previewBanner(site, { name: "L", status: "complete" }, "123456"), /buy\.stripe\.com/);
});
