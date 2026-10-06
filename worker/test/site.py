"""The Python engine's pages for a real site's saved weeks: {"<season>/<week>": html}, for the render parity test."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2]))
from fantasy_recap import render  # noqa: E402
from fantasy_recap.store import FileStore  # noqa: E402

root, site = sys.argv[1], sys.argv[2]
data = FileStore(root).all()
shell = (Path(__file__).parents[2] / "fantasy_recap/templates/page.html").read_text()
print(json.dumps({f"{d['facts']['season']}/{d['facts']['week']}": render.page(
    shell, d["facts"], d["copy"], f"{site}{d['facts']['season']}/{d['facts']['week']}/", data, site) for d in data}, ensure_ascii=False))
