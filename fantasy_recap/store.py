"""Saved weeks: weeks/<season>-<NN>.json, each {locked?, facts, copy}.

This is the seam a hosted version swaps for a database: the pipeline and the renderer only call
path(), get(), put() and all().
"""
import json
import sys
from pathlib import Path


def load(p):
    """A week file. A broken hand edit stops the run naming the file and the fix, instead of a traceback."""
    try:
        return json.loads(Path(p).read_text())
    except ValueError as err:
        print(f"::error file={p}::{Path(p).name} isn't valid JSON ({err}). A straight double quote "
              'inside a line must be written \\" and the last item in a list takes no comma.')
        sys.exit(1)


class FileStore:
    def __init__(self, root="."):
        self.dir = Path(root) / "weeks"

    def path(self, season, week):
        return self.dir / f"{season}-{int(week):02d}.json"

    def get(self, season, week):
        p = self.path(season, week)
        return load(p) if p.exists() else None

    def put(self, doc):
        p = self.path(doc["facts"]["season"], doc["facts"]["week"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
        return p

    def all(self, season=None):
        return [load(p) for p in sorted(self.dir.glob(f"{season or '*'}-*.json"))]
