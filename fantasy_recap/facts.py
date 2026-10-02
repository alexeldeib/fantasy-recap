"""League data -> facts: games, trophies, gems, standings, power rankings. Pure computation, no network."""
import re
import sys
from collections import defaultdict

FLEX = {"FLEX": {"RB", "WR", "TE"}, "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
        "REC_FLEX": {"WR", "TE"}, "WRRB_FLEX": {"WR", "RB"}}
HURT = {"Out", "IR", "Doubtful", "Sus", "PUP", "NA"}
STATS = [("pass_yd", "pass yds"), ("pass_td", "pass TD"), ("pass_int", "INT"), ("rush_yd", "rush yds"),
         ("rush_td", "rush TD"), ("rec", "rec"), ("rec_yd", "rec yds"), ("rec_td", "rec TD"),
         ("fum_lost", "fumbles lost")]


def pairs(matchups):
    games = defaultdict(list)
    for m in matchups:
        if m.get("matchup_id"):
            games[m["matchup_id"]].append(m)
    return [g for _, g in sorted(games.items()) if len(g) == 2]


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def build(sl, week=None):
    """Everything the page and the writer need for one week, computed from one league's Sleeper data."""
    lg, users, rosters = sl.league(), sl.users(), sl.rosters()
    P = sl.players()
    season, cfg = lg["season"], lg["settings"]
    week = int(week or cfg.get("last_scored_leg") or 0)
    if week < 1:
        sys.exit("No scored weeks yet.")
    slots = [s for s in lg["roster_positions"] if s not in ("BN", "IR", "TAXI")]
    pts_key = {1: "pts_ppr", 0.5: "pts_half_ppr"}.get(lg["scoring_settings"].get("rec", 0), "pts_std")

    user = {u["user_id"]: u for u in users}
    teams, team = [], {}
    for r in sorted(rosters, key=lambda r: r["roster_id"]):
        u = user.get(r["owner_id"]) or {}
        manager = u.get("display_name") or f"team{r['roster_id']}"
        team[r["roster_id"]] = (u.get("metadata") or {}).get("team_name") or manager
        avatar = (u.get("metadata") or {}).get("avatar") or (
            u.get("avatar") and f"https://sleepercdn.com/avatars/thumbs/{u['avatar']}")
        teams.append(dict(team=team[r["roster_id"]], manager=manager, avatar=avatar, commish=bool(u.get("is_owner"))))

    def info(pid):
        return P.get(pid) or {}

    def fits(pid, slot):
        p = info(pid)
        return bool(set(p.get("fantasy_positions") or [p.get("position") or "DEF"]) & FLEX.get(slot, {slot}))

    def name(pid):
        p = info(pid)
        if pid == "0":
            return "an empty slot"
        if p.get("position") == "DEF" or not p.get("last_name"):
            return f"{pid} D/ST"
        return f"{p['first_name'][:1]}. {p['last_name']}"

    def optimal(pp):
        # ponytail: fill the pickiest slots first. Exact when slots nest (QB < FLEX < SUPER_FLEX);
        # overlapping flexes (REC_FLEX vs WRRB_FLEX) can come up a hair short.
        left, total = dict(pp), 0.0
        for slot in sorted(slots, key=lambda s: len(FLEX.get(s, {s}))):
            best = max((p for p in left if fits(p, slot)), key=left.get, default=None)
            if best is not None:
                total += left.pop(best)
        return round(total, 2)

    # Season to date: record, all-play, bench points left.
    weekly = {w: sl.matchups(w) for w in range(1, week + 1)}
    last_regular = min(week, cfg.get("playoff_week_start", 99) - 1)
    rec = {rid: dict(w=0, l=0, t=0, hw=0, h2h=0, pf=0.0, pa=0.0, ap_w=0, ap_l=0, bench=0.0, weeks=[]) for rid in team}
    snaps = {}  # week -> {rid: (all-play win rate, points for)} through that week
    for w in range(1, last_regular + 1):
        ms = [m for m in weekly[w] if m.get("matchup_id")]
        score = {m["roster_id"]: m["points"] for m in ms}
        for m in ms:
            r, others = rec[m["roster_id"]], [v for k, v in score.items() if k != m["roster_id"]]
            r["pf"] += m["points"]
            r["weeks"].append(m["points"])
            r["bench"] += optimal(m["players_points"]) - m["points"]
            r["ap_w"] += sum(m["points"] > v for v in others)
            r["ap_l"] += sum(m["points"] < v for v in others)
        for a, b in pairs(ms):
            for x, y in ((a, b), (b, a)):
                r = rec[x["roster_id"]]
                r["pa"] += y["points"]
                r["h2h"] += 1
                r["hw"] += x["points"] > y["points"]
                r["w" if x["points"] > y["points"] else "l" if x["points"] < y["points"] else "t"] += 1
        if cfg.get("league_average_match"):
            v = sorted(score.values())
            median = (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
            for rid, p in score.items():
                rec[rid]["w" if p > median else "l"] += 1
        snaps[w] = {rid: (r["ap_w"] / max(1, r["ap_w"] + r["ap_l"]), r["pf"]) for rid, r in rec.items()}
    standings = []
    for rid, r in rec.items():
        ap = r["ap_w"] + r["ap_l"]
        standings.append(dict(team=team[rid], w=r["w"], l=r["l"], t=r["t"], pf=round(r["pf"], 2), pa=round(r["pa"], 2),
                              all_play=f"{r['ap_w']}-{r['ap_l']}", bench_left=round(r["bench"], 1),
                              pa_per_game=round(r["pa"] / r["h2h"], 1) if r["h2h"] else 0,
                              luck=round(r["hw"] - (r["ap_w"] / ap * r["h2h"] if ap else 0), 2), weekly_scores=r["weeks"]))
    standings.sort(key=lambda s: (s["w"] + s["t"] / 2, s["pf"]), reverse=True)

    # This week, per team.
    stats = sl.stats(season, week)
    proj = {x["player_id"]: (x.get("stats") or {}).get(pts_key) or 0 for x in sl.projections(season, week)}

    def line(pid):
        s = stats.get(pid) or {}
        return ", ".join(f"{s[k]:g} {label}" for k, label in STATS if s.get(k))

    ms = [m for m in weekly[week] if m.get("matchup_id")]
    card, lineups = {}, {}
    for m in ms:
        rid, pp, st = m["roster_id"], m["players_points"], m["starters"]
        bench = [p for p in m["players"] if p not in st]
        opt = optimal(pp)
        gain, b, s = max(((pp.get(b, 0) - pp.get(s, 0), b, s)
                          for s, slot in zip(st, slots) for b in bench if fits(b, slot)), default=(0, None, None))
        top = max((p for p in st if p != "0"), key=lambda p: pp.get(p, 0))
        card[rid] = dict(
            team=team[rid], pts=m["points"], opt=opt, eff=round(100 * m["points"] / opt, 1) if opt else 100.0,
            proj=round(sum(proj.get(p, 0) for p in st), 1) if proj else None,
            bench_pts=round(sum(pp.get(p, 0) for p in bench), 2),
            top=dict(player=name(top), pts=pp.get(top, 0)),
            swap=dict(bench=name(b), bench_pts=pp.get(b, 0), start=name(s), start_pts=pp.get(s, 0),
                      gain=round(gain, 2)) if gain > 0 else None)
        lineups[team[rid]] = dict(
            started=[dict(slot=slot, player=info(p).get("full_name") or name(p), pts=pp.get(p, 0), proj=proj.get(p), line=line(p))
                     for p, slot in zip(st, slots) if p != "0"],
            bench=[dict(player=info(p).get("full_name") or name(p), pos=info(p).get("position"), pts=pp.get(p, 0), line=line(p)) for p in bench])
    games = []
    for a, b in pairs(ms):
        if a["points"] < b["points"]:
            a, b = b, a
        games.append(dict(win=card[a["roster_id"]], lose=card[b["roster_id"]], margin=round(a["points"] - b["points"], 2)))

    # Trophies: the numbers are picked here; Claude only writes the jokes.
    awards = []

    def award(key, emoji, label, who, stat, vs=None):
        awards.append(dict(key=key, emoji=emoji, label=label, team=who, stat=stat, vs=vs))

    def swap_vs(sw):
        return sw and dict(a=sw["bench"], a_pts=sw["bench_pts"], a_tag="bench",
                           b=sw["start"], b_pts=sw["start_pts"], b_tag="started")

    def vs_proj(t):
        return f" ({t['pts'] - t['proj']:+.1f} vs proj)" if t.get("proj") else ""

    ranked = sorted(card.values(), key=lambda t: -t["pts"])
    blow, close = max(games, key=lambda g: g["margin"]), min(games, key=lambda g: g["margin"])
    award("blowout", "💣", "Biggest domination", blow["win"]["team"],
          f"by {blow['margin']:.2f} over {blow['lose']['team']}")
    award("high", "🥇", "Top score", ranked[0]["team"], f"{ranked[0]['pts']:.2f}{vs_proj(ranked[0])}")
    award("low", "💩", "Biggest loser", ranked[-1]["team"], f"{ranked[-1]['pts']:.2f}{vs_proj(ranked[-1])}")
    award("close", "🤏", "Closest game", close["win"]["team"], f"by {close['margin']:.2f} over {close['lose']['team']}")
    flips = [(g["lose"]["swap"]["gain"] - g["margin"], g) for g in games
             if g["lose"]["swap"] and g["lose"]["swap"]["gain"] > g["margin"]]
    if flips:
        by, g = min(flips, key=lambda x: x[0])
        award("heartbreaker", "💔", "Heartbreaker", g["lose"]["team"],
              f"lost by {g['margin']:.2f}, one swap from winning by {by:.2f}", swap_vs(g["lose"]["swap"]))
    best = max(ranked, key=lambda t: (t["eff"], t["pts"]))
    worst = min(ranked, key=lambda t: (t["eff"], t["pts"]))
    award("best_mgr", "🔥", "Best manager", best["team"], f"{best['eff']:g}% of max ({best['opt']:.2f})")
    award("worst_mgr", "🤡", "Worst manager", worst["team"], f"{worst['eff']:g}% of max ({worst['opt']:.2f})",
          swap_vs(worst["swap"]))
    deep = max(ranked, key=lambda t: t["bench_pts"])
    award("best_bench", "🪑", "Best bench", deep["team"], f"{deep['bench_pts']:.2f} on the bench")
    starts = [(m["players_points"].get(p, 0), p, m["roster_id"]) for m in ms for p in m["starters"] if p != "0"]
    pts, pid, rid = max(starts)
    award("mvp", "💪", "Best player", team[rid], f"{name(pid)} {pts:.2f}")
    pts, pid, m = max(((m["players_points"].get(p, 0), p, m) for m in ms for p in m["players"]
                       if p not in m["starters"]), key=lambda x: x[:2])
    sat = min(((m["players_points"].get(s, 0), s) for s, slot in zip(m["starters"], slots) if fits(pid, slot)),
              default=None)
    award("bench_mvp", "🛋️", "Bench MVP", team[m["roster_id"]], f"{name(pid)} {pts:.2f}",
          sat and dict(a=name(pid), a_pts=pts, a_tag="bench", b=name(sat[1]), b_pts=sat[0], b_tag="started"))
    diffs = [(p - proj[pid], p, pid, rid) for p, pid, rid in starts if proj.get(pid)]
    if diffs:
        d, p, pid, rid = max(diffs)
        award("over", "📈", "Overachiever", team[rid], f"{name(pid)} {p:.2f}, {d:+.1f} vs proj")
        d, p, pid, rid = min(diffs)
        award("under", "👎", "Underachiever", team[rid], f"{name(pid)} {p:.2f}, {d:+.1f} vs proj")
    lucky = min((g["win"] for g in games), key=lambda t: t["pts"])
    unlucky = max((g["lose"] for g in games), key=lambda t: t["pts"])
    award("lucky", "🍀", "Lucky", lucky["team"], f"won with the {ordinal(ranked.index(lucky) + 1)}-best score")
    award("unlucky", "😡", "Unlucky", unlucky["team"], f"lost with the {ordinal(ranked.index(unlucky) + 1)}-best score")

    # Gems: cross-roster comparisons a model won't reliably compute on its own.
    gems = []
    scores = sorted((t["pts"], t["team"]) for t in card.values())
    low_pts, low_team = scores[0]
    for t in card.values():
        beaten = [n for p, n in scores if p < t["bench_pts"] and n != t["team"]]
        if beaten:
            gems.append(f"{t['team']}'s bench ({t['bench_pts']:.2f}) outscored these whole lineups: {', '.join(beaten)}")
        elif t["team"] != low_team and low_pts - t["bench_pts"] < 10:
            gems.append(f"{t['team']}'s bench ({t['bench_pts']:.2f}) finished {low_pts - t['bench_pts']:.2f} "
                        f"behind {low_team}'s whole lineup ({low_pts:.2f})")
    low_rid = next(rid for rid, t in card.items() if t["team"] == low_team)
    low_starts = sorted(p for p, _, rid in starts if rid == low_rid)
    for pts, pid, rid in sorted(starts, reverse=True)[:3]:
        k, total = 0, 0.0
        while k < len(low_starts) and total + low_starts[k] < pts:
            total += low_starts[k]
            k += 1
        if k >= 2 and rid != low_rid:
            gems.append(f"{name(pid)} ({pts:.2f}, {team[rid]}) outscored {low_team}'s {k} lowest starters combined ({total:.2f})")
    game_of = {t["team"]: i for i, g in enumerate(games) for t in (g["win"], g["lose"])}
    near = min(((abs(a[0] - b[0]), a, b) for i, a in enumerate(scores) for b in scores[i + 1:]
                if game_of[a[1]] != game_of[b[1]]), default=None)
    if near:
        gems.append(f"{near[1][1]} ({near[1][0]:.2f}) and {near[2][1]} ({near[2][0]:.2f}) finished {near[0]:.2f} apart in different games")
    for g in games:
        if g["win"]["proj"] and g["win"]["proj"] == g["lose"]["proj"]:
            gems.append(f"{g['win']['team']} and {g['lose']['team']} were both projected for {g['win']['proj']}, "
                        f"then finished {g['margin']:.2f} apart")
    same_name = defaultdict(set)
    for m in ms:
        for p in m["players"]:
            same_name[name(p)].add((p, team[m["roster_id"]], m["players_points"].get(p, 0)))
        words = {re.sub(r"'s$", "", w).lower() for w in re.findall(r"[A-Za-z']{4,}", team[m["roster_id"]])}
        for mm in ms:
            for p in mm["players"]:
                pts, started = mm["players_points"].get(p, 0), p in mm["starters"]
                notable = pts >= 20 or (started and pts <= 5) or (not started and pts >= 15)  # only when the namesake did something
                if notable and {info(p).get("first_name", "").lower(), info(p).get("last_name", "").lower()} & words:
                    how = "started" if p in mm["starters"] else "benched"
                    gems.append(f"{team[m['roster_id']]} shares a name with {info(p).get('full_name')}, who scored "
                                f"{mm['players_points'].get(p, 0):.2f} ({how}) for {team[mm['roster_id']]}")
    gems += [f"Two players named {n}, on " + " and ".join(sorted(t for _, t, _ in v))
             for n, v in same_name.items() if len(v) > 1 and max(pts for *_, pts in v) >= 20]

    pickups = []
    for t in sl.transactions(week):
        if t.get("status") == "complete":
            for pid, rid in (t.get("adds") or {}).items():
                m = next((m for m in ms if m["roster_id"] == rid), None)
                pickups.append(dict(team=team[rid], player=name(pid), bid=(t.get("settings") or {}).get("waiver_bid"),
                                    pts=m["players_points"].get(pid, 0) if m else 0,
                                    started=bool(m) and pid in m["starters"]))
    spend = max((x for x in pickups if x["bid"]), key=lambda x: x["bid"], default=None)
    if spend:
        award("big_spender", "💸", "Big spender", spend["team"],
              f"${spend['bid']} on {spend['player']}, {spend['pts']:.1f} pts")

    # Next week: pairings, projections for the lineups as currently set, and lineup PSAs.
    nxt = None
    # Only the latest week gets a preview: lineups and injury tags are live data, wrong for past weeks.
    latest = week == int(cfg.get("last_scored_leg") or 0)
    upcoming = [m for m in sl.matchups(week + 1, fallback=[]) if m.get("matchup_id")] if latest else []
    if upcoming:
        nproj = {x["player_id"]: (x.get("stats") or {}).get(pts_key) or 0
                 for x in sl.projections(season, week + 1)}
        playing = {t for g in sl.schedule(season)
                   if g.get("week") == week + 1 for t in (g.get("home"), g.get("away"))}
        lineup = {r["roster_id"]: [p for p in r.get("starters") or [] if p != "0"] for r in rosters}

        def projected(rid):
            return round(sum(nproj.get(p, 0) for p in lineup[rid]), 1) if nproj else None

        psa = [dict(team=team[rid], player=name(p), status=info(p).get("injury_status") or "no game")
               for rid, st in lineup.items() for p in st
               if info(p).get("injury_status") in HURT or (playing and info(p).get("team") not in playing)]
        nxt = dict(week=week + 1, psa=psa, games=[
            dict(a=team[a["roster_id"]], b=team[b["roster_id"]], a_proj=projected(a["roster_id"]),
                 b_proj=projected(b["roster_id"])) for a, b in pairs(upcoming)])

    # Power rankings: season all-play win rate, then points for. Movement is vs the week before.
    def order(w):
        return sorted(snaps.get(w, {}), key=lambda rid: snaps[w][rid], reverse=True)
    now, before = order(last_regular), order(last_regular - 1)
    power = [dict(rank=i, team=team[rid], prev=before.index(rid) + 1 if before else None,
                  record=f"{rec[rid]['w']}-{rec[rid]['l']}" + (f"-{rec[rid]['t']}" if rec[rid]["t"] else ""),
                  all_play=f"{rec[rid]['ap_w']}-{rec[rid]['ap_l']}", pf=round(rec[rid]["pf"], 2),
                  this_week=card[rid]["pts"] if rid in card else None) for i, rid in enumerate(now, 1)]

    return dict(league=lg["name"], season=season, week=week, playoff_teams=cfg.get("playoff_teams"), teams=teams,
                scoring={"pts_ppr": "full-PPR", "pts_half_ppr": "half-PPR"}.get(pts_key, "standard"),
                power=power, games=games, awards=awards, gems=gems, lineups=lineups, pickups=pickups, standings=standings,
                next=nxt)
