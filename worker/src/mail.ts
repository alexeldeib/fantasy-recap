// links@<site>, the editor-link mailbox: a commissioner who lost their private editor link emails it from the address they
// paid with and gets their league's links back. Cloudflare lets an Email Worker reply only to the actual sender, and only
// when the email passes DMARC (the sender really controls that address), so nobody can get someone else's link sent to
// themselves. The address itself is never stored: a fingerprint of it is, at checkout.

/** A fingerprint of an email address: SHA-256 of it, trimmed and lowercased. */
export async function fingerprint(email: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The address in a From header: `Pat <pat@example.com>` -> pat@example.com. */
export const address = (from: string): string => (from.match(/<([^<>]+)>/)?.[1] ?? from).trim().toLowerCase();

/** Mail nobody should answer automatically (RFC 3834): auto-replies, bounces and lists. Two robots can't email each other forever. */
export const automatic = (h: Headers): boolean => (h.get("auto-submitted") ?? "no").trim().toLowerCase() !== "no"
  || /bulk|list|junk|auto_reply/i.test(h.get("precedence") ?? "") || h.has("list-id");

/** A plain-text reply, threaded under the email it answers and marked automatic so auto-responders stay quiet. */
export function replyMime(from: string, to: string, inReplyTo: string | null, body: string): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim(); // nothing from the incoming email can add a header
  return [`From: The Bench Press <${clean(from)}>`, `To: ${clean(to)}`, "Subject: Your Bench Press links",
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${clean(from).split("@")[1]}>`,
    ...(inReplyTo ? [`In-Reply-To: ${clean(inReplyTo)}`, `References: ${clean(inReplyTo)}`] : []),
    "Auto-Submitted: auto-replied", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
    "", body].join("\r\n").replace(/\r?\n/g, "\r\n");
}

/** What a reply says: the league's links, or how to reach a person. */
export function replyBody(site: string, leagues: { slug: string; name: string; season: string; edit_key: string }[]): string {
  const host = new URL(site).hostname;
  if (!leagues.length) {
    return `We couldn't find a pass for this season bought with this address.\n\nWrite from the email you used at checkout, or reach a person at support@${host} with your league's link.\n\nThe Bench Press`;
  }
  return "Here are your links.\n\n" + leagues.map((l) => `${l.name} (${l.season})\n  League page: ${site}/${l.slug}/\n`
    + `  Your private editor link: ${site}/${l.slug}/edit?key=${l.edit_key}`).join("\n\n")
    + "\n\nKeep the editor link to yourself: anyone with it can edit your league's pages.\n\nThe Bench Press";
}
