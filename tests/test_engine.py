"""Offline checks for the recap engine, replaying a recorded week of real Sleeper data (Double Dipper, 2026 week 3).

  python tests/test_engine.py     (or pytest)
"""
import json
import os
import tempfile
from pathlib import Path

from fantasy_recap import cli, config, pipeline, writer
from fantasy_recap.config import League
from fantasy_recap.facts import build
from fantasy_recap.render import render_site
from fantasy_recap.store import FileStore

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "sleeper-week3.json").read_text())


class Replay:
    """The Sleeper client, answering from the fixture instead of the network."""

    def __init__(self, league_id=None):
        pass

    def __getattr__(self, name):
        return lambda *args, **kwargs: FIXTURE[f"{name}:{':'.join(map(str, args))}"]


def test_facts():
    f = build(Replay(), 3)
    award = {a["key"]: a for a in f["awards"]}
    assert (f["week"], len(f["games"]), f["scoring"]) == (3, 5, "half-PPR")
    assert award["heartbreaker"]["team"] == "louisnicoletti"
    assert award["heartbreaker"]["stat"].endswith("one swap from winning by 0.10")
    assert award["best_mgr"]["team"] == "aaronargyres" and award["best_mgr"]["stat"].startswith("100%")
    assert "J. Gibbs (37.90, casebrabham) outscored Corey Dylan Clark's 7 lowest starters combined (37.80)" in f["gems"]
    assert [p["team"] for p in f["power"][:3]] == ["aaronargyres", "casebrabham", "Lamar JacksOff"]
    assert (f["standings"][0]["team"], f["standings"][0]["w"], f["standings"][0]["l"]) == ("jwalthier", 3, 0)
    assert f["next"]["week"] == 4 and len(f["next"]["games"]) == 5


def test_site():
    f = build(Replay(), 3)
    with tempfile.TemporaryDirectory() as tmp:
        store = FileStore(tmp)
        store.put({"facts": f, "copy": dict(writer.template_copy(f), headline="MAYE DAY")})
        render_site(store, "https://example.com/", Path(tmp) / "docs", tmp)
        built = {p.relative_to(Path(tmp) / "docs").as_posix() for p in (Path(tmp) / "docs").rglob("*") if p.is_file()}
        assert built == {"index.html", "icon.html", "2026/3/index.html", "2026/3/card.html"}, built
        page = (Path(tmp) / "docs" / "index.html").read_text()
        assert "<title>MAYE DAY · Double Dipper Week 3</title>" in page
        assert 'content="https://example.com/2026/3/og.jpg"' in page


def test_lock_policy():
    league = League("unused", "https://example.com/")
    pipeline.Sleeper = Replay

    def plain(facts, *rest):  # what write_copy returns when Claude fails
        return writer.template_copy(facts)

    def jokes(facts, *rest):
        return dict(writer.template_copy(facts), by="claude-test")

    with tempfile.TemporaryDirectory() as tmp:
        store = FileStore(tmp)
        pipeline.write_copy = plain
        week = pipeline.run(league, store, 3)  # Claude failed: plain labels, left open for a retry
        assert "locked" not in json.loads(week.read_text())
        pipeline.write_copy = jokes
        os.environ.setdefault("ANTHROPIC_API_KEY", "test")  # retries only happen with a key (write_copy is stubbed)
        pipeline.run(league, store, 3)  # the retry writes jokes, which lock on save
        assert json.loads(week.read_text())["locked"] is True
        before = week.read_bytes()
        pipeline.run(league, store, 3, fresh=True)  # locked beats fresh
        assert week.read_bytes() == before
        pipeline.run(league, store, 3, fresh=True, dry_run=True)  # dry runs still work, and keep the lock
        assert json.loads(week.read_text())["locked"] is True



def test_cli():
    cli.Sleeper = Replay
    with tempfile.TemporaryDirectory() as tmp:
        cli.main(["--dir", tmp, "new", "123", "--site-url", "https://recap.example.com"])
        league = config.load(Path(tmp) / "league.toml")
        assert (league.league_id, league.site_url, league.intro, league.lore) == ("123", "https://recap.example.com/", "", [])
        assert "uses: alexeldeib/fantasy-recap/.github/workflows/recap.yml@main" in (Path(tmp) / ".github/workflows/weekly.yml").read_text()
        f = build(Replay(), 3)
        FileStore(tmp).put({"facts": f, "copy": writer.template_copy(f)})
        cli.main(["--dir", tmp, "render"])
        assert 'href="https://recap.example.com/2026/3/"' in (Path(tmp) / "docs" / "index.html").read_text()
        try:
            cli.main(["--dir", tmp, "new", "123", "--site-url", "https://recap.example.com"])
            raise AssertionError("new overwrote league.toml")
        except SystemExit:
            pass

if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
