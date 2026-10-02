"""A league's settings: which Sleeper league, where its site lives, and anything the writer should know."""
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class League:
    league_id: str
    site_url: str
    intro: str = ""  # first line of the writer's brief; derived from the league when empty
    lore: list = field(default_factory=list)  # in-jokes, rivalries, nicknames, past champions


def load(path="league.toml"):
    data = tomllib.loads(Path(path).read_text())
    site = data["site_url"].rstrip("/") + "/"
    return League(league_id=str(data["league_id"]), site_url=site, intro=data.get("intro", ""), lore=list(data.get("lore", [])))


def display_name(league_name):
    """The league's own name, minus any emoji: "La Liga 🏈" -> "La Liga"."""
    return re.sub(r"[^\w\s'’().&-]", "", league_name).strip() or league_name
