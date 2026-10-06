// Facts + copy -> the broadcast-style recap page. Ported line for line from the original Python engine: with no
// `extra`, recorded weeks render the same bytes that engine did (test/golden.test.ts checks).
import type { J } from "./facts.ts";
import { esc as e, first, fixed, fsum, g, signed, sortBy, W, words } from "./py.ts";

export const BIG = new Set(["blowout", "high", "low", "close", "heartbreaker"]); // every other trophy is an "other fun stat"
const AT = new RegExp(`@${W}+`, "gu"); // @mentions get lit up in running text
const NUM = new RegExp(String.raw`(?<![\p{L}\p{N}_.])[-+$]?\p{Nd}+(?:[.,]\p{Nd}+)*(?:%|st|nd|rd|th)?(?![\p{L}\p{N}_])`, "gu");

/** The league's own name, minus any emoji: "La Liga 🏈" -> "La Liga". */
export const displayName = (name: string): string => name.replace(/[^\p{L}\p{N}_\s'’().&-]/gu, "").trim() || name;

/** Rough width of s set in the display caps, in em, so big type can be sized to fit its column. */
export const ems = (s: string): number =>
  fsum([...s.toUpperCase()].map((ch) => (ch === " " ? .11 : "I1.,:;'’!|".includes(ch) ? .27 : "@MW%".includes(ch) ? .73 : .53)));

/** Advance width of s in the LED numerals (Big Shoulders Display Black), in em. */
const ledEms = (s: string): number =>
  fsum([...s].map((ch) => ("1.,:".includes(ch) ? .27 : ch === "-" ? .45 : ch === "%" ? .68 : ch === " " ? .22 : .5)));

const copysign = (x: number, y: number) => (y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x));

/** The telestrator loop around the hero number: a rounded oval (semi-axes a, b in em) drawn in one stroke that spirals a
 *  little past where it started. Returns the viewBox width, height and path, in hundredths of an em. */
function ring(a: number, b: number): [number, number, string] {
  const grow = 1.075, s = 7; // how far the loop spirals out by the end, and room for the stroke
  const w = 2 * (a * grow * 100 + s), h = 2 * (b * grow * 100 + s);
  const pts: [number, number][] = [];
  for (let i = 0; i < 31; i++) {
    const t = (-50 - 410 * i / 30) * (Math.PI / 180);
    const c = Math.cos(t), n = Math.sin(t);
    const r = (1 + .055 * i / 30) * (1 + .015 * Math.sin(2.5 * t));
    pts.push([w / 2 + a * 100 * r * copysign(Math.abs(c) ** .8, c), h / 2 + b * 100 * r * copysign(Math.abs(n) ** .8, n)]);
  }
  const f0 = (x: number) => fixed(x, 0);
  let d = `M${f0(pts[0]![0])} ${f0(pts[0]![1])}`;
  for (let i = 0; i < 30; i++) { // Catmull-Rom through the points, as cubic Beziers
    const [p0, p1, p2, p3] = [pts[Math.max(i - 1, 0)]!, pts[i]!, pts[i + 1]!, pts[Math.min(i + 2, 30)]!];
    d += ` C${[p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, ...p2].map(f0).join(" ")}`;
  }
  return [w, h, d];
}

export const ARROW = '<svg class="arrow" viewBox="0 0 44 30" aria-hidden="true" focusable="false">'
  + '<path pathLength="1" d="M42 3 C30 5 16 12 7 26 M17 25 L7 27 L6 17"/></svg>';
export const SCRIBBLE = '<svg class="scrib" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
  + '<path d="M3 8 C28 3 52 10 78 5 S108 3 117 7"/></svg>';

/** Escape, then light up numbers (or @names): the shared running-text treatment. */
export const lit = (s: string, pattern: RegExp = NUM, hit = ""): string =>
  e(s, false).replace(pattern, (m) => (m === hit ? `<b class="hit">${m}</b>` : `<b>${m}</b>`));
export const litAt = (s: string): string => lit(s, AT);

/** Widest word, so CSS can shrink a long name instead of breaking it mid-word. */
export const fit = (name: string): string => fixed(Math.max(...(words(name).length ? words(name) : [""]).map(ems)), 2);

/** A playoff game's name, with its leg in a two-week round: "Championship · leg 1 of 2". */
export const stageLabel = (st: J): string => (st.leg ? `${st.name} · leg ${st.leg} of ${st.legs}` : st.name);

export const bumper = (hid: string, title: string, kicker: string, pen = ""): string =>
  `<div class="bump"><h2 id="${hid}"><span>${e(title)}</span></h2><p class="bump-k">${e(kicker)}</p>${pen}</div>`;

/** Where the hosted version adds to a page: a banner atop <main>, sections after it, and its own footer line. */
export interface Extra { banner?: string; tail?: string; fine?: string }

/** `data` is every saved week of the league, oldest first; only facts.season, facts.week and copy.headline are read. */
export function page(shell: string, f: J, c: J, url: string, data: J[], site: string, extra: Extra = {}): string {
  const who = new Map<string, J>(f.teams.map((t: J) => [t.team, t]));
  const lines: Record<string, Record<string, string>> = {};
  for (const k of ["award_lines", "game_lines", "preview_lines", "power_lines"]) {
    lines[k] = Object.fromEntries((c[k] || []).map((x: J) => [x.key, x.line]));
  }
  const notes = (c.pen_notes || []).map((n: string) => (n || "").trim()).map((n: string) => ([...n].length <= 22 ? n : "")); // marker notes stay short
  const wk = f.week, league: string = f.league;

  const note = (i: number, more = "") => (i < notes.length && notes[i] ? `<p class="pen">${e(notes[i])}${more}</p>` : "");
  const avatar = (team: string, size: number) => {
    const t = who.get(team) ?? {};
    if (t.avatar) return `<img class="av" src="${e(t.avatar)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
    return `<span class="av" aria-hidden="true">${e(first(team).toUpperCase())}</span>`;
  };
  const manager = (team: string): string => (who.get(team) ?? {}).manager || team;
  const lowerThird = (team: string, size: number) => {
    const mgr = manager(team);
    const sub = mgr !== team ? `<span class="l3-team">${e(team)}</span>` : "";
    return `<div class="l3">${avatar(team, size)}<p><span class="l3-name" style="--n:${fit("@" + mgr)}">@${e(mgr)}</span>${sub}</p></div>`;
  };

  const taped = new Set<string>(); // each tale of the tape runs once; the same swap under a second trophy reads like a bug
  const tape = (v: J) => {
    if (!v || taped.has(JSON.stringify([v.a, v.b]))) return "";
    taped.add(JSON.stringify([v.a, v.b]));
    const top = Math.max(v.a_pts, v.b_pts) || 1;
    return '<div class="tape">' + ["a", "b"].map((k) =>
      `<p class="tp tp-${k}"><span class="tp-tag">${e(v[k + "_tag"])}</span><span class="tp-name">${e(v[k])}</span>`
      + `<b class="tp-pts">${fixed(v[k + "_pts"], 2)}</b><span class="tp-bar" style="--p:${fixed(Math.max(v[k + "_pts"], 0) / top * 100, 0)}%">`
      + "</span></p>").join("") + "</div>";
  };
  const line = (kind: string, key: string | number, cls: string) => {
    const text = lines[kind]![String(key)];
    return text ? `<p class="${cls}">${litAt(text)}</p>` : ""; // @names light up, as in the Rundown
  };
  const bugRow = (team: string, pts: number | null, cls: string, digits: number) =>
    `<p class="sb-row ${cls}">${avatar(team, 34)}<span class="sb-t" style="--n:${fit(team)}">${e(team)}</span>`
    + `<b class="sb-s">${pts === null || pts === undefined ? "–" : fixed(pts, digits)}</b></p>`;

  // Week switcher: every saved week of this season, plus previous/next steps across all of them.
  const weekUrl = (x: J) => `${site}${x.season}/${x.week}/`;
  const weeks: J[] = data.map((d) => d.facts);
  const found = weeks.findIndex((x) => x.season === f.season && x.week === wk);
  const here = found < 0 ? null : found;
  const step = (i: number, cls: string, label: string) => {
    if (here === null || !(0 <= i && i < weeks.length)) return `<span class="step ${cls} off" aria-hidden="true"></span>`;
    return `<a class="step ${cls}" href="${weekUrl(weeks[i])}" rel="${cls}"><span class="sr">${label}: week ${weeks[i].week}</span></a>`;
  };
  const chips = weeks.map((x, i) => (x.season === f.season
    ? `<li><a href="${weekUrl(x)}"${i === here ? " aria-current=page" : ""}>Wk ${x.week}</a></li>` : "")).join("");
  const weekNav = `<nav class="weeks" aria-label="Weeks">${step((here ?? 0) - 1, "prev", "Previous")}`
    + `<ol class="wk-list" role="list">${chips}</ol>${step((here ?? 0) + 1, "next", "Next")}</nav>`;

  // Lead: headline, dek, and the stat graphic. The analyst's loop clears the digits' corners by 0.07em,
  // with more air above, below and to the sides; the board leaves room around the loop.
  const head: string = c.headline || "", value: string = c.hero_value || "", cap: string = c.hero_caption || "";
  let stat = "";
  if (value) {
    const x = (ledEms(value) - .08) / 2 + .07, y = .41 + .07; // half the digits' ink box, plus clearance
    const b = .64;
    const a = x / (1 - (y / b) ** 2.5) ** .4 / .985;
    const [w, h, d] = ring(a, b / .985);
    stat = `<div class="stat" style="--rw:${fixed(w / 100, 2)};--rh:${fixed(h / 100, 2)};--lp:${fixed((h / 100 + .2 - 1) / 2, 2)}">`
      + `<p class="stat-tab">The number</p>${note(0, ARROW)}`
      + `<div class="stat-box"><span class="led-glow"><span class="led">${e(value)}</span></span>`
      + `<svg class="ring" viewBox="0 0 ${fixed(w, 0)} ${fixed(h, 0)}" aria-hidden="true" focusable="false">`
      + `<path pathLength="1" d="${d}"/></svg></div>`
      + `${cap ? `<p class=stat-cap>${e(cap)}</p>` : ""}</div>`;
  }

  const crawlItem = (i: number, x: J) => {
    const quip = lines.game_lines![String(i)];
    const two = x.stage?.leg === 2; // a second leg's ticker shows the two-week totals that decided it
    return `<span class="ci"><b class="ci-k">${x.stage?.leg === 1 ? "Leg 1" : two ? "Agg" : "Final"}</b><span class="ci-t">${e(x.win.team)}</span>`
      + `<b class="ci-s">${fixed(two ? x.stage.win_total : x.win.pts, 2)}</b><span class="ci-t ci-l">${e(x.lose.team)}</span>`
      + `<b class="ci-s ci-l">${fixed(two ? x.stage.lose_total : x.lose.pts, 2)}</b>${quip ? `<span class=ci-q>${e(quip)}</span>` : ""}</span>`;
  };
  const reel = f.games.map((x: J, i: number) => crawlItem(i + 1, x)).join("");
  const secs = Math.max(30, Math.floor([...reel.replace(/<[^>]+>/g, "")].length / 8)); // about 65px a second
  const crawl = reel ? `<div class="crawl"><p class="crawl-k" aria-hidden="true">Finals</p>`
    + `<input type="checkbox" id="hold" class="hold-box"><label for="hold" class="hold"><span class="sr">Pause the scores ticker</span></label>`
    + `<div class="crawl-view" aria-hidden="true"><p class="crawl-track" style="--dur:${secs}s">`
    + `<span class="crawl-set">${reel}</span><span class="crawl-set">${reel}</span></p></div></div>` : "";
  // The dek follows the number, so a phone's first screen is the pun and the circled number; on wide screens the
  // grid puts it back under the headline. The card bug only shows on the link-preview card.
  const brand = displayName(league);
  const mark = words(league).slice(0, 2).map(first).join("").toUpperCase();
  const dek: string = c.dek || "";
  const lead = `<section class="lead" aria-labelledby="lead-h" data-wk="${wk}"><div class="lead-in"><div class="lead-copy">`
    + `<p class="kick">Week ${wk} · Top story</p>`
    + `<h1 id="lead-h" class="headline" style="--hw:${fixed(Math.max(...(words(head).length ? words(head) : [""]).map(ems)), 2)};--ht:${fixed(ems(head), 2)}">${e(head)}</h1>`
    + `<p class="card-bug" aria-hidden="true"><span class="mark">${e(mark)}</span>${brand}</p></div>`
    + `${stat}${dek ? `<p class=dek>${litAt(dek)}</p>` : ""}</div>${crawl}</section>`;

  // The Rundown: the lead segment, in the writer's words. Skipped when there's no story (template copy).
  const story = (c.story || []).filter((s: string) => s && s.trim()).map((s: string) => s.trim());
  const storyTitle = c.story_title ? `<h3 class="story-title">${e(c.story_title)}</h3>` : "";
  const rundown = story.length ? `<section class="seg rundown" aria-labelledby="run-h">${bumper("run-h", "The Rundown", `Week ${wk} · from the desk`, note(1, SCRIBBLE))}`
    + `<div class="story">${storyTitle}${story.map((s: string) => `<p>${litAt(s)}</p>`).join("")}</div></section>` : "";

  // Power rankings: all of them, with movement. The analyst circles the week's biggest climb.
  const power: J[] = f.power || [];
  const climbs = power.filter((p) => p.prev).map((p) => p.prev - p.rank);
  const topClimb = climbs.length ? Math.max(...climbs) : 0;
  const movement = (p: J) => {
    if (!p.prev) return '<span class="mv new">New</span>';
    const delta = p.prev - p.rank;
    if (delta) {
      const hot = delta === topClimb && topClimb >= 3 ? " hot" : "";
      const dir = delta > 0 ? "up" : "down";
      return `<span class="mv ${dir}${hot}"><span class="sr">${dir} </span>${Math.abs(delta)}</span>`;
    }
    return '<span class="mv same"><span class="sr">no change</span></span>';
  };
  const rankedRow = (p: J) => {
    const mgr = manager(p.team);
    // Joined with real spaces so a narrow screen can wrap between the parts (each part stays whole).
    const meta = [mgr !== p.team ? `@${mgr}` : "", p.record, p.all_play ? `${p.all_play} all-play` : ""]
      .filter(Boolean).map((x) => `<span>${e(x)}</span>`).join(" ");
    return `<li class="pr-row"><span class="pr-rk">${p.rank}</span>${movement(p)}${avatar(p.team, 44)}`
      + `<p class="pr-team"><b style="--n:${fit(p.team)}">${e(p.team)}</b></p><p class="pr-meta">${meta}</p>`
      + `${line("power_lines", p.team, "pr-line")}</li>`;
  };
  const rankings = power.length ? `<section class="seg power" aria-labelledby="pow-h">${bumper("pow-h", "Power Rankings", "All-play record, then points", note(2, SCRIBBLE))}`
    + `<ol class="pr" role="list">${power.map(rankedRow).join("")}</ol></section>` : "";

  // Trophies: the supporting stats package. The big stuff first, then the other fun stats.
  const award = (a: J) => {
    const big = BIG.has(a.key);
    return `<article class="aw${big ? " aw-big" : ""}"><h4 class="aw-tag"><span aria-hidden="true">${e(a.emoji)}</span>`
      + `${e(a.label)}</h4>${lowerThird(a.team, big ? 56 : 48)}<p class="aw-stat">${lit(a.stat, NUM, value)}</p>`
      + `${line("award_lines", a.key, "aw-line")}${tape(a.vs)}</article>`;
  };
  const big = f.awards.filter((a: J) => BIG.has(a.key)).map(award).join("");
  const more = f.awards.filter((a: J) => !BIG.has(a.key)).map(award).join("");
  const count = `The stats package · ${f.awards.length} awards`;
  const trophies = `<section class="seg" aria-labelledby="tro-h">${bumper("tro-h", "Trophies", count, note(3, SCRIBBLE))}`
    + (big ? `<h3 class="sr">The big stuff</h3><div class="aws aws-big">${big}</div>` : "")
    + (more ? `<h3 class="sub">Other fun stats</h3><div class="aws aws-more">${more}</div>` : "")
    + "</section>";

  const games = f.games.map((x: J, n: number) => {
    const i = n + 1, st = x.stage; // playoffs: after a first leg the leader only leads; a second leg is won on the total
    return `<article class="sb"><h3 class="sr">${e(x.win.team)} ${st?.leg === 1 ? "leads" : "beat"} ${e(x.lose.team)}${st?.leg === 2 ? " on aggregate" : ""}</h3>`
      + `<p class="sb-top"><span class="chip">${st?.leg === 1 ? "Leg 1" : "Final"}</span><span>${st ? e(stageLabel(st)) : `Game ${i}`}</span><span class="sb-m">+${fixed(x.margin, 2)}</span></p>`
      + `${bugRow(x.win.team, x.win.pts, "win", 2)}${bugRow(x.lose.team, x.lose.pts, "lose", 2)}`
      + (st?.leg === 2 ? `<p class="sb-left">Two-week total: ${fixed(st.win_total, 2)} to ${fixed(st.lose_total, 2)}</p>` : "")
      + `<p class="sb-duel"><span class="k">Top guns</span><span>${e(x.win.top.player)} <b>${fixed(x.win.top.pts, 1)}</b></span>`
      + `<span><i>vs</i>${e(x.lose.top.player)} <b>${fixed(x.lose.top.pts, 1)}</b></span></p>`
      + `${line("game_lines", i, "sb-line")}</article>`;
  }).join("");
  const scoreboard = `<section class="seg" aria-labelledby="sb-h">${bumper("sb-h", "Scoreboard", `Week ${wk} finals`, note(4, SCRIBBLE))}`
    + `<div class="bugs">${games}</div></section>`;

  let upcoming = "";
  const nx = f.next;
  if (nx) {
    const preview = (i: number, x: J) => {
      const a = x.a_proj ?? null, b = x.b_proj ?? null;
      const fav = (a || 0) > (b || 0) ? "a" : (b || 0) > (a || 0) ? "b" : "";
      return `<article class="sb pre"><h3 class="sr">${e(x.a)} vs ${e(x.b)}</h3>`
        + `<p class="sb-top"><span class="chip">Wk ${nx.week}</span><span>${x.stage ? e(stageLabel(x.stage)) : "Projected"}</span></p>`
        + `${bugRow(x.a, a, fav === "a" ? "fav" : "", 1)}`
        + `${bugRow(x.b, b, fav === "b" ? "fav" : "", 1)}`
        + (x.stage?.leg === 2 ? `<p class="sb-left">Leg 1: ${e(x.a)} ${fixed(x.stage.a_leg1, 2)}, ${e(x.b)} ${fixed(x.stage.b_leg1, 2)}</p>` : "")
        + `${line("preview_lines", i, "sb-line")}</article>`;
    };
    let psa = (nx.psa || []).map((x: J) => `<li><span class="st">${e(x.status)}</span><span><b>${e(x.player)}</b> in the ${e(x.team)} lineup</span></li>`).join("");
    psa = psa ? `<aside class="psa" aria-labelledby="psa-h"><h3 id="psa-h">Lineup PSA</h3><ul>${psa}</ul></aside>` : "";
    upcoming = `<section class="seg" aria-labelledby="next-h">${bumper("next-h", `Week ${nx.week}`, "Coming up · projected")}`
      + `<div class="bugs">${nx.games.map((x: J, i: number) => preview(i + 1, x)).join("")}${psa}</div></section>`;
  }

  const cut = f.playoff_teams || 0, rows: string[] = [];
  f.standings.forEach((s: J, n: number) => {
    const i = n + 1;
    rows.push(`<tr${i <= cut ? " class=in" : ""}><th scope="row"><span class="rk">${i}</span>${e(s.team)}</th>`
      + `<td>${s.w}-${s.l}${s.t ? "-" + s.t : ""}</td><td>${fixed(s.pf, 2)}</td><td>${fixed(s.pa, 2)}</td>`
      + `<td>${s.all_play}</td><td class="${s.luck > 0 ? "pos" : "neg"}">${signed(s.luck, 2)}</td>`
      + `<td>${fixed(s.bench_left, 1)}</td></tr>`);
    if (i === cut && cut < f.standings.length) rows.push(`<tr class="cut"><td colspan="7"><span>Playoff line · top ${cut} get in</span></td></tr>`);
  });
  const teamsWk = sortBy(f.games.flatMap((x: J) => [x.win, x.lose]), (t: J) => -t.eff);
  const report = teamsWk.map((t: J) =>
    `<tr><th scope="row">${e(t.team)}</th><td>${fixed(t.pts, 2)}</td><td>${fixed(t.opt, 2)}</td>`
    + `<td>${fixed(t.opt - t.pts, 2)}</td><td class="eff">${g(t.eff)}%<span style="--p:${g(t.eff)}%"></span></td></tr>`).join("");
  const nerd = `<section class="seg" aria-labelledby="nerd-h">${bumper("nerd-h", "Nerd Corner", "Standings & lineup math", note(5, SCRIBBLE))}`
    + `<details class="fold"><summary><span><span class="if-shut">Show</span><span class="if-open">Hide</span> the standings and lineup math</span></summary><div class="boards"><div class="scroll" tabindex="0" role="region" aria-label="Standings table">`
    + `<table class="standings"><caption>Standings</caption><thead><tr><th scope="col">Team</th><th scope="col">W-L</th>`
    + `<th scope="col">PF</th><th scope="col">PA</th><th scope="col" title="Record if you played every team every week">All-play</th>`
    + `<th scope="col" title="Wins above what your all-play rate predicts">Luck</th>`
    + `<th scope="col" title="Season points left on the bench">Benched</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    + `<div class="scroll" tabindex="0" role="region" aria-label="Lineup report table"><table class="report">`
    + `<caption>Lineup report, week ${wk}</caption><thead><tr><th scope="col">Team</th><th scope="col">Pts</th>`
    + `<th scope="col">Max</th><th scope="col">Left</th><th scope="col">Eff</th></tr></thead><tbody>${report}</tbody></table></div>`
    + `</div></details></section>`;

  const archive = data.map((d, i) => `<li><a href="${weekUrl(d.facts)}"${i === here ? " aria-current=page" : ""}>`
    + `<span class="arc-wk">Wk ${d.facts.week}</span>${e(d.copy.headline || "")}</a></li>`).reverse().join("");
  const signoff = c.signoff ? `<p class="pen signoff">${e(c.signoff)}${SCRIBBLE}</p>` : "";
  const body = `<header class="mast"><div class="mast-in"><p class="mark" aria-hidden="true">${e(mark)}</p>`
    + `<p class="brand"><b>${e(league)}</b><span>${e(String(f.season))} season recap</span></p>${weekNav}</div></header>`
    + `<main>${extra.banner ?? ""}${lead}${rundown}${rankings}${trophies}${scoreboard}${upcoming}${nerd}${extra.tail ?? ""}</main>`
    + `<footer class="foot">${signoff}`
    + `<nav aria-labelledby="arc-h"><h2 id="arc-h" class="foot-h">Previously on ${e(league)}</h2><ul class="archive">${archive}</ul></nav>`
    + `<p class="fine">${extra.fine ?? "Numbers from Sleeper. Jokes from Claude. Updates Tuesday mornings."}</p></footer>`;
  // Pun first: iMessage shows only the preview image and a line or two of title.
  const title = head ? `${head} · ${brand} Week ${wk}` : `${brand} Week ${wk}`;
  const alt = [head ? `Week ${wk}: ${head}.` : `Week ${wk}.`, value ? `The number: ${value}, circled in red marker.` : "", cap].filter(Boolean).join(" ");
  return fill(shell, { title: e(title), description: e(dek), image: e(url + "og.jpg"), image_alt: e(alt), url: e(url), brand: e(brand), body });
}

/** Fill the page shell's {{slots}}, in this order (a later value can't be mistaken for an earlier slot). */
export function fill(shell: string, slots: Record<string, string>): string {
  for (const [k, v] of Object.entries(slots)) shell = shell.replaceAll(`{{${k}}}`, () => v); // a function: "$&" in copy stays literal
  return shell;
}
