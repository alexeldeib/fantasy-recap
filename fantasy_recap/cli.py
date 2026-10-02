"""fantasy-recap: weekly AI-written recap sites for Sleeper fantasy leagues.

  fantasy-recap run                  recap the latest scored week, then rebuild the site in docs/
  fantasy-recap run --week 3 --fresh rewrite week 3's jokes (unless it's locked)
  fantasy-recap render               rebuild the site from saved weeks, no network
  fantasy-recap new <league id> --site-url https://... [--dir path]   start a site for another league

Run it from a league's folder: league.toml, weeks/, and docs/ (the built site) live there.
In CI the WEEK, FRESH and DRY_RUN environment variables stand in for the flags.
"""
import argparse
import os
import sys
from pathlib import Path

from . import config, pipeline
from .render import render_site
from .sleeper import Sleeper
from .store import FileStore


def main(argv=None):
    p = argparse.ArgumentParser(prog="fantasy-recap", description="Weekly AI-written fantasy football recap sites.")
    p.add_argument("--dir", default=".", help="the league's folder (default: here)")
    sub = p.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="recap a week, then rebuild the site")
    run.add_argument("--week", type=int, default=os.environ.get("WEEK") or None, help="default: the latest scored week")
    run.add_argument("--fresh", action="store_true", default=os.environ.get("FRESH") == "true",
                     help="rewrite the jokes even if the week has some (locked weeks are never touched)")
    run.add_argument("--dry-run", action="store_true", default=os.environ.get("DRY_RUN") == "true",
                     help="write the jokes but let the caller skip committing and deploying")
    sub.add_parser("render", help="rebuild the site from saved weeks, no network")
    new = sub.add_parser("new", help="start a site for another Sleeper league")
    new.add_argument("league_id")
    new.add_argument("--site-url", required=True, help="where the site will live, e.g. https://recap.example.com/")
    args = p.parse_args(argv)

    root = Path(args.dir)
    if args.command == "new":
        return scaffold(root, args.league_id, args.site_url)
    league = config.load(root / "league.toml")
    store = FileStore(root)
    if args.command == "run":
        path = pipeline.run(league, store, args.week, args.fresh, args.dry_run,
                            scheduled=os.environ.get("GITHUB_EVENT_NAME") == "schedule")
        if os.environ.get("GITHUB_ENV"):  # tells the workflow's later steps which week this run wrote
            with open(os.environ["GITHUB_ENV"], "a") as env:
                env.write(f"WEEK_FILE={path.relative_to(root)}\n")
    render_site(store, league.site_url, root / "docs", root)


WORKFLOW = """name: Weekly recap

on:
  schedule:
    # GitHub starts scheduled runs late (hours, lately) and can drop them; off the hour helps a little.
    - cron: "17 13 * * 2" # Tuesday 9:17am Eastern (8:17am once daylight saving ends)
    - cron: "17 19 * * 2" # retry: does nothing if the morning run already published the week
  workflow_dispatch:
    inputs:
      week:
        description: Week to recap (blank = latest scored week)
        required: false
      fresh:
        description: Rewrite the jokes even if this week already has some
        type: boolean
        default: false
      dry_run:
        description: Test only; show the jokes in the run summary, don't commit or deploy
        type: boolean
        default: false
  push:
    branches: [main]
    paths: [league.toml, apple-touch-icon.png, "weeks/**"] # hand edits to a week redeploy the site

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: recap
  cancel-in-progress: false

jobs:
  recap:
    uses: alexeldeib/fantasy-recap/.github/workflows/recap.yml@main
    with:
      command: ${{ github.event_name == 'push' && 'render' || 'run' }}
      week: ${{ inputs.week }}
      fresh: ${{ inputs.fresh || false }}
      dry_run: ${{ inputs.dry_run || false }}
    secrets: inherit
"""


def scaffold(root, league_id, site_url):
    if (root / "league.toml").exists():
        sys.exit(f"{root / 'league.toml'} already exists; edit it instead.")
    lg = Sleeper(league_id).league()  # also checks the ID is real
    scoring = {1: "full-PPR", 0.5: "half-PPR"}.get(lg["scoring_settings"].get("rec", 0), "standard")
    root.mkdir(parents=True, exist_ok=True)
    (root / ".github/workflows").mkdir(parents=True, exist_ok=True)
    (root / "league.toml").write_text(
        f"# {lg['name']}: settings for the weekly recap (https://github.com/alexeldeib/fantasy-recap)\n"
        f'league_id = "{league_id}"\n'
        f'site_url = "{site_url.rstrip("/")}/"\n\n'
        "# The first line of the writer's brief. Leave it out to use the default:\n"
        f'# intro = "You write the weekly recap for {config.display_name(lg["name"])}, a {lg["total_rosters"]}-team '
        f'{scoring} fantasy football league of friends on Sleeper."\n\n'
        "# In-jokes, rivalries, nicknames and past champions. The writer works them in.\n"
        "lore = []\n")
    (root / ".github/workflows/weekly.yml").write_text(WORKFLOW)
    (root / ".gitignore").write_text("docs/\n__pycache__/\n")
    print(f"""Started a recap site for {lg['name']} in {root}/. Next:
  1. Create a GitHub repo from that folder and push it.
  2. Settings -> Pages -> Source: GitHub Actions. Add your custom domain there, and a DNS CNAME to <you>.github.io.
  3. gh secret set ANTHROPIC_API_KEY -R <you>/<repo>
  4. Actions -> Weekly recap -> Run workflow, once per finished week (1, 2, 3...) to backfill.
After that it runs itself every Tuesday morning.""")
