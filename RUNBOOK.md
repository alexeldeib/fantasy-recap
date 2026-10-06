# Runbook

Everything here runs from `worker/` against production, with your own logins: `npx wrangler login` for Cloudflare, and `stripe login` for refunds. The app itself holds no Stripe keys.

`node scripts/admin.ts <command> <league>` handles one league at a time. `<league>` can be any of its page URLs, its Sleeper link or league ID, or its slug. Anything that spends money or deletes data asks first.

## Support inbox

support@thebenchpress.app forwards to the owner's Gmail, through Cloudflare Email Routing (dashboard → Email Service → Email Routing). Replies go out from that Gmail address. To change where mail lands, edit the routing rule there.

## Refunds and cancellations

A customer wants their money back, or wants out:

```bash
node scripts/admin.ts refund <league>
```

It looks up the league's Stripe checkout, shows the amount and the buyer's email, and asks you to confirm. Then it refunds in full and turns the league off. A league that came in on a free-season code has nothing to refund; the command just turns it off. Reply to the customer from Gmail.

The policy on `/terms`:
- a full refund within 7 days of buying, no questions asked
- a full refund any time a problem on our end stops the recaps

**Partial refunds and disputes:** handle these in the Stripe dashboard (Payments → the payment). Then run `node scripts/admin.ts off <league>`.

**Turning a league off** stops its recaps, and its page goes back to the free preview. Its posts stay stored.

## Free seasons (comps)

```bash
node scripts/admin.ts comp <league>
```

This prints the league's page and its private editor link; send both to the commissioner. Recaps start with the next game day. To write the latest week right away, use `redo` (below). A comp carries over when Sleeper renews the league next season.

For giveaways at scale, make a 100%-off promotion code instead (Stripe dashboard → Product catalog → Coupons). The buyer checks out as usual and pays $0. One live code exists with 10 uses until Feb 15, 2027; its name is in the dashboard, deliberately not in this public repo.

## Fixing what a post says

**A leaked editor link:** run `npx wrangler d1 execute fantasy-recap --remote --command "UPDATE leagues SET edit_key = NULL WHERE slug = '<slug>'"`, then `node scripts/admin.ts link <league>` to make a new link. Send it to the commissioner.

**Change some lines:** use the league's editor. It's the same page the commissioner gets, so you can fix any line, the league's lore, or the writer's brief. Saved changes show within a minute.

```bash
node scripts/admin.ts link <league>
```

**Rewrite a post from scratch:** pass the post's URL. This rebuilds its facts from Sleeper's current numbers (so it also picks up stat corrections) and has Claude write it again.

```bash
node scripts/admin.ts redo https://thebenchpress.app/double-dipper/2026/4/
```

- For a game-day update, add its date: `.../2026/4/#2026-10-04`.
- The old post stays up until the rewrite lands. A weekly recap takes 5 to 15 minutes; a game day takes a minute or two.
- A rewrite replaces any hand edits, and costs a Claude call or three.
- If the rewrite fails, the old post stays up. Check `npx wrangler workflows instances describe recap <id>` for the error.

## Taking a league down

```bash
node scripts/admin.ts takedown <league>
```

This deletes every page and post, every season. If the league is paid, refund it first when that's owed. Anyone with its Sleeper league ID can still open a fresh free preview.

## The health check failed

The Health workflow checks `https://thebenchpress.app/health` every 6 hours, and GitHub emails you when a check fails. The JSON counts three kinds of problem over the last day:

- **`failed`:** a recap gave up. Usual causes:
  - Sleeper was down for more than two hours.
  - The facts step hit a bug.
- **`plain`:** a weekly recap shipped with plain labels, because Claude failed three times. Check status.anthropic.com.
- **`stuck`:** a recap has been pending for over 6 hours.
- **`refunds`:** a payment came in that couldn't turn a league on. Either the league already had a pass (two managers both paid), the checkout didn't name a league (someone used the bare Payment Link), or the ID wasn't a football league. The buyer's page already says a refund is coming. To list them and refund one (which also clears the flag):

```bash
npx wrangler d1 execute fantasy-recap --remote --command "SELECT key, value, updated_at FROM cache WHERE key LIKE 'refund:%'"
node scripts/admin.ts refund <cs_live_... from the key>
```

To find the problem:

