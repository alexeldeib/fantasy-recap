// Stripe webhooks, verified by hand (HMAC-SHA256 over "<timestamp>.<body>"): no SDK needed for one event type.

const enc = new TextEncoder();

/** The event, if `header` (Stripe-Signature: t=...,v1=...) signs `body` with `secret` within the last 5 minutes. */
export async function verify(body: string, header: string | null, secret: string, now = Date.now() / 1000): Promise<any | null> {
  if (!header || !secret) return null;
  const parts = header.split(",").map((kv) => kv.split("=", 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!t || Math.abs(now - t) > 300) return null; // a replayed old event fails here
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  for (const [k, v] of parts) {
    if (k !== "v1" || !/^[0-9a-f]{64}$/.test(v)) continue;
    const sig = new Uint8Array(v.match(/../g)!.map((h) => parseInt(h, 16)));
    if (await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${t}.${body}`))) return JSON.parse(body); // constant-time
  }
  return null;
}

/** The league a paid checkout is for: the Payment Link carries it as client_reference_id. A free-season promotion code
 *  makes a $0 checkout, which Stripe marks no_payment_required rather than paid. */
export function paidLeague(event: any): { leagueId: string; session: string } | null {
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event?.type)) return null;
  const s = event.data?.object ?? {};
  if (!["paid", "no_payment_required"].includes(s.payment_status) || !/^\d{6,24}$/.test(s.client_reference_id ?? "")) return null;
  return { leagueId: s.client_reference_id, session: s.id };
}
