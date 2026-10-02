"""Claude writes the jokes: web research for real plays, a draft, then a punch-up pass. Structured JSON out."""
import json
import os
from importlib.resources import files

from .config import display_name

MODEL = "claude-opus-5-5"

LINES = {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["key", "line"],
                                    "properties": {"key": {"type": "string"}, "line": {"type": "string"}}}}
SCHEMA = {"type": "object", "additionalProperties": False,
          "required": ["headline", "dek", "hero_value", "hero_caption", "pen_notes", "story_title", "story", "power_lines",
                       "award_lines", "game_lines", "preview_lines", "signoff"],
          "properties": {"headline": {"type": "string"}, "dek": {"type": "string"},
                         "hero_value": {"type": "string"}, "hero_caption": {"type": "string"},
                         "pen_notes": {"type": "array", "items": {"type": "string"}},
                         "story_title": {"type": "string"},
                         "story": {"type": "array", "items": {"type": "string"}}, "power_lines": LINES,
                         "award_lines": LINES, "game_lines": LINES,
                         "preview_lines": LINES, "signoff": {"type": "string"}}}


WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 8}


def research(client, facts):
    """Best effort: web-search the week's real NFL moments (big plays, bloopers, memes) for players in this league."""
    who = {}
    for team, lineup in facts["lineups"].items():
        for x in lineup["started"] + [b for b in lineup["bench"] if b["pts"] >= 15]:
            who.setdefault(x["player"], team)
    ask = (f"NFL Week {facts['week']} of the {facts['season']} season just finished. Search the web for the real-life moments fans "
           "are talking about: huge plays, bloopers, bizarre moments, viral memes, sideline drama. Focus on these players, who are "
           "on a fantasy league's rosters (their fantasy team in parentheses):\n" + "; ".join(f"{p} ({t})" for p, t in who.items())
           + "\n\nReply with up to 8 short bullets: the player, what happened, why people are talking about it, and one source URL. "
           "Only include on-field moments that the league, a team or an established sports outlet confirms. "
           "Skip injuries and anything off the field: legal, personal or health news.")
    messages = [{"role": "user", "content": ask}]
    for _ in range(5):  # a server-side search can pause mid-turn; resending the paused turn resumes it
        msg = client.messages.create(model=MODEL, max_tokens=16000, tools=[WEB_SEARCH], messages=messages,
                                     extra_body={"output_config": {"effort": "medium"}})
        if msg.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": msg.content}]
    return "".join(b.text for b in msg.content if b.type == "text").strip() or None


def write_copy(facts, previous=(), brief="", punchup=""):
    """Claude drafts the week, then a second pass punches it up. `previous` is this season's earlier copy."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("::warning::ANTHROPIC_API_KEY is not set, so this week gets template copy instead of jokes.")
        return template_copy(facts)
    try:
        import anthropic

        client = anthropic.Anthropic(max_retries=4)

        def ask(system, payload):
            # Streamed with room to think: 16k tokens ran out on a busy week and silently fell back to template copy.
            with client.beta.messages.stream(
                model=MODEL,
                max_tokens=128000,  # Opus 5.5's output ceiling; billed only for what's used
                betas=["server-side-fallback-2026-07-01"],
                system=system,
                messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                extra_body={"fallbacks": "default",
                            "output_config": {"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}}},
            ) as stream:
                msg = stream.get_final_message()
            if msg.stop_reason != "end_turn":
                raise RuntimeError(f"stop_reason={msg.stop_reason}")
            # After a mid-stream fallback the new model continues the partial text, so the JSON spans text blocks.
            return json.loads("".join(b.text for b in msg.content if b.type == "text")), msg.model

        try:
            news = research(client.with_options(timeout=300, max_retries=1), facts)  # best effort: never stall the run
        except Exception as e:  # the recap works without it
            print(f"::warning::Skipped the web research for real-life plays ({e}).")
            news = None
        prior = list(previous)
        draft, model = ask(brief, dict(facts=facts, previous_weeks=prior, news=news))
        try:
            final, model = ask(brief + "\n\n---\n\n" + punchup,
                               dict(facts=facts, previous_weeks=prior, news=news, draft=draft))
        except Exception as e:  # the draft is real copy already: ship it rather than plain labels
            print(f"::warning::The punch-up pass failed ({e}); shipping the draft.")
            return dict(draft, by=f"{model} (draft only)", news=news)
        return dict(final, by=f"{model} (draft + punch-up)", news=news)
    except Exception as e:  # ponytail: any failure falls back to template copy so the numbers still ship
        print(f"::warning::Claude couldn't write the copy ({e}); using template copy.")
        return template_copy(facts)


def template_copy(f):
    a = {x["key"]: x for x in f["awards"]}
    lead = a.get("heartbreaker") or a["high"]
    return dict(by="template", headline=lead["label"].upper(), dek=f"{lead['team']}: {lead['stat']}.",
                hero_value=a["high"]["stat"].split(" ")[0], hero_caption=f"{a['high']['team']} led the week",
                pen_notes=[], story_title="", story=[], power_lines=[], award_lines=[], game_lines=[], preview_lines=[], signoff="")


def prompts(facts, intro="", lore=()):
    """The writer's brief and the punch-up pass, filled in for one league."""
    brief, punchup = (files("fantasy_recap").joinpath(f"prompts/{n}.md").read_text() for n in ("writer", "punchup"))
    kind = " ".join(x for x in (f"{len(facts['teams'])}-team", facts.get("scoring"), "fantasy football league") if x)
    intro = intro or f"You write the weekly recap for {display_name(facts['league'])}, a {kind} of friends on Sleeper."
    n = sum(bool(t.get("commish")) for t in facts["teams"])
    commish = ([] if not n else ["The commissioner is the team with `commish: true`."] if n == 1
               else [f"The commissioners are the teams with `commish: true` (there are {n})."])
    lines = "\n".join(f"- {x}" for x in [*lore, *commish])
    return brief.replace("{{intro}}", intro).replace("{{lore}}", lines), punchup
