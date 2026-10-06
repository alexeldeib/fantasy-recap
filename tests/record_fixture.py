"""Re-record tests/fixtures/sleeper-week3.json: every Sleeper response build() needs for one league-week, trimmed to
the players that league actually rosters. Usage: python tests/record_fixture.py <league id> <week>"""
import json
import sys
from pathlib import Path

from fantasy_recap.facts import STATS, build
from fantasy_recap.sleeper import Sleeper


class Recorder(Sleeper):
    def __init__(self, league_id):
        super().__init__(league_id)
        self.calls = {}

    def __getattribute__(self, name):
        attr = super().__getattribute__(name)
        if name.startswith("_") or not callable(attr) or name in ("calls",):
            return attr

        def record(*args, **kwargs):
            out = attr(*args, **kwargs)
            self.calls[f"{name}:{':'.join(map(str, args))}"] = out
            return out
        return record


def trim(calls):
    """Only what build() reads. The repo is public: Sleeper's league endpoint also returns the latest league chat
    message, and users, rosters and transactions carry notification settings and waiver notes."""
    calls["league:"] = {k: v for k, v in calls["league:"].items() if k in (
        "league_id", "name", "season", "season_type", "sport", "status", "total_rosters", "settings",
        "roster_positions", "scoring_settings")}
    calls["users:"] = [dict({k: u[k] for k in ("user_id", "display_name", "avatar", "is_owner") if k in u},
                            metadata={k: v for k, v in (u.get("metadata") or {}).items() if k in ("team_name", "avatar")})
                       for u in calls["users:"]]
    calls["rosters:"] = [{k: r.get(k) for k in ("roster_id", "owner_id", "starters", "players")} for r in calls["rosters:"]]
    for key in [k for k in calls if k.startswith("transactions")]:
        calls[key] = [{k: v for k, v in t.items() if k in ("type", "status", "adds", "drops", "roster_ids", "settings", "leg")}
                      for t in calls[key]]
    keep = set()
    for key, value in calls.items():
        if key.startswith(("rosters", "matchups")):
            for row in value:
                keep.update(row.get("players") or [])
                keep.update(row.get("starters") or [])
        if key.startswith("transactions"):
            for t in value:
                keep.update((t.get("adds") or {}).keys())
    fields = ("position", "fantasy_positions", "first_name", "last_name", "full_name", "team", "injury_status")
    calls["players:"] = {p: {k: v for k, v in calls["players:"][p].items() if k in fields}
                         for p in keep if p in calls["players:"]}
    stat_keys = {k for k, _ in STATS}
    for key in [k for k in calls if k.startswith("stats")]:
        calls[key] = {p: {k: v for k, v in s.items() if k in stat_keys} for p, s in calls[key].items() if p in keep}
    for key in [k for k in calls if k.startswith("projections")]:
        calls[key] = [dict(player_id=x["player_id"], stats={k: v for k, v in (x.get("stats") or {}).items() if k.startswith("pts_")})
                      for x in calls[key] if x.get("player_id") in keep]
    return calls


def main(league_id, week):
    rec = Recorder(league_id)
    build(rec, int(week))
    calls = trim(rec.calls)
    out = Path(__file__).parent / "fixtures" / f"sleeper-week{week}.json"
    out.write_text(json.dumps(calls, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(calls)} responses, {len(calls['players:'])} players)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
