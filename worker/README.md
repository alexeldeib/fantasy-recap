# The hosted version (working name: The Bench Press)

Any Sleeper league, one address: `https://<host>/<league>`. Paste a league link to see a free preview of your latest week, buy a season pass, and the recaps write themselves: the full recap every Tuesday morning, plus a quick hit after every NFL game day. No accounts, no apps; the league's page is the product.

Production: https://recaps.alexeldeib.xyz (a Workers custom domain; Cloudflare manages its DNS record and certificate), with Double Dipper and La Liga mirrored as examples. Payments run on Stripe test mode (the Ace Eldeib sandbox) until it's flipped to live.

## How it works

One Cloudflare Worker, one D1 database, one Workflow:

| Piece | Job |
|---|---|
| `fetch` (`src/index.ts`) | Pages: `/` (landing), `/<slug>` (latest week), `/<slug>/<season>/<week>`, `/go?league=` (finds a league from any Sleeper link), `/paid` (Stripe's return trip), `/stripe/webhook`. |
| `scheduled`, every 15 min | Refreshes the NFL player list once a day, then asks `due()` what's owed and queues it for every paid league. |
| `RecapWorkflow` | One recap: facts → web research → draft → punch-up → save. Each step retries on its own; a failure falls back a step, so the numbers always ship. |
| D1 (`schema.sql`) | `leagues` (one row per league per season, `paid_via` says whether it's on), `recaps` (every weekly recap, game-day update and preview), `cache` (player list, each game day's news). |

What's due comes from Sleeper's NFL schedule (`src/schedule.ts`): a game-day update once all of a day's games are final, and the weekly recap at 13:00 UTC the day after a week's last game. Thursday, Saturday, holiday and international games need no special cases. A recap's row is claimed before its Workflow starts, so each runs once no matter how often the cron fires.

The engine is the Python one, ported: `facts.ts`, `render.ts` and `writer.ts` mirror `fantasy_recap/`, and `npm test` checks they build the same facts and render byte-identical pages from recorded Sleeper data (both live sites, five league-weeks). The template and prompts are shared files, not copies.

## Set up

```bash
npm install
npx wrangler d1 create fantasy-recap        # put the database_id in wrangler.jsonc
npx wrangler d1 execute fantasy-recap --remote --file schema.sql
npx wrangler secret put ANTHROPIC_API_KEY  # without it: plain labels, no game-day updates
npx wrangler deploy
```

Payments are one Stripe Payment Link, no Stripe code beyond the webhook check:

1. In Stripe (test mode first), create a product "Season pass" with a one-time price, and a Payment Link for it. Under **After payment**, redirect to `https://<host>/paid?session={CHECKOUT_SESSION_ID}`.
2. Add a webhook endpoint `https://<host>/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`, then `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with its signing secret.
3. Put the Payment Link's URL in `PAYMENT_LINK` in `wrangler.jsonc` and deploy. Each league's buy button adds `?client_reference_id=<league id>`, which is how the webhook knows which league to turn on.

The Workers Paid plan ($5 a month) is required: building a week's facts takes more CPU than the free plan's 10ms.

### Deploys

`npx wrangler deploy` from this folder ships to production. CI (`.github/workflows/ci.yml`) deploys too, on every push to `main` once the Python and worker tests pass, after two repo secrets exist: `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`. Secrets set with `wrangler secret put` survive deploys.

### Going live with Stripe

Test mode uses a sandbox Payment Link and webhook endpoint (`plink_1UNN0lGQzLQ7kipMPanxaF6C`, `we_1UNN0lGQzLQ7kipMkmaokOm6`). There are no Stripe API keys in the app, so going live is three changes:

1. In the live account, create the same product, price, Payment Link (same `/paid` redirect) and webhook endpoint.
2. Put the live Payment Link in `PAYMENT_LINK`, deploy, and `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with the live endpoint's signing secret.
3. Turn off the leagues test payments turned on: `UPDATE leagues SET paid_via = NULL WHERE paid_via LIKE 'cs_test_%'`.

## Run it

```bash
npx wrangler tail fantasy-recap                       # live logs
npx wrangler workflows instances list recap           # recent recap runs
npx wrangler d1 execute fantasy-recap --remote --command "SELECT slug, season, paid_via FROM leagues WHERE paid_via IS NOT NULL"
```

- **Comp a league:** visit `/<league id>` once, then `UPDATE leagues SET paid_via = 'comp' WHERE slug = '<slug>'`.
- **Write or redo one recap now:** `node scripts/queue.ts <league id> 2026 5 weekly` (or `day-2026-10-04`). Works for any league, including showcases, and costs a Claude call or three. Game-day facts are computed as of the end of that day, so a late or backfilled update still tells the story as it stood.
- **League lore:** `UPDATE leagues SET lore = '["Last year''s champion is @someone."]' WHERE slug = '<slug>'`
- **Mirror a GitHub-hosted site:** `node scripts/import-site.ts ../../double-dipper double-dipper > import.sql`, then execute it with `--remote --file import.sql`. `showcase` leagues are shown and never written; import with `comp` to hand a league over to the hosted version.
- **Refunds:** in Stripe, then `UPDATE leagues SET paid_via = NULL WHERE paid_via = '<checkout session id>'`.

## Costs

Per league per season (17 weeks): about $20 to $30 of Claude for the weekly recaps (research, draft and punch-up on Claude Opus 5.5) and about $5 for game-day updates (one pass at medium effort; the day's news search is shared by every league). Cloudflare is $5 a month flat at this scale. At $39 a pass that leaves roughly $5 to $15 a league before Stripe's fee. The levers, in order: run the Tuesday drafts through the Batch API (half price; Tuesday morning isn't urgent), share more of the research across leagues, and try Claude Sonnet 5.5 for game-day updates.

## Tests

```bash
npm test        # parity with the Python engine, game-day facts, webhook signatures, the schedule
npm run check   # types
```

Not built yet: accounts (commissioner settings go through SQL), link-preview images, email or group-chat delivery (Discord, GroupMe), ESPN and Yahoo leagues.
