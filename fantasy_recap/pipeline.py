"""One league, one week: fetch, compute, write the jokes (unless the week is frozen), save.

A hosted version calls run() from a job queue with a database-backed store; nothing here knows about GitHub.
"""
import os

from .facts import build
from .sleeper import Sleeper
from .writer import prompts, write_copy


def run(league, store, week=None, fresh=False, dry_run=False, scheduled=False):
    """Returns the path of the week it wrote (or left alone)."""
    facts = build(Sleeper(league.league_id), week)
    path = store.path(facts["season"], facts["week"])
    saved = store.get(facts["season"], facts["week"])
    copy = saved and saved["copy"]
    if saved and saved.get("locked") and not dry_run:
        # Frozen: no run rewrites it, fresh or not. Hand edits still work; dry runs save nothing.
        print(f"::notice::Week {facts['week']} is locked, so this run leaves it alone. "
              f"To rewrite it, delete the \"locked\" line from {path.parent.name}/{path.name}.")
        return path
    if saved and scheduled and copy.get("by") != "template":
        # Sleeper hasn't scored a newer week, or this is the retry run: leave the published week, hand edits and all.
        print(f"::notice::Week {facts['week']} is already up and Sleeper has nothing newer. Nothing to do.")
        facts = saved["facts"]
    elif not copy or fresh or (copy.get("by") == "template" and os.environ.get("ANTHROPIC_API_KEY")):
        earlier = [dict(week=d["facts"]["week"], **{k: v for k, v in d["copy"].items() if k not in ("by", "news")})
                   for d in store.all(facts["season"]) if d["facts"]["week"] < facts["week"]]
        brief, punchup = prompts(facts, league.intro, league.lore)
        fresh_copy = write_copy(facts, earlier, brief, punchup)
        if fresh_copy.get("by") != "template" or not copy:  # a failed rewrite never replaces jokes we already have
            copy = fresh_copy
    # Freeze by default: a week with real jokes locks as soon as it's saved. Plain-label (template) weeks stay
    # open so the afternoon retry, or a rerun, can still write their jokes.
    locked = bool(saved and saved.get("locked")) or copy.get("by") != "template"
    return store.put({**({"locked": True} if locked else {}), "facts": facts, "copy": copy})
