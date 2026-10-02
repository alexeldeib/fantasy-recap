"""Facts + copy -> the broadcast-style recap page, and the static site around it."""
import html
import re
import shutil
from importlib.resources import files
from pathlib import Path

from .config import display_name

BIG = ("blowout", "high", "low", "close", "heartbreaker")  # the big stuff; every other trophy is an "other fun stat"
AT = r"@\w+"  # @mentions get lit up in running text


def ems(s):
    """Rough width of s set in the display caps, in em, so big type can be sized to fit its column."""
    return sum(.11 if ch == " " else .27 if ch in "I1.,:;'’!|" else .73 if ch in "@MW%" else .53 for ch in s.upper())


def led_ems(s):
    """Advance width of s in the LED numerals (Big Shoulders Display Black), in em."""
    return sum(.27 if ch in "1.,:" else .45 if ch == "-" else .68 if ch == "%" else .22 if ch == " " else .5 for ch in s)


def ring(a, b):
    """The telestrator loop around the hero number: a rounded oval (semi-axes a, b in em) drawn in one stroke that
    spirals a little past where it started. Returns the viewBox width, height and path, in hundredths of an em."""
    import math
    grow, s = 1.075, 7  # how far the loop spirals out by the end, and room for the stroke
    w, h = 2 * (a * grow * 100 + s), 2 * (b * grow * 100 + s)
    pts = []
    for i in range(31):
        t = math.radians(-50 - 410 * i / 30)
        c, n = math.cos(t), math.sin(t)
        r = (1 + .055 * i / 30) * (1 + .015 * math.sin(2.5 * t))
        pts.append((w / 2 + a * 100 * r * math.copysign(abs(c) ** .8, c), h / 2 + b * 100 * r * math.copysign(abs(n) ** .8, n)))
    d = "M%.0f %.0f" % pts[0]
    for i in range(30):  # Catmull-Rom through the points, as cubic Beziers
        p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, 30)]
        d += " C%.0f %.0f %.0f %.0f %.0f %.0f" % (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
                                                 p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, *p2)
    return w, h, d


ARROW = ('<svg class="arrow" viewBox="0 0 44 30" aria-hidden="true" focusable="false">'
         '<path pathLength="1" d="M42 3 C30 5 16 12 7 26 M17 25 L7 27 L6 17"/></svg>')
SCRIBBLE = ('<svg class="scrib" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
            '<path d="M3 8 C28 3 52 10 78 5 S108 3 117 7"/></svg>')


