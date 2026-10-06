# fantasy-recap

Weekly AI-written recap sites for Sleeper fantasy football leagues. Every Tuesday it pulls the week from Sleeper's public API, works out the trophies and storylines, has Claude search the web for the week's real big plays and memes, writes the jokes (a draft, then a punch-up pass), and publishes a page the league can bookmark. Share the link once; it updates itself.

Running now: [Double Dipper](https://double-dip.alexeldeib.xyz) ([repo](https://github.com/alexeldeib/double-dipper)) and [La Liga](https://liga.alexeldeib.xyz) ([repo](https://github.com/alexeldeib/la-liga)).

## Start a site for your league

The league ID is the long number in your league's Sleeper URL.

```bash
pip install git+https://github.com/alexeldeib/fantasy-recap
fantasy-recap new 1393873211271188480 --site-url https://recap.example.com --dir my-league
```

That writes a site repo: `league.toml`, a weekly GitHub Actions workflow, and a `.gitignore`. Then:

1. Create a GitHub repo from that folder and push it.
2. **Settings → Pages → Source: GitHub Actions.** Add your custom domain there, with a DNS CNAME pointing at `<you>.github.io`.
3. `gh secret set ANTHROPIC_API_KEY -R <you>/<repo>`, and set a monthly spend limit on that key's workspace.
4. **Actions → Weekly recap → Run workflow**, once per finished week, to backfill.

After that it runs itself every Tuesday morning. Each league-week costs about $1 to $2 (three Claude Opus 5.5 calls).

## league.toml

```toml
league_id = "1393873211271188480"
site_url = "https://double-dip.alexeldeib.xyz/"

# Optional. The first line of the writer's brief; the default is built from the league's name, size and scoring.
intro = "You write the weekly recap for the Double Dipper, a 10-team half-PPR fantasy football league of friends on Sleeper."

# Optional. In-jokes, rivalries, nicknames, past champions. The writer works them in.
lore = ["Last year's champion is @someone, who has not stopped mentioning it."]
```

Next season Sleeper gives the renewed league a new ID: update `league_id`, then re-enable the workflow if GitHub switched it off.

## Running a site

- **Weeks freeze.** A week locks (`"locked": true` in `weeks/<season>-<NN>.json`) as soon as Claude writes its jokes, and no run touches it again. Hand edits on GitHub still work and redeploy in a minute or two. To regenerate a week, delete its `locked` line and rerun it with **fresh**.
- **Plain labels mean Claude failed.** The numbers still ship; the week stays unlocked, the afternoon run retries, and GitHub emails you.
- **Dry runs** (**Run workflow → dry run**, usually with **fresh**) show the jokes and the web-research brief in the run summary without committing or deploying.

The [Double Dipper README](https://github.com/alexeldeib/double-dipper#readme) is a full commissioner's guide: hand-editing JSON safely, reruns, and what each failure email means.

## How it's built

A week flows Sleeper → facts → writer → store → render:

| | |
|---|---|
| `fantasy_recap/sleeper.py` | The only code that talks to Sleeper. |
| `fantasy_recap/facts.py` | Pure: one week's results, trophies, cross-team comparisons, power rankings, next week. No network, no AI. |
| `fantasy_recap/writer.py`, `prompts/` | Claude researches the week's real-life plays, drafts the copy, then punches it up. Structured JSON out. |
| `fantasy_recap/store.py` | Saved weeks, one JSON file each. |
| `fantasy_recap/render.py`, `templates/page.html` | Static pages: one per week, the newest at `/`, plus link-preview cards. |
| `fantasy_recap/pipeline.py` | One league, one week, and the freeze rules. |
| `fantasy_recap/config.py`, `cli.py` | `league.toml`, the command line, and `fantasy-recap new`. |
| `.github/workflows/recap.yml` | The job every site repo calls: run, commit, screenshot previews, deploy to Pages. |

Site repos hold only their league's settings and saved weeks. They install the engine from `main` on every run, so a merged change reaches every site on its next run (or its next push). To pin a site, change `@main` in its `weekly.yml` to a tag and set `engine_ref:` to the same tag.

## The hosted version

[`worker/`](worker/) is the same engine as a GameDayBot-style service on Cloudflare: any Sleeper league at `/<league>`, a free preview, a Stripe season pass, the Tuesday recap plus game-day updates after every NFL game day, all in one Worker with D1 and a Workflow. Its tests check that the TypeScript port builds the same facts and renders byte-identical pages as this Python engine. See [worker/README.md](worker/README.md).

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e .
.venv/bin/python tests/test_engine.py
```

The tests replay a recorded week of real Sleeper data, so they run offline and never call Claude. To re-record: `python tests/record_fixture.py <league id> <week>`.
