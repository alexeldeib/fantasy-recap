// The hosted version's own logic: webhook signatures and what's due when.
import assert from "node:assert/strict";
import { test } from "node:test";
import { due } from "../src/schedule.ts";
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
  assert.equal(paidLeague({ ...event, data: { object: { ...event.data.object, client_reference_id: "x; drop table" } } }), null);
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