```bash
npx wrangler d1 execute fantasy-recap --remote --command "SELECT l.slug, r.week, r.kind, r.status, r.updated_at FROM recaps r JOIN leagues l USING (league_id) WHERE r.status IN ('failed', 'pending') OR json_extract(r.doc, '$.copy.by') = 'template' ORDER BY r.updated_at DESC LIMIT 20"
npx wrangler workflows instances list recap
npx wrangler workflows instances describe recap <instance id>   # each step, its retries and its error
npx wrangler tail fantasy-recap                                   # live logs
```

Fix the cause, then `node scripts/admin.ts redo` each affected post. The check goes green once a full day passes with nothing failed and no refunds are waiting.

Sleeper outages fix themselves: a recap's facts step retries with backoff for about two hours before it fails.

## Paid, but the league isn't on

After checkout, the buyer's `/paid` page keeps checking until Stripe's webhook arrives. It usually takes a second or two. If it never arrives:

1. Open the Stripe dashboard → Developers → Webhooks → the `thebenchpress.app/stripe/webhook` endpoint, and look at the failed deliveries.
2. Act on the response code:
   - **400:** the signature doesn't match. `STRIPE_WEBHOOK_SECRET` isn't this endpoint's signing secret. Run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with it, then click **Resend** on the event.
   - **500:** our code threw. Watch `npx wrangler tail fantasy-recap` while you resend, and fix what it shows.
3. **Last resort:** turn the league on by hand. Record the checkout session ID so the refund command still works, write its first recap, and send the buyer the editor link.

```bash
npx wrangler d1 execute fantasy-recap --remote --command "UPDATE leagues SET paid_via = '<cs_live_... session id>' WHERE league_id = '<league id>'"
node scripts/admin.ts redo <league> <latest week>
node scripts/admin.ts link <league>
```

## Deploys, rollbacks, restores

- **Deploy:** push to `main`. CI runs the tests, applies new database migrations, then deploys.
- **Roll back a bad deploy:** `npx wrangler rollback` returns to the previous version. `npx wrangler versions list` shows the others. Code rolls back; database migrations don't.
- **Restore the database:** D1 Time Travel goes back up to 30 days, and everything written after that point is lost.

```bash
npx wrangler d1 time-travel info fantasy-recap --timestamp 2026-10-06T12:00:00Z
npx wrangler d1 time-travel restore fantasy-recap --timestamp 2026-10-06T12:00:00Z
```

## Secrets

Three secrets, none of them in the repo:

| Secret | Lives in | To rotate |
|---|---|---|
| `ANTHROPIC_API_KEY` | Cloudflare (`wrangler secret`) | Make a new key in the Anthropic console, `npx wrangler secret put ANTHROPIC_API_KEY`, then delete the old key. |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare | Stripe dashboard → the webhook endpoint → Roll secret, then `npx wrangler secret put STRIPE_WEBHOOK_SECRET`. |
| `CLOUDFLARE_API_TOKEN` | GitHub repo secret (CI deploys) | Cloudflare → My Profile → API Tokens → Roll, then `gh secret set CLOUDFLARE_API_TOKEN`. The token needs Workers and D1 edit on the account, and Workers Routes edit on thebenchpress.app only. |

Set a monthly spend limit on the Anthropic workspace that holds the API key. That caps the damage from a bug that queues too many recaps.

## Season rollover

- The cron stops writing once the NFL regular season ends, and starts again with Week 1.
- When Sleeper renews a league, it gets a new league ID:
  - **Comped leagues** carry over on their own: a daily check finds the renewed league.
  - **Paid leagues** need a new pass. Once anyone opens the renewed league, its page shows the preview and the buy button, at the same address.
- Before next season, make fresh free-season codes; the current ones expire Feb 15, 2027.

## Hardening (optional)

A Cloudflare rate-limiting rule (dashboard → thebenchpress.app → Security → WAF → Rate limiting rules) on `/go` and on paths that are only digits would stop anyone from using the site to hammer Sleeper with made-up league IDs. Something like 30 requests per minute per IP. Previews are already cached for 5 minutes per league, and unpaid leagues expire on their own.

## Costs

Every post records what its Claude calls cost:

```bash
npx wrangler d1 execute fantasy-recap --remote --command "SELECT r.kind = 'weekly' AS weekly, COUNT(*) AS posts, ROUND(SUM(json_extract(r.doc, '$.cost.usd')), 2) AS usd FROM recaps r WHERE r.status = 'done' AND r.updated_at > datetime('now', '-7 days') GROUP BY 1"
```

Expect about $12.50 per league per season, plus about $25 a season in news searches shared by every league.