def page(shell, f, c, url, data, site):
    e = html.escape
    who = {t["team"]: t for t in f["teams"]}
    lines = {k: {x["key"]: x["line"] for x in c.get(k) or []}
             for k in ("award_lines", "game_lines", "preview_lines", "power_lines")}
    notes = [n if len(n) <= 22 else "" for n in ((n or "").strip() for n in c.get("pen_notes") or [])]  # marker notes stay short
    wk, league = f["week"], f["league"]

    def lit(s, pattern=r"(?<![\w.])[-+$]?\d+(?:[.,]\d+)*(?:%|st|nd|rd|th)?(?!\w)", hit=""):  # escape, light up numbers
        return re.sub(pattern, lambda m: f'<b class="hit">{m[0]}</b>' if m[0] == hit else f"<b>{m[0]}</b>", e(s, quote=False))

    def fit(name):  # widest word, so CSS can shrink a long name instead of breaking it mid-word
        return f"{max(map(ems, name.split() or [''])):.2f}"

    def note(i, extra=""):
        return f'<p class="pen">{e(notes[i])}{extra}</p>' if i < len(notes) and notes[i] else ""

    def avatar(team, size):
        t = who.get(team, {})
        if t.get("avatar"):
            return f'<img class="av" src="{e(t["avatar"])}" alt="" width="{size}" height="{size}" loading="lazy" decoding="async">'
        return f'<span class="av" aria-hidden="true">{e(team[:1].upper())}</span>'

    def manager(team):
        return who.get(team, {}).get("manager") or team

    def lower_third(team, size):
        mgr = manager(team)
        sub = f'<span class="l3-team">{e(team)}</span>' if mgr != team else ""
        return (f'<div class="l3">{avatar(team, size)}<p><span class="l3-name" style="--n:{fit("@" + mgr)}">@{e(mgr)}</span>'
                f'{sub}</p></div>')

    taped = set()  # each tale of the tape runs once; the same swap under a second trophy reads like a bug

    def tape(v):
        if not v or (v["a"], v["b"]) in taped:
            return ""
        taped.add((v["a"], v["b"]))
        top = max(v["a_pts"], v["b_pts"]) or 1
        return '<div class="tape">' + "".join(
            f'<p class="tp tp-{k}"><span class="tp-tag">{e(v[k + "_tag"])}</span><span class="tp-name">{e(v[k])}</span>'
            f'<b class="tp-pts">{v[k + "_pts"]:.2f}</b><span class="tp-bar" style="--p:{max(v[k + "_pts"], 0) / top * 100:.0f}%">'
            f'</span></p>' for k in "ab") + "</div>"

    def line(kind, key, cls):
        text = lines[kind].get(str(key))
        return f'<p class="{cls}">{lit(text, AT)}</p>' if text else ""  # @names light up, as in the Rundown

    def bumper(hid, title, kicker, pen=""):
        return f'<div class="bump"><h2 id="{hid}"><span>{e(title)}</span></h2><p class="bump-k">{e(kicker)}</p>{pen}</div>'

    def bug_row(team, pts, cls, fmt):
        shown = "–" if pts is None else fmt.format(pts)
        return (f'<p class="sb-row {cls}">{avatar(team, 34)}<span class="sb-t" style="--n:{fit(team)}">{e(team)}</span>'
                f'<b class="sb-s">{shown}</b></p>')

    # Week switcher: every saved week of this season, plus previous/next steps across all of them.
    def week_url(x):
        return f'{site}{x["season"]}/{x["week"]}/'

    weeks = [d["facts"] for d in data]
    here = next((i for i, x in enumerate(weeks) if (x["season"], x["week"]) == (f["season"], wk)), None)

    def step(i, cls, label):
        if here is None or not 0 <= i < len(weeks):
            return f'<span class="step {cls} off" aria-hidden="true"></span>'
        return (f'<a class="step {cls}" href="{week_url(weeks[i])}" rel="{cls}">'
                f'<span class="sr">{label}: week {weeks[i]["week"]}</span></a>')

    chips = "".join(
        f'<li><a href="{week_url(x)}"{" aria-current=page" if i == here else ""}>Wk {x["week"]}</a></li>'
        for i, x in enumerate(weeks) if x["season"] == f["season"])
    week_nav = (f'<nav class="weeks" aria-label="Weeks">{step((here or 0) - 1, "prev", "Previous")}'
                f'<ol class="wk-list" role="list">{chips}</ol>{step((here or 0) + 1, "next", "Next")}</nav>')

    # Lead: headline, dek, and the stat graphic. The analyst's loop clears the digits' corners by 0.07em,
    # with more air above, below and to the sides; the board leaves room around the loop.
    head, value, cap = c.get("headline") or "", c.get("hero_value") or "", c.get("hero_caption") or ""
    stat = ""
    if value:
        x, y = (led_ems(value) - .08) / 2 + .07, .41 + .07  # half the digits' ink box, plus clearance
        b = .64
        a = x / (1 - (y / b) ** 2.5) ** .4 / .985
        w, h, d = ring(a, b / .985)
        stat = (f'<div class="stat" style="--rw:{w / 100:.2f};--rh:{h / 100:.2f};--lp:{(h / 100 + .2 - 1) / 2:.2f}">'
                f'<p class="stat-tab">The number</p>{note(0, ARROW)}'
                f'<div class="stat-box"><span class="led-glow"><span class="led">{e(value)}</span></span>'
                f'<svg class="ring" viewBox="0 0 {w:.0f} {h:.0f}" aria-hidden="true" focusable="false">'
                f'<path pathLength="1" d="{d}"/></svg></div>'
                f'{f"<p class=stat-cap>{e(cap)}</p>" if cap else ""}</div>')

    def crawl_item(i, g):
        quip = lines["game_lines"].get(str(i))
        return (f'<span class="ci"><b class="ci-k">Final</b><span class="ci-t">{e(g["win"]["team"])}</span>'
                f'<b class="ci-s">{g["win"]["pts"]:.2f}</b><span class="ci-t ci-l">{e(g["lose"]["team"])}</span>'
                f'<b class="ci-s ci-l">{g["lose"]["pts"]:.2f}</b>{f"<span class=ci-q>{e(quip)}</span>" if quip else ""}</span>')

    reel = "".join(crawl_item(i, g) for i, g in enumerate(f["games"], 1))
    secs = max(30, len(re.sub("<[^>]+>", "", reel)) // 8)  # about 65px a second
    crawl = (f'<div class="crawl"><p class="crawl-k" aria-hidden="true">Finals</p>'
             f'<input type="checkbox" id="hold" class="hold-box"><label for="hold" class="hold"><span class="sr">Pause the scores ticker</span></label>'
             f'<div class="crawl-view" aria-hidden="true"><p class="crawl-track" style="--dur:{secs}s">'
             f'<span class="crawl-set">{reel}</span><span class="crawl-set">{reel}</span></p></div></div>') if reel else ""
    # The dek follows the number, so a phone's first screen is the pun and the circled number; on wide screens the
    # grid puts it back under the headline. The card bug only shows on the link-preview card (card.html).
    brand = display_name(league)
    mark = "".join(w[:1] for w in league.split()[:2]).upper()
    dek = c.get("dek") or ""
    lead = (f'<section class="lead" aria-labelledby="lead-h" data-wk="{wk}"><div class="lead-in"><div class="lead-copy">'
            f'<p class="kick">Week {wk} · Top story</p>'
            f'<h1 id="lead-h" class="headline" style="--hw:{max(map(ems, head.split() or [""])):.2f};--ht:{ems(head):.2f}">{e(head)}</h1>'
            f'<p class="card-bug" aria-hidden="true"><span class="mark">{e(mark)}</span>{brand}</p></div>'
            f'{stat}{f"<p class=dek>{lit(dek, AT)}</p>" if dek else ""}</div>{crawl}</section>')

    # The Rundown: the lead segment, in the writer's words. Skipped when there's no story (template copy).
    story = [s.strip() for s in c.get("story") or [] if s and s.strip()]
    story_title = f'<h3 class="story-title">{e(c["story_title"])}</h3>' if c.get("story_title") else ""
    rundown = (f'<section class="seg rundown" aria-labelledby="run-h">{bumper("run-h", "The Rundown", f"Week {wk} · from the desk", note(1, SCRIBBLE))}'
               f'<div class="story">{story_title}{"".join(f"<p>{lit(s, AT)}</p>" for s in story)}</div></section>') if story else ""

    # Power rankings: all ten, with movement. The analyst circles the week's biggest climb.
    power = f.get("power") or []
    climbs = [p["prev"] - p["rank"] for p in power if p.get("prev")]
    top_climb = max(climbs, default=0)

    def movement(p):
        if not p.get("prev"):
            return '<span class="mv new">New</span>'
        delta = p["prev"] - p["rank"]
        if delta:
            hot = " hot" if delta == top_climb >= 3 else ""
            return (f'<span class="mv {"up" if delta > 0 else "down"}{hot}"><span class="sr">{"up" if delta > 0 else "down"} </span>'
                    f'{abs(delta)}</span>')
        return '<span class="mv same"><span class="sr">no change</span></span>'

    def ranked(p):
        mgr = manager(p["team"])
        # Joined with real spaces so a narrow screen can wrap between the parts (each part stays whole).
        meta = " ".join(f"<span>{e(x)}</span>" for x in (f"@{mgr}" if mgr != p["team"] else "", p.get("record"),
                                                         f'{p["all_play"]} all-play' if p.get("all_play") else "") if x)
        return (f'<li class="pr-row"><span class="pr-rk">{p["rank"]}</span>{movement(p)}{avatar(p["team"], 44)}'
                f'<p class="pr-team"><b style="--n:{fit(p["team"])}">{e(p["team"])}</b></p><p class="pr-meta">{meta}</p>'
                f'{line("power_lines", p["team"], "pr-line")}</li>')

    rankings = (f'<section class="seg power" aria-labelledby="pow-h">{bumper("pow-h", "Power Rankings", "All-play record, then points", note(2, SCRIBBLE))}'
                f'<ol class="pr" role="list">{"".join(map(ranked, power))}</ol></section>') if power else ""

    # Trophies: the supporting stats package. The big stuff first, then the other fun stats.
    def award(a):
        big = a["key"] in BIG
        return (f'<article class="aw{" aw-big" if big else ""}"><h4 class="aw-tag"><span aria-hidden="true">{e(a["emoji"])}</span>'
                f'{e(a["label"])}</h4>{lower_third(a["team"], 56 if big else 48)}<p class="aw-stat">{lit(a["stat"], hit=value)}</p>'
                f'{line("award_lines", a["key"], "aw-line")}{tape(a.get("vs"))}</article>')

    big = "".join(award(a) for a in f["awards"] if a["key"] in BIG)
    more = "".join(award(a) for a in f["awards"] if a["key"] not in BIG)
    count = f"The stats package · {len(f['awards'])} awards"
    trophies = (f'<section class="seg" aria-labelledby="tro-h">{bumper("tro-h", "Trophies", count, note(3, SCRIBBLE))}'
                + (f'<h3 class="sr">The big stuff</h3><div class="aws aws-big">{big}</div>' if big else "")
                + (f'<h3 class="sub">Other fun stats</h3><div class="aws aws-more">{more}</div>' if more else "")
                + "</section>")

    games = "".join(
        f'<article class="sb"><h3 class="sr">{e(g["win"]["team"])} beat {e(g["lose"]["team"])}</h3>'
        f'<p class="sb-top"><span class="chip">Final</span><span>Game {i}</span><span class="sb-m">+{g["margin"]:.2f}</span></p>'
        f'{bug_row(g["win"]["team"], g["win"]["pts"], "win", "{:.2f}")}{bug_row(g["lose"]["team"], g["lose"]["pts"], "lose", "{:.2f}")}'
        f'<p class="sb-duel"><span class="k">Top guns</span><span>{e(g["win"]["top"]["player"])} <b>{g["win"]["top"]["pts"]:.1f}</b></span>'
        f'<span><i>vs</i>{e(g["lose"]["top"]["player"])} <b>{g["lose"]["top"]["pts"]:.1f}</b></span></p>'
        f'{line("game_lines", i, "sb-line")}</article>'
        for i, g in enumerate(f["games"], 1))
    scoreboard = (f'<section class="seg" aria-labelledby="sb-h">{bumper("sb-h", "Scoreboard", f"Week {wk} finals", note(4, SCRIBBLE))}'
                  f'<div class="bugs">{games}</div></section>')

    upcoming = ""
    n = f.get("next")
    if n:
        def preview(i, g):
            a, b = g.get("a_proj"), g.get("b_proj")
            fav = "a" if (a or 0) > (b or 0) else "b" if (b or 0) > (a or 0) else ""
            return (f'<article class="sb pre"><h3 class="sr">{e(g["a"])} vs {e(g["b"])}</h3>'
                    f'<p class="sb-top"><span class="chip">Wk {n["week"]}</span><span>Projected</span></p>'
                    f'{bug_row(g["a"], a, "fav" if fav == "a" else "", "{:.1f}")}'
                    f'{bug_row(g["b"], b, "fav" if fav == "b" else "", "{:.1f}")}{line("preview_lines", i, "sb-line")}</article>')

        psa = "".join(f'<li><span class="st">{e(x["status"])}</span><span><b>{e(x["player"])}</b> in the {e(x["team"])} lineup</span></li>'
                      for x in n.get("psa") or [])
        psa = f'<aside class="psa" aria-labelledby="psa-h"><h3 id="psa-h">Lineup PSA</h3><ul>{psa}</ul></aside>' if psa else ""
        next_title = f"Week {n['week']}"
        upcoming = (f'<section class="seg" aria-labelledby="next-h">{bumper("next-h", next_title, "Coming up · projected")}'
                    f'<div class="bugs">{"".join(preview(i, g) for i, g in enumerate(n["games"], 1))}{psa}</div></section>')

    cut, rows = f.get("playoff_teams") or 0, []
    for i, s in enumerate(f["standings"], 1):
        rows.append(f'<tr{" class=in" if i <= cut else ""}><th scope="row"><span class="rk">{i}</span>{e(s["team"])}</th>'
                    f'<td>{s["w"]}-{s["l"]}{"-" + str(s["t"]) if s["t"] else ""}</td><td>{s["pf"]:.2f}</td><td>{s["pa"]:.2f}</td>'
                    f'<td>{s["all_play"]}</td><td class="{"pos" if s["luck"] > 0 else "neg"}">{s["luck"]:+.2f}</td>'
                    f'<td>{s["bench_left"]:.1f}</td></tr>')
        if i == cut < len(f["standings"]):
            rows.append(f'<tr class="cut"><td colspan="7"><span>Playoff line · top {cut} get in</span></td></tr>')
    teams_wk = sorted((t for g in f["games"] for t in (g["win"], g["lose"])), key=lambda t: -t["eff"])
    report = "".join(
        f'<tr><th scope="row">{e(t["team"])}</th><td>{t["pts"]:.2f}</td><td>{t["opt"]:.2f}</td>'
        f'<td>{t["opt"] - t["pts"]:.2f}</td><td class="eff">{t["eff"]:g}%<span style="--p:{t["eff"]:g}%"></span></td></tr>'
        for t in teams_wk)
    nerd = (f'<section class="seg" aria-labelledby="nerd-h">{bumper("nerd-h", "Nerd Corner", "Standings & lineup math", note(5, SCRIBBLE))}'
            f'<details class="fold"><summary><span><span class="if-shut">Show</span><span class="if-open">Hide</span> the standings and lineup math</span></summary><div class="boards"><div class="scroll" tabindex="0" role="region" aria-label="Standings table">'
            f'<table class="standings"><caption>Standings</caption><thead><tr><th scope="col">Team</th><th scope="col">W-L</th>'
            f'<th scope="col">PF</th><th scope="col">PA</th><th scope="col" title="Record if you played every team every week">All-play</th>'
            f'<th scope="col" title="Wins above what your all-play rate predicts">Luck</th>'
            f'<th scope="col" title="Season points left on the bench">Benched</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
            f'<div class="scroll" tabindex="0" role="region" aria-label="Lineup report table"><table class="report">'
            f'<caption>Lineup report, week {wk}</caption><thead><tr><th scope="col">Team</th><th scope="col">Pts</th>'
            f'<th scope="col">Max</th><th scope="col">Left</th><th scope="col">Eff</th></tr></thead><tbody>{report}</tbody></table></div>'
            f'</div></details></section>')

    archive = "".join(
        f'<li><a href="{week_url(d["facts"])}"{" aria-current=page" if i == here else ""}>'
        f'<span class="arc-wk">Wk {d["facts"]["week"]}</span>{e(d["copy"].get("headline") or "")}</a></li>'
        for i, d in reversed(list(enumerate(data))))
    signoff = f'<p class="pen signoff">{e(c["signoff"])}{SCRIBBLE}</p>' if c.get("signoff") else ""
    body = (f'<header class="mast"><div class="mast-in"><p class="mark" aria-hidden="true">{e(mark)}</p>'
            f'<p class="brand"><b>{e(league)}</b><span>{e(str(f["season"]))} season recap</span></p>{week_nav}</div></header>'
            f'<main>{lead}{rundown}{rankings}{trophies}{scoreboard}{upcoming}{nerd}</main>'
            f'<footer class="foot">{signoff}'
            f'<nav aria-labelledby="arc-h"><h2 id="arc-h" class="foot-h">Previously on {e(league)}</h2><ul class="archive">{archive}</ul></nav>'
            f'<p class="fine">Numbers from Sleeper. Jokes from Claude. Updates Tuesday mornings.</p></footer>')
    # Pun first: iMessage shows only the preview image and a line or two of title.
    title = f"{head} · {brand} Week {wk}" if head else f"{brand} Week {wk}"
    alt = " ".join(x for x in (f"Week {wk}: {head}." if head else f"Week {wk}.",
                               f"The number: {value}, circled in red marker." if value else "", cap) if x)
    return (shell.replace("{{title}}", e(title)).replace("{{description}}", e(dek))
            .replace("{{image}}", e(url + "og.jpg")).replace("{{image_alt}}", e(alt))
            .replace("{{url}}", e(url)).replace("{{brand}}", e(brand)).replace("{{body}}", body))


# 540px master for the 180x180 apple-touch-icon: the masthead's yellow slab on the broadcast black. The workflow
# screenshots it when a site doesn't commit an icon of its own.
ICON = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@1,62..100,900&display=block">
<style>html, body { margin: 0; width: 540px; height: 540px; background: #0B0C0E; } body { display: grid; place-items: center; }
.mark { display: grid; place-items: center; width: 420px; height: 330px; padding-right: 6px; background: #FFD20A; color: #0B0C0E;
font: italic 900 214px/1 "Archivo", sans-serif; font-stretch: 62%; letter-spacing: -.02em;
clip-path: polygon(72px 0, 100% 0, calc(100% - 72px) 100%, 0 100%); }</style></head>
<body><div class="mark">{mark}</div></body></html>"""


def render_site(store, site, out="docs", root="."):
    """Every saved week as a page at /<season>/<week>/, the newest one at /, plus link-preview cards."""
    shell = files("fantasy_recap").joinpath("templates/page.html").read_text()
    data = store.all()
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for d in data:
        f = d["facts"]
        url = f"{site}{f['season']}/{f['week']}/"
        dest = out / f["season"] / str(f["week"]) / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        doc = page(shell, f, d["copy"], url, data, site)
        dest.write_text(doc)
        # The link-preview card: the same page in card mode, without the show-open script. The workflow screenshots
        # it to og.jpg (every page's og:image) and deletes it before deploying.
        card = doc.replace('<html lang="en">', '<html lang="en" class="card">', 1)
        (dest.parent / "card.html").write_text(re.sub(r"<script>.*?</script>", "", card, count=1, flags=re.S))
    if not data:  # a brand-new site before its first recap
        (out / "index.html").write_text("<!doctype html><meta charset=utf-8><title>Coming soon</title>"
                                        "<p style='font:20px system-ui;padding:2rem'>The first recap lands after this week's games.</p>")
        return
    f, c = data[-1]["facts"], data[-1]["copy"]
    (out / "index.html").write_text(page(shell, f, c, f"{site}{f['season']}/{f['week']}/", data, site))
    icon = Path(root) / "apple-touch-icon.png"  # iMessage and Slack show it beside links; also the home-screen icon
    if icon.exists():
        shutil.copyfile(icon, out / icon.name)
    else:
        mark = "".join(w[:1] for w in f["league"].split()[:2]).upper()
        (out / "icon.html").write_text(ICON.replace("{mark}", html.escape(mark)))
