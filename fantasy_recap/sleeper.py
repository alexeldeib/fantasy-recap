"""Sleeper's public API: read-only, no key needed. Every network call to Sleeper goes through here."""
import json
from urllib.request import Request, urlopen

API = "https://api.sleeper.app/v1"
PROJECTIONS = ("https://api.sleeper.com/projections/nfl/{}/{}?season_type=regular"
               "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF")
SCHEDULE = "https://api.sleeper.com/schedule/nfl/regular/{}"


def get(url, fallback=None):
    """Fetch JSON. Required endpoints raise; optional ones pass a fallback."""
    try:  # api.sleeper.com 403s the default Python user agent
        with urlopen(Request(url, headers={"User-Agent": "fantasy-recap"}), timeout=90) as r:
            return json.load(r)
    except Exception:
        if fallback is None:
            raise
        print(f"::warning::{url.split('?')[0]} failed; carrying on without it.")
        return fallback


class Sleeper:
    """One league's data. The optional endpoints (stats, projections, schedule, trades) fall back to empty."""

    def __init__(self, league_id):
        self.base = f"{API}/league/{league_id}"

    def league(self):
        return get(self.base)

    def users(self):
        return get(self.base + "/users")

    def rosters(self):
        return get(self.base + "/rosters")

    def matchups(self, week, fallback=None):
        return get(f"{self.base}/matchups/{week}", fallback)

    def transactions(self, week):
        return get(f"{self.base}/transactions/{week}", [])

    def players(self):
        return get(f"{API}/players/nfl")

    def stats(self, season, week):
        return get(f"{API}/stats/nfl/regular/{season}/{week}", {})

    def projections(self, season, week):
        return get(PROJECTIONS.format(season, week), [])

    def schedule(self, season):
        return get(SCHEDULE.format(season), [])
