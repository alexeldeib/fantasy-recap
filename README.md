# The Bench Press

Weekly recaps for Sleeper fantasy football leagues that read like a sports column, not a stat sheet: **https://thebenchpress.app**

Paste a league link and see a free preview of your latest week with your real numbers. A $25 season pass turns on the jokes: the full recap every Tuesday morning (headline, a column called The Rundown, power rankings with a take on every team, fifteen trophies, every score, next week's matchups) and a quick hit after every NFL game day. No accounts, no apps: the league's page is the product, at `thebenchpress.app/<league>`.

Running on it: [Double Dipper](https://thebenchpress.app/double-dipper/) and [La Liga](https://thebenchpress.app/la-liga/), both comped. Their GitHub-era sites ([double-dipper](https://github.com/alexeldeib/double-dipper), [la-liga](https://github.com/alexeldeib/la-liga)) are archived, and their old addresses redirect here, paths and all.

## How it works

Everything lives in [`worker/`](worker/): one Cloudflare Worker, one D1 database, one Workflow.

| Piece | Job |
|---|---|
| `fetch` (`src/index.ts`) | Pages: `/` (landing), `/<slug>` (latest week), `/<slug>/<season>/<week>`, `/<slug>/feed` (every post), `/<slug>/edit` (the commissioner's editor), `/go?league=` (finds a league from any Sleeper link), `/paid` (Stripe's return trip), `/terms`, `/health`, `/stripe/webhook`. |
| `scheduled`, every 15 min | Once a day: refresh the NFL player list, tidy storage, and find comped leagues that Sleeper renewed. Every tick: ask `due()` what's owed and queue it for every paid or comped league, two seconds apart. |
| `RecapWorkflow` | One recap: facts, then the day's or week's shared news search, then Claude's copy, then save. Each step retries on its own, and a failure falls back a step, so the numbers always ship. The weekly draft and punch-up go through the Batch API (half price, and a long high-effort draft never holds a connection open). |
| D1 (`migrations/`) | `leagues` (one row per league per season; `paid_via` says whether it's on), `recaps` (every weekly recap, game-day update and free preview), `cache` (the player list, each game day's news). |

What's due comes from Sleeper's NFL schedule (`src/schedule.ts`): a game-day update once all of a day's games are final, and the weekly recap at 13:00 UTC (9am Eastern) the day after a week's last game, or a day later if a game was postponed. Thursday, Saturday, holiday and international games need no special cases. A recap's row is claimed before its Workflow starts, so each one runs once however often the cron fires.

The rest of `src/`: `sleeper.ts` is the only code that talks to Sleeper; `facts.ts` (a week) and `live.ts` (a game day) turn its data into facts, with no network and no AI; `writer.ts` and `prompts/` have Claude write the copy as structured JSON; `render.ts`, `pages.ts` and `page.html` draw the pages; `editor.ts` is the commissioner's editor; `stripe.ts` checks webhook signatures.

**Playoffs** come from Sleeper's brackets: every playoff game carries its name (Championship, Semifinal, a place game, Consolation). In a two-week round (Double Dipper's final, weeks 16 and 17), the first leg's recap only says who leads, and the second leg is won on the two-week total. The results trophies skip what a week didn't decide, and the champion gets crowned.

## Run it

```bash
cd worker
npx wrangler tail fantasy-recap                       # live logs
npx wrangler workflows instances list recap           # recent recap runs
npx wrangler d1 execute fantasy-recap --remote --command "SELECT slug, season, paid_via FROM leagues WHERE paid_via IS NOT NULL"
curl https://thebenchpress.app/health                 # 503 if anything failed, shipped without jokes, or stuck in the last day
```

A GitHub Action checks `/health` every 6 hours (`.github/workflows/health.yml`); a failed check emails you.

- **Comp a league** (yours, friends, prizes): `node scripts/comp.ts <Sleeper league link or ID>`. It prints the league's private editor link, and `--off` undoes it. A comp carries over when Sleeper renews the league next season. For giveaways at scale, a 100%-off Stripe promotion code does the same through the normal checkout ($0 checkouts count as paid).
- **The editor:** each paid or comped league has a private link, `/<slug>/edit?key=...`, shown on the checkout's return page and printed by `comp.ts`. The commissioner can rewrite any line of any post and set the league's intro and lore, which the writer works into later recaps. A lost link: `SELECT slug, edit_key FROM leagues WHERE slug = '<slug>'`.
- **Write or redo one recap now:** `node scripts/queue.ts <league id> 2026 5 weekly` (or `day-2026-10-04`). It works for any league and costs a Claude call or three. Game-day facts are computed as of the end of that day, so a late or backfilled update still tells the story as it stood.
- **Refunds:** refund the payment in Stripe, then `UPDATE leagues SET paid_via = NULL WHERE paid_via = '<checkout session id>'`. The policy is on `/terms`: a full refund within 7 days, or any time a problem on our end stops the recaps.
- **Take a league's pages down:** `DELETE FROM recaps WHERE league_id = '<id>'`, then `DELETE FROM leagues WHERE league_id = '<id>'`.
- **Mirror a GitHub-hosted site:** `node scripts/import-site.ts ../../double-dipper double-dipper comp > import.sql`, then run it with `--remote --file import.sql`.

## Deploys and changes

Push to `main`: CI (`.github/workflows/ci.yml`) runs the tests, applies any new D1 migrations, then deploys. Deploys need two repo secrets, `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`; until the token exists, CI skips them. `npx wrangler deploy` from `worker/` also ships, after `npx wrangler d1 migrations apply fantasy-recap --remote`.

A schema change is a new numbered file in `worker/migrations/`. Never edit one that has already run.

Secrets live in Cloudflare, set with `npx wrangler secret put`: `ANTHROPIC_API_KEY` (without it, recaps ship with plain labels and game-day updates are skipped) and `STRIPE_WEBHOOK_SECRET`.

## Payments

Stripe is live. The account (Ace Eldeib) has one product, "The Bench Press season pass", at $25, sold through a Payment Link (`plink_1UNOk7GQzLQ7kipMgvSx2FaW`, in `PAYMENT_LINK` in `wrangler.jsonc`). Each league's buy button adds `?client_reference_id=<league id>`. After checkout, Stripe sends the buyer to `/paid?session={CHECKOUT_SESSION_ID}`. The webhook (`we_1UNOk8GQzLQ7kipMA7ct7tsb`, for `checkout.session.completed` and `checkout.session.async_payment_succeeded`) turns the league on and writes its latest week right away. Promotion codes are allowed. A 100%-off code with ten uses is in the dashboard for giveaways. There are no Stripe API keys in the app, only the webhook's signing secret.

The test-mode setup (the Ace Eldeib sandbox: `plink_1UNO8eGQzLQ7kipMUQdFElix`, `we_1UNN0lGQzLQ7kipMkmaokOm6`, code `FREESEASON26`) is still there for trying changes. To use it, point `PAYMENT_LINK` and `STRIPE_WEBHOOK_SECRET` at it, and afterwards turn off what it turned on: `UPDATE leagues SET paid_via = NULL WHERE paid_via LIKE 'cs_test_%'`.

## Costs

Every recap saves what its Claude calls cost: `SELECT kind, json_extract(doc, '$.cost.usd') FROM recaps`. Measured in weeks 3 and 4 of 2026, at list prices:

| Recap | Cost |
|---|---|
| Weekly recap (Opus 5.5, batched draft and punch-up) | about $0.48 |
| Game-day update | $0.06 to $0.11 |
| News search, shared by every league | about $0.50 a game day |

That's about $12.50 of Claude per league per season against the $25 pass, plus about $25 a season in shared news searches whatever the number of leagues. Cloudflare is the $5 a month Workers Paid plan.

Storage grows only with paid leagues (about 0.5 MB a league a season). Previews, failures, unpaid leagues and old news expire on their own, and Workflow run histories are kept for three days.

## Scale

Sleeper asks for under 1,000 requests a minute. A weekly recap makes about 20, so the cron starts leagues two seconds apart (30 a minute), and the NFL-wide stats and projections are cached for a minute so a burst shares them. That's 300 leagues in ten minutes on a Tuesday. Past that, spread the starts wider or cache more.

## Development

```bash
cd worker
npm install
npm test        # recorded weeks (both leagues), playoffs, game days, the schedule, webhook signatures, the editor
npm run check   # types
npx wrangler d1 migrations apply fantasy-recap --local && npx wrangler dev   # a local copy, with an empty database
```

The tests replay recorded Sleeper data, so they run offline and never call Claude. The engine began as a Python program, and `test/golden/` holds its last output for five recorded weeks: the facts and pages must stay byte-identical. Never regenerate a golden file just to make a change pass.

Not built yet: link-preview images, group-chat delivery (Discord, GroupMe), ESPN and Yahoo leagues, and recaps that follow Sleeper's late stat corrections.
