"""The Python engine's output for a recorded week, for the parity tests: facts, page HTML and prompts as JSON."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2]))
from fantasy_recap import facts as F, render, writer  # noqa: E402

fixture, week, site = sys.argv[1], int(sys.argv[2]), sys.argv[3]
data = json.loads((Path(__file__).parent / "fixtures" / fixture).read_text())


class Replay:
    def __getattr__(self, name):
        return lambda *args, **kwargs: data[f"{name}:{':'.join(map(str, args))}"] if f"{name}:{':'.join(map(str, args))}" in data else kwargs.get("fallback", [] if name in ("transactions", "projections", "schedule") else {})


f = F.build(Replay(), week)
copy = json.loads(sys.stdin.read() or "null") or writer.template_copy(f)
shell = (Path(__file__).parents[2] / "fantasy_recap/templates/page.html").read_text()
url = f"{site}{f['season']}/{f['week']}/"
doc = {"facts": f, "copy": copy}
print(json.dumps({"facts": f, "template_copy": writer.template_copy(f), "prompts": writer.prompts(f, "", ["A test lore line."]),
                  "page": render.page(shell, f, copy, url, [doc], site)}, ensure_ascii=False))
