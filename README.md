# The Bench Press

Weekly recaps for Sleeper fantasy football leagues that read like a sports column, not a stat sheet: **https://thebenchpress.app**

Paste a league link and see a free preview of your latest week with your real numbers. A $25 season pass turns on the jokes: the full recap every Tuesday morning (headline, a column called The Rundown, power rankings with a take on every team, fifteen trophies, every score, next week's matchups) and a quick hit after every NFL game day. No accounts, no apps: the league's page is the product, at `thebenchpress.app/<league>`.

Running on it: [Double Dipper](https://thebenchpress.app/double-dipper-188480/) and [La Liga](https://thebenchpress.app/la-liga-323584/), both comped. Their GitHub-era sites ([double-dipper](https://github.com/alexeldeib/double-dipper), [la-liga](https://github.com/alexeldeib/la-liga)) are archived.

**Operating it** (refunds, comps, fixing or rewriting a post, takedowns, incidents, secrets, restores): [RUNBOOK.md](RUNBOOK.md).

## How it works

Everything lives in [`worker/`](worker/): one Cloudflare Worker, one D1 database, one Workflow.

| Piece | Job |
|---|---|
| `fetch` (`src/index.ts`) | Pages: `/` (landing), `/<slug>` (latest week; a slug is the league's name plus the last six digits of its Sleeper ID, since names repeat), `/<slug>/<season>/<week>`, `/<slug>/feed` (every post), `/<slug>/edit` (the commissioner's editor), `/go?league=` (finds a league from any Sleeper link), `/paid` (Stripe's return trip), `/terms`, `/health`, `/stripe/webhook`. |
| `scheduled`, every 15 min | Once a day: refresh the NFL player list, tidy storage, and find comped leagues that Sleeper renewed. Every tick: ask `due()` what's owed and queue it for every paid or comped league, two seconds apart. |
| `RecapWorkflow` | One recap: facts, then the day's or week's shared news search, then Claude's copy, then save. Each step retries on its own, and a failure falls back a step, so the numbers always ship. The weekly draft and punch-up go through the Batch API (half price, and a long high-effort draft never holds a connection open). |
| D1 (`migrations/`) | `leagues` (one row per league per season; `paid_via` says whether it's on), `recaps` (every weekly recap, game-day update and free preview), `cache` (the player list, each game day's news). |

What's due comes from Sleeper's NFL schedule (`src/schedule.ts`): a game-day update once all of a day's games are final, and the weekly recap at 13:00 UTC (9am Eastern) the day after a week's last game, or a day later if a game was postponed. Thursday, Saturday, holiday and international games need no special cases. A recap's row is claimed before its Workflow starts, so each one runs once however often the cron fires.

The rest of `src/`: `sleeper.ts` is the only code that talks to Sleeper; `facts.ts` (a week) and `live.ts` (a game day) turn its data into facts, with no network and no AI; `writer.ts` and `prompts/` have Claude write the copy as structured JSON; `render.ts`, `pages.ts` and `page.html` draw the pages; `editor.ts` is the commissioner's editor; `stripe.ts` checks webhook signatures. `scripts/admin.ts` is the operator's tool (see the runbook).

**Best ball** leagues skip the trophies about lineup calls, since Sleeper sets their lineups itself.

**Playoffs** come from Sleeper's brackets: every playoff game carries its name (Championship, Semifinal, a place game, Consolation). In a two-week round (Double Dipper's final, weeks 16 and 17), the first leg's recap only says who leads, and the second leg is won on the two-week total. The results trophies skip what a week didn't decide, and the champion gets crowned.

## Monitoring

`https://thebenchpress.app/health` answers 503 when any recap failed, shipped without jokes, or got stuck in the last day, and a GitHub Action (`.github/workflows/health.yml`) checks it every 6 hours: a failed check emails you. What to do then is in the [runbook](RUNBOOK.md#the-health-check-failed).

## Deploys and changes

Push to `main`: CI (`.github/workflows/ci.yml`) runs the tests, applies any new D1 migrations, then deploys. Deploys need two repo secrets, `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`; until the token exists, CI skips them. `npx wrangler deploy` from `worker/` also ships, after `npx wrangler d1 migrations apply fantasy-recap --remote`.

A schema change is a new numbered file in `worker/migrations/`. Never edit one that has already run.

Secrets live in Cloudflare, set with `npx wrangler secret put`: `ANTHROPIC_API_KEY` (without it, recaps ship with plain labels and game-day updates are skipped) and `STRIPE_WEBHOOK_SECRET`. CI's `CLOUDFLARE_API_TOKEN` is a GitHub repo secret. None are in the repo; rotation is in the [runbook](RUNBOOK.md#secrets).

## Security

There are no accounts. A league's page is public at its slug, and the commissioner's editor sits behind a 128-bit key in a private link. It's shown once after checkout, never cached, kept out of search engines and referrers, and it only edits its own league. The only POST endpoints are the editor and the Stripe webhook, which accepts only events signed with the endpoint's secret within the last five minutes. Every database query binds its values. Everything that reaches a page is escaped, and a Content-Security-Policy lets only the site's own two scripts run (by hash), so markup that slipped past escaping still couldn't run script. CI's GitHub token is read-only, and the deploy job installs without running package scripts.

## Payments

Stripe is live. Refunds, comps and cancellations are in the [runbook](RUNBOOK.md#refunds-and-cancellations). The account (Ace Eldeib) has one product, "The Bench Press season pass", at $25, sold through a Payment Link (`plink_1UNOk7GQzLQ7kipMgvSx2FaW`, in `PAYMENT_LINK` in `wrangler.jsonc`). Each league's buy button adds `?client_reference_id=<league id>`. After checkout, Stripe sends the buyer to `/paid?session={CHECKOUT_SESSION_ID}`. The webhook (`we_1UNOk8GQzLQ7kipMA7ct7tsb`, for `checkout.session.completed` and `checkout.session.async_payment_succeeded`) turns the league on and writes its latest week right away. Promotion codes are allowed. A 100%-off code with ten uses is in the dashboard for giveaways. There are no Stripe API keys in the app, only the webhook's signing secret.

The test-mode setup (the Ace Eldeib sandbox: `plink_1UNO8eGQzLQ7kipMUQdFElix`, `we_1UNN0lGQzLQ7kipMkmaokOm6`, code `FREESEASON26`) is still there for trying changes. To use it, point `PAYMENT_LINK` and `STRIPE_WEBHOOK_SECRET` at it, and afterwards turn off what it turned on: `UPDATE leagues SET paid_via = NULL WHERE paid_via LIKE 'cs_test_%'`.

## Costs

Every recap saves what its Claude calls cost: `SELECT kind, json_extract(doc, '$.cost.usd') FROM recaps`. Measured in weeks 3 and 4 of 2026, at list prices:

| Recap | Cost |
|---|---|
| Weekly recap (Opus 5.5, batched draft and punch-up) | about $0.48 |
| Game-day update | $0.06 to $0.11 |
| News search, shared by every league | about $0.50 a game day |

That's about $12.50 of Claude per league per season against the $25 pass, plus about $25 a season in shared news searches whatever the number of leagues. Cloudflare is the $5 a month Workers Paid plan.

Every post we write stays for good; what it was made from doesn't. In season, Sleeper's data and the news expire within weeks, and once the regular season ends all of it goes, so a finished season costs only its posts: about 0.8 MB per paid league, measured. Posts are the only thing that grows: about 0.8 GB a season at 1,000 leagues, against D1's 10 GB. Past about 10,000 league-seasons, move older seasons' posts to R2. The [runbook](RUNBOOK.md#data-retention) lists everything.

## Sleeper API usage

Most of what the recaps read from Sleeper doesn't need asking twice, so it's kept in D1 (`kept()` in `src/sleeper.ts`):

- **Per league:**
  - A weekly recap makes about 8 requests: league, users, rosters, this week's and last week's scores, one newly settled week, next week's matchups, and transactions. Weeks two or more back are settled, since Sleeper's stat corrections are done by then, so they're kept for the season.
  - A game-day update makes 4.
- **Shared by every league:** the NFL's stats, projections and schedule are kept for 10 minutes, so a burst of leagues asks Sleeper once. Only the fields the recaps use are stored.
- **The cron:**
  - The NFL state, once a day.
  - The schedule, once a day, except every 15 minutes in the hours a game night's last game ends (11pm to 2am Eastern, `scheduleAge()` in `src/schedule.ts`), and hourly while a game that should be over isn't final.

| Scope | Requests |
|---|---|
| Per paid league, per week | about 20 |
| Per paid league, per month | about 90 |
| Per paid league, per 17-week season | about 350 |
| Fixed, at any number of leagues (cron, player list, the shared NFL data) | about 200 a month |
| A free preview | about W + 6 the first time someone opens a league in a given week |

Measured against live Sleeper on week 4:
- Double Dipper's recap made 13 requests: 9 league-specific and 4 NFL-wide.
- La Liga's, right after, made 9, with no NFL-wide requests.
- A recap whose settled weeks are already kept makes 7 or 8.

Before these caches it was about 45 per league per week, plus 5,800 a month fixed.

**Rate.** Sleeper asks for under 1,000 requests a minute. Tuesday's recaps start two seconds apart, 30 leagues a minute, at about 8 requests each: around 240 a minute.

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
