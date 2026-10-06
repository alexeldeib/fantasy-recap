// The hosted version's own pages and page parts: the landing page, the free-preview banner, and game-day updates.
// They reuse the recap template's look (its CSS tokens and components); EXTRA_CSS adds the few new pieces.
import type { J } from "./facts.ts";
import { weekday } from "./live.ts";
import { bumper, displayName, fill, fit, litAt, SCRIBBLE, stageLabel } from "./render.ts";
import { esc as e, first, fixed, words } from "./py.ts";

export interface Site { brand: string; origin: string; price: string; payLink: string }

export const EXTRA_CSS = `<style>
.cta { width: 100%; max-width: var(--max); margin-inline: auto; padding: 18px var(--gut) 0; }
.cta-in { display: grid; gap: 12px; justify-items: start; background: var(--ink-2); border: 1px solid var(--line); border-left: 6px solid var(--volt); padding: 16px 18px 18px; }
.cta-k { color: var(--aqua); font-weight: 800; font-size: .82rem; letter-spacing: .12em; text-transform: uppercase; }
.cta p, .perk p, .steps p { color: var(--chalk-2); line-height: 1.5; max-width: 52ch; text-wrap: pretty; }
.btn, .go button { display: inline-block; border: 0; cursor: pointer; background: var(--volt); color: var(--ink); text-decoration: none;
  font: italic 900 1.15rem/1 var(--f-tv); font-stretch: 75%; text-transform: uppercase; letter-spacing: .03em;
  padding: 14px 26px 12px 16px; clip-path: polygon(0 0, 100% 0, calc(100% - 12px) 100%, 0 100%); }
.btn:hover, .go button:hover { background: var(--chalk); }
.go { display: flex; flex-wrap: wrap; gap: 10px; width: 100%; max-width: 40rem; }
.go input { flex: 1 1 15rem; min-width: 0; font: 500 1.05rem/1.2 var(--f-tv); color: var(--chalk); background: var(--ink-2);
  border: 1px solid var(--line); border-bottom: 3px solid var(--volt); border-radius: 0; padding: 14px 14px 12px; }
.go input::placeholder { color: var(--chalk-3); }
.perks { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.perk { display: grid; gap: 8px; align-content: start; background: var(--ink-2); border: 1px solid var(--line); padding: 16px 16px 18px; }
.perk h3, .day-h { font: italic 900 1.3rem/1.1 var(--f-tv); font-stretch: 75%; text-transform: uppercase; color: var(--chalk); letter-spacing: .01em; }
.steps { display: grid; gap: 16px; max-width: 46rem; counter-reset: step; }
.steps li { counter-increment: step; display: grid; grid-template-columns: 2.6rem minmax(0, 1fr); gap: 14px; align-items: start; }
.steps li::before { content: counter(step); display: grid; place-items: center; height: 2.6rem; background: var(--ink-4); color: var(--volt); font: 900 1.6rem/1 var(--f-led); }
.steps b { display: block; color: var(--chalk); font-size: 1.1rem; margin-bottom: 4px; }
.price { font: 900 clamp(3.2rem, 16vw, 5rem)/.9 var(--f-led); color: var(--volt); }
.day { display: grid; gap: 14px; }
.day-h { font-size: clamp(1.7rem, 7.5vw, 2.6rem); line-height: 1; }
.day .dek { max-width: 46ch; }
.day > .pen { justify-self: start; margin: 16px 0 22px 6px; } /* the marker is rotated: give it room above the scores */
.lead-copy .dek, .day .dek { grid-area: auto; margin-top: 0; } /* the recap's wide layout moves .dek into its own grid area */
/* Score bugs: the same width at every league size (4 games, 5, 6, 7...), as many per row as fit, a short last row left as
   is. The recap template stretches leftovers to fill a row, which only looks right for 10 teams; its spans need !important
   to undo (they're more specific). */
.bugs { grid-template-columns: repeat(auto-fill, minmax(min(100%, 21rem), 1fr)); }
.bugs > * { grid-column: auto !important; }
.live .sb-top .chip { background: var(--pen); color: var(--chalk); }
.sb-left { padding: 6px 14px 12px 60px; color: var(--chalk-3); font-size: .9rem; line-height: 1.35; }
.earlier-list { display: grid; gap: 14px; min-width: 0; }
.earlier { min-width: 0; background: var(--ink-2); border: 1px solid var(--line); }
.earlier > summary { list-style: none; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 16px;
  min-height: 60px; padding-right: 16px; cursor: pointer; }
.earlier > summary::-webkit-details-marker { display: none; }
.earlier > summary:focus-visible { outline-offset: -3px; }
.earlier[open] > summary { border-bottom: 1px solid var(--line); }
.sum-day { align-self: stretch; display: grid; place-items: center; min-width: 4.2rem; padding: 0 20px 0 12px; background: var(--aqua); color: var(--ink);
  font: italic 900 1rem/1 var(--f-tv); font-stretch: 75%; text-transform: uppercase; letter-spacing: .06em; clip-path: polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%); }
.sum-h { display: grid; gap: 3px; min-width: 0; padding-block: 12px; }
.sum-h b { font: italic 900 1.25rem/1.1 var(--f-tv); font-stretch: 75%; text-transform: uppercase; color: var(--chalk); letter-spacing: .01em; overflow-wrap: anywhere; }
.sum-h span { color: var(--chalk-3); font-size: .85rem; letter-spacing: .04em; }
.sum-t { color: var(--volt); font-weight: 800; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; }
.sum-t::after { content: "Show"; }
.earlier[open] .sum-t::after { content: "Hide"; }
.earlier .day { padding: 18px 16px 22px; }
.feed { background: var(--ink-2); border-bottom: 1px solid var(--line); padding-inline: var(--side); }
.feed-in { display: flex; align-items: center; gap: 12px; min-width: 0; padding-block: 10px; }
.feed-k { flex: none; background: var(--pen); color: var(--chalk); font: italic 900 .85rem/1 var(--f-tv); font-stretch: 75%; letter-spacing: .08em;
  text-transform: uppercase; padding: 8px 18px 7px 9px; clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.feed-list { display: flex; gap: 10px; min-width: 0; overflow-x: auto; scrollbar-width: none; margin: 0; padding: 0; list-style: none; }
.feed-list::-webkit-scrollbar { display: none; }
.feed-list li { flex: none; display: flex; }
.fs-i, .fs-all { display: grid; align-content: center; gap: 3px; max-width: 16rem; padding: 7px 12px; background: var(--ink-3); border: 1px solid var(--line);
  color: var(--chalk); text-decoration: none; }
.fs-i:hover, .fs-all:hover { border-color: var(--volt); }
.fs-i.here { border-color: var(--aqua); }
.fs-d { color: var(--aqua); font-weight: 800; font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.fs-h { font: italic 900 .98rem/1.1 var(--f-tv); font-stretch: 75%; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fs-all { color: var(--volt); font-weight: 800; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; white-space: nowrap; }
.posts { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.post { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 16px; min-height: 60px; background: var(--ink-2); border: 1px solid var(--line);
  color: var(--chalk); text-decoration: none; }
.post:hover { border-color: var(--volt); }
.post .sum-h { padding-right: 16px; }
.post .sum-h span { color: var(--chalk-2); font-size: .95rem; letter-spacing: 0; line-height: 1.45; }
.post.recap .sum-day { background: var(--volt); }
.ed-form { display: grid; gap: 18px; max-width: 46rem; }
.ed-form label { display: grid; gap: 6px; color: var(--chalk); font-weight: 700; }
.ed-form label span { color: var(--chalk-3); font-weight: 400; font-size: .9rem; }
.ed-form textarea { width: 100%; font: 500 1rem/1.45 var(--f-tv); color: var(--chalk); background: var(--ink-2); border: 1px solid var(--line);
  border-bottom: 3px solid var(--volt); border-radius: 0; padding: 10px 12px; resize: vertical; field-sizing: content; }
.ed-form .btn, .fine-print { justify-self: start; }
.fine-print a, .fine a { color: inherit; }
</style>`;

/** Every page: the extra styles, a football favicon, and no link-preview image (the hosted version doesn't draw one yet). */
// A link to a folded game-day update opens it: on arrival, when only the #fragment changes (a link to another update on
// the same page), and when the same link is tapped again (no hashchange fires for that).
const OPEN_LINKED = `<script>(function () {
  function open() {
    var d = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (d && d.tagName === "DETAILS") { d.open = true; d.scrollIntoView(); }
  }
  addEventListener("DOMContentLoaded", open);
  addEventListener("hashchange", open);
  addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href*='#']");
    if (a && a.pathname === location.pathname && a.hash === location.hash) setTimeout(open);
  });
})();</script>`;

export const finish = (html: string): string => html
  .replace("</head>", `${EXTRA_CSS}${OPEN_LINKED}</head>`)
  .replace(/<!-- The link preview[^\n]*\n(<meta property="og:image[^\n]*\n)+/, "")
  .replace('content="summary_large_image"', 'content="summary"')
  .replace(/font-size='90'>[^<]*</, "font-size='90'>🏈<");

/** A page response. `priv` is for pages that carry a private link: never cached, never sent on as a referrer. */
export const html = (body: string, status = 200, maxAge = 60, priv = false) => new Response(body, { status, headers: {
  "content-type": "text/html; charset=utf-8", "cache-control": priv ? "no-store" : `public, max-age=${maxAge}`,
  "x-content-type-options": "nosniff", "referrer-policy": priv ? "no-referrer" : "strict-origin-when-cross-origin",
  ...(priv && { "x-robots-tag": "noindex" }), // (the Content-Security-Policy is added on the way out: csp())
} });

/** The Content-Security-Policy for every page. Scripts run only by hash (the template's and OPEN_LINKED, both fixed text), so
 *  markup that slipped past escaping couldn't run any, plus the beacon Cloudflare Web Analytics (cookieless) injects on this
 *  zone; styles may be inline (the template sizes type with style attributes); fonts come from Google, avatars from Sleeper's
 *  CDN. Computed once per isolate. */
let policy: Promise<string> | undefined;
export const csp = (shell: string) => (policy ??= (async () => {
  const sha = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
  const scripts = await Promise.all([...`${shell}${OPEN_LINKED}`.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha(m[1]!)));
  return ["default-src 'self'", `script-src ${scripts.map((h) => `'sha256-${h}'`).join(" ")} https://static.cloudflareinsights.com`,
    "connect-src 'self' https://cloudflareinsights.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data: https:", "form-action 'self'", "base-uri 'none'", "object-src 'none'",
    "frame-ancestors 'none'"].join("; ");
})());

const avatar = (t: J, team: string) => (t?.avatar
  ? `<img class="av" src="${e(t.avatar)}" alt="" width="34" height="34" loading="lazy" decoding="async">`
  : `<span class="av" aria-hidden="true">${e(first(team).toUpperCase())}</span>`);

const WEEKDAYS = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"]; // an NFL week's order

/** One game-day update's content: a live score bug per matchup with the writer's line under it, between the dek and the
 *  signoff. Marker note 0 rides the section header beside the headline, note 1 sits on the scores (as the game-day prompt
 *  tells the writer). */
function dayBody(doc: J, headline: boolean): string {
  const { facts: f, copy: c } = doc;
  const who = new Map<string, J>(f.teams.map((t: J) => [t.team, t]));
  const lines: Record<string, string> = Object.fromEntries((c.game_lines || []).map((x: J) => [x.key, x.line]));
  const row = (s: J, lead: boolean) => {
    const days = [...new Set<string>(s.still_to_play.map((p: J) => p.when))].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    const left = s.left ? `${s.left} left (${days.map((d) => d.slice(0, 3)).join(", ")}) · proj ${fixed(s.proj_final, 1)}` : "Done";
    return `<p class="sb-row${lead ? " win" : ""}">${avatar(who.get(s.team), s.team)}<span class="sb-t" style="--n:${fit(s.team)}">${e(s.team)}</span>`
      + `<b class="sb-s">${fixed(s.pts, 2)}</b></p><p class="sb-left">${e(left)}${s.left ? ` · ${s.win_pct}% to win` : ""}</p>`;
  };
  const bugs = f.games.map((x: J) => {
    const st = x.stage, [a, b] = st?.leg === 2 ? [st.a_total, st.b_total] : [x.a.pts, x.b.pts]; // a second leg is about the total
    return `<article class="sb live"><h3 class="sr">${e(x.a.team)} vs ${e(x.b.team)}</h3>`
      + `<p class="sb-top"><span class="chip">${!x.final ? "Live" : st?.leg === 1 ? "Leg 1" : "Final"}</span><span>${st ? e(stageLabel(st)) : `Game ${x.key}`}</span>`
      + `<span class="sb-m">${x.final ? `+${fixed(x.margin, 2)}` : ""}</span></p>`
      + row(x.a, a > b) + row(x.b, b > a) // a tie (say, 0-0 before kickoff) lights neither side
      + (st?.leg === 2 ? `<p class="sb-left">Two-week total: ${e(x.a.team)} ${fixed(a, 2)}, ${e(x.b.team)} ${fixed(b, 2)}</p>` : "")
      + (lines[x.key] ? `<p class="sb-line">${litAt(lines[x.key]!)}</p>` : "") + "</article>";
  }).join("");
  return `<div class="day">${headline ? `<h3 class="day-h">${e(c.headline || `${f.day_name} update`)}</h3>` : ""}`
    + (c.dek ? `<p class="dek">${litAt(c.dek)}</p>` : "") + note(c, 1) + `<div class="bugs">${bugs}</div>`
    + (c.signoff ? `<p class="pen signoff">${e(c.signoff)}${SCRIBBLE}</p>` : "") + "</div>";
}

const note = (c: J, i: number) => ((c.pen_notes || [])[i] ? `<p class="pen">${e(c.pen_notes[i])}${SCRIBBLE}</p>` : "");

/** The newest update, as its own section. */
export function daySection(doc: J): string {
  const f = doc.facts, id = `day-${f.day}`;
  return `<section class="seg" aria-labelledby="${id}" id="${f.day}">${bumper(id, `${f.day_name} update`, `Week ${f.week} · after ${f.day_name}'s games`, note(doc.copy, 0))}`
    + `${dayBody(doc, true)}</section>`;
}

/** An earlier update, folded into a card: day, headline, then the whole update when opened. */
const dayCard = (doc: J): string => `<details class="earlier" id="${doc.facts.day}"><summary><span class="sum-day">${e(doc.facts.day_name.slice(0, 3))}</span>`
  + `<span class="sum-h"><b>${e(doc.copy.headline || `${doc.facts.day_name} update`)}</b><span>After ${e(doc.facts.day_name)}'s games</span></span>`
  + `<span class="sum-t" aria-hidden="true"></span></summary>${dayBody(doc, false)}</details>`;

/** A week's game-day updates, newest first. On a live week the newest leads and the rest fold under "Earlier this week";
 *  under a weekly recap they all fold, as the week's back story. */
export function dayTail(docs: J[], leadWithNewest = true): string {
  const rest = leadWithNewest ? docs.slice(1) : [...docs].reverse(); // the back story reads in order, Thursday first
  return (leadWithNewest && docs.length ? daySection(docs[0]) : "") + (rest.length
    ? `<section class="seg" aria-labelledby="earlier-h">${bumper("earlier-h", leadWithNewest ? "Earlier this week" : "How the week unfolded", "Game-day updates")}`
      + `<div class="earlier-list">${rest.map(dayCard).join("")}</div></section>` : "");
}

/** A week that has game-day updates but no recap yet: the newest update leads the page. `weeks` is every week with a page. */
export function dayPage(shell: string, docs: J[], site: Site, url: string, home: string, weeks: J[], strip: string): string {
  const f = docs[0].facts, c = docs[0].copy, league = f.league;
  const mark = words(league).slice(0, 2).map(first).join("").toUpperCase();
  const archive = weeks.map((d) => `<li><a href="${home}${d.facts.season}/${d.facts.week}/"${d.facts.week === f.week ? " aria-current=page" : ""}>`
    + `<span class="arc-wk">Wk ${d.facts.week}</span>${e(d.copy.headline || "")}</a></li>`).reverse().join("");
  const body = mast(mark, league, `${f.season} · week ${f.week} live`, weekNav(weeks, f.season, f.week, home)) + `<main>${strip}${dayTail(docs)}</main>`
    + foot(league, archive, site);
  return finish(fill(shell, { title: e(`${c.headline || `${f.day_name} update`} · ${displayName(league)} Week ${f.week}`),
    description: e(c.dek || ""), image: "", image_alt: "", url: e(url), brand: e(displayName(league)), body }));
}

export const mast = (mark: string, league: string, sub: string, nav = "") => `<header class="mast"><div class="mast-in"><p class="mark" aria-hidden="true">${e(mark)}</p>`
  + `<p class="brand"><b>${e(league)}</b><span>${e(sub)}</span></p>${nav}</div></header>`;

/** The recap pages' week switcher (same markup as render.ts page()), for pages it doesn't draw. */
function weekNav(weeks: J[], season: string, week: number, home: string): string {
  const here = weeks.findIndex((x) => x.facts.season === season && x.facts.week === week);
  const url = (x: J) => `${home}${x.facts.season}/${x.facts.week}/`;
  const step = (i: number, cls: string, label: string) => (here < 0 || !(0 <= i && i < weeks.length)
    ? `<span class="step ${cls} off" aria-hidden="true"></span>`
    : `<a class="step ${cls}" href="${url(weeks[i])}" rel="${cls}"><span class="sr">${label}: week ${weeks[i].facts.week}</span></a>`);
  const chips = weeks.map((x, i) => `<li><a href="${url(x)}"${i === here ? " aria-current=page" : ""}>Wk ${x.facts.week}</a></li>`).join("");
  return `<nav class="weeks" aria-label="Weeks">${step(Math.max(here, 0) - 1, "prev", "Previous")}<ol class="wk-list" role="list">${chips}</ol>`
    + `${step(Math.max(here, 0) + 1, "next", "Next")}</nav>`;
}

/** One post in the league's feed: a weekly recap, or a game-day update. */
export interface Post { season: string; week: number; kind: string; headline: string | null; dek?: string | null }
export const postUrl = (home: string, p: Post) => `${home}${p.season}/${p.week}/${p.kind === "weekly" ? "" : `#${p.kind.slice(4)}`}`;
export const postDay = (p: Post) => (p.kind === "weekly" ? "Recap" : weekday(p.kind.slice(4)).slice(0, 3));

/** The "Latest" strip under the masthead: the newest posts across weeks, so every page is one tap from what's new. */
export function feedStrip(posts: Post[], home: string, week?: number): string {
  if (!posts.length) return "";
  const items = posts.slice(0, 8).map((p, i) => `<li><a class="fs-i${p.week === week ? " here" : ""}" href="${postUrl(home, p)}">`
    + `<span class="fs-d">${i === 0 ? "New · " : ""}${postDay(p)} · Wk ${p.week}</span><span class="fs-h">${e(p.headline || "")}</span></a></li>`).join("");
  return `<nav class="feed" aria-label="Latest posts"><div class="feed-in"><p class="feed-k" aria-hidden="true">Latest</p>`
    + `<ol class="feed-list" role="list">${items}<li><a class="fs-all" href="${home}feed">All posts</a></li></ol></div></nav>`;
}

/** Every post this season, newest first, a section per week. */
export function feedPage(shell: string, site: Site, league: { name: string; season: string }, posts: Post[], home: string, weeks: J[]): string {
  const byWeek = new Map<number, Post[]>();
  for (const p of posts) byWeek.set(p.week, [...(byWeek.get(p.week) ?? []), p]);
  const sections = [...byWeek].map(([week, ps]) => `<section class="seg" aria-labelledby="wk-${week}">${bumper(`wk-${week}`, `Week ${week}`, `${ps.length} post${ps.length > 1 ? "s" : ""}`)}`
    + `<ol class="posts" role="list">${ps.map((p) => `<li><a class="post${p.kind === "weekly" ? " recap" : ""}" href="${postUrl(home, p)}"><span class="sum-day">${postDay(p)}</span>`
      + `<span class="sum-h"><b>${e(p.headline || "")}</b>${p.dek ? `<span>${e(p.dek)}</span>` : ""}</span></a></li>`).join("")}</ol></section>`).join("");
  const name = league.name, mark = words(name).slice(0, 2).map(first).join("").toUpperCase();
  const body = mast(mark, name, `${league.season} · every post`, weekNav(weeks, league.season, -1, home))
    + `<main>${sections || `<section class="seg"><p class="dek">Nothing posted yet.</p></section>`}</main>` + foot(name, "", site);
  return finish(fill(shell, { title: e(`All posts · ${displayName(name)}`), description: e(`Every recap and game-day update for ${displayName(name)}.`),
    image: "", image_alt: "", url: e(`${home}feed`), brand: e(displayName(name)), body }));
}

export const foot = (league: string, archive: string, site: Site) => `<footer class="foot">`
  + (archive ? `<nav aria-labelledby="arc-h"><h2 id="arc-h" class="foot-h">Previously on ${e(league)}</h2><ul class="archive">${archive}</ul></nav>` : "")
  + `<p class="fine">${fine(site)}</p></footer>`;

export const fine = (site: Site) => `Numbers from Sleeper. Jokes from Claude. A recap every Tuesday morning, quick hits after every game day. `
  + `<a href="${site.origin}/">Get ${e(site.brand)} for your league</a>. Not affiliated with Sleeper. <a href="${site.origin}/terms">Terms</a>.`;

/** The free preview's banner: the numbers are real, the jokes switch on with a season pass. A finished season (an old league
 *  link: Sleeper gives each season a new league ID) gets no buy button, since there's nothing left to write. */
export function previewBanner(site: Site, league: J, leagueId: string): string {
  const pay = league.status === "complete" ? `<p><b>This league's season is over.</b> When Sleeper renews it, paste the new league's link on the front page for next season's pass.</p>`
    : site.payLink ? `<a class="btn" href="${e(`${site.payLink}?client_reference_id=${leagueId}`)}">Turn on the jokes · ${e(site.price)}</a>`
    : `<p><b>Season passes open soon.</b></p>`;
  return `<aside class="cta" aria-label="Free preview"><div class="cta-in"><p class="cta-k">Free preview · ${e(displayName(league.name))}</p>`
    + `<p>These are your league's real numbers with plain labels. A season pass adds the good part: a column, power-ranking takes and a joke on every trophy, written fresh every Tuesday, plus quick hits after every game day. One link for the group chat, all season.</p>`
    + `${pay}</div></aside>`;
}

/** Before a league's first scored week: who's in, and the pass. */
export function waitingPage(shell: string, site: Site, league: J, leagueId: string, paid: boolean): string {
  const name = league.name as string;
  const text = paid ? "You're all set. The first recap lands the Tuesday morning after Week 1, with quick hits after each game day before that."
    : "Your league hasn't played a week yet. Grab a season pass now and the first recap lands the Tuesday after Week 1.";
  const body = mast(words(name).slice(0, 2).map(first).join("").toUpperCase(), name, `${league.season} season`)
    + `<main>${paid ? "" : previewBanner(site, league, leagueId)}<section class="seg"><div class="day"><h1 class="day-h">${e(text)}</h1></div></section></main>`
    + foot(name, "", site);
  return finish(fill(shell, { title: e(`${displayName(name)} · ${site.brand}`), description: e(text), image: "", image_alt: "", url: e(site.origin), brand: e(site.brand), body }));
}

export function messagePage(shell: string, site: Site, title: string, text: string, more = `<p><a class="btn" href="${site.origin}/">Try another league</a></p>`): string {
  const body = mast("?!", site.brand, title) + `<main><section class="seg"><div class="day"><h1 class="day-h">${e(title)}</h1><p class="dek">${e(text)}</p>`
    + `${more}</div></section></main>` + foot(site.brand, "", site);
  return finish(fill(shell, { title: e(`${title} · ${site.brand}`), description: e(text), image: "", image_alt: "", url: e(site.origin), brand: e(site.brand), body }));
}

/** The front door: what it is, a box for the league link, and an example. */
export function landing(shell: string, site: Site, example?: { slug: string; name: string }): string {
  const mark = words(site.brand).filter((w) => w.toLowerCase() !== "the").slice(0, 2).map(first).join("").toUpperCase();
  const perk = (h: string, p: string) => `<article class="perk"><h3>${e(h)}</h3><p>${p}</p></article>`;
  const body = `<header class="mast"><div class="mast-in"><p class="mark" aria-hidden="true">${e(mark)}</p>`
    + `<p class="brand"><b>${e(site.brand)}</b><span>Weekly recaps for Sleeper leagues</span></p></div></header><main>`
    + `<section class="lead" aria-labelledby="lead-h" data-wk="★"><div class="lead-in"><div class="lead-copy">`
    + `<p class="kick">For commissioners · Top story</p>`
    + `<h1 id="lead-h" class="headline" style="--hw:3.2;--ht:9.4">YOUR LEAGUE, ROASTED WEEKLY</h1>`
    + `<p class="dek">Every Tuesday your Sleeper league gets a recap that reads like a sports column, not a stat sheet: trophies, power rankings, and a joke about every lineup call. Quick hits land after every game day too.</p>`
    + `<form class="go" action="/go" method="get"><label class="sr" for="league">Your Sleeper league link or ID</label>`
    + `<input id="league" name="league" inputmode="url" autocomplete="off" placeholder="Paste your Sleeper league link" required>`
    + `<button type="submit">See my league</button></form>`
    + (example ? `<p class="dek">Or see a real one: <a href="/${e(example.slug)}">${e(example.name)}</a>.</p>` : "")
    + `</div></div></section>`
    + `<section class="seg" aria-labelledby="what-h">${bumper("what-h", "What you get", "Every week, all season", `<p class="pen">START HERE${SCRIBBLE}</p>`)}<div class="perks">`
    + perk("The Tuesday recap", "A headline, a column called The Rundown, power rankings with a take on every team, fifteen trophies, every score and next week's matchups.")
    + perk("Game-day quick hits", "After Thursday night, Sunday and Monday night: where every matchup stands, who's left to play, and whose bench just cost them.")
    + perk("Real plays, real memes", "Each week it searches the news for the big plays and bloopers, then pins them on whoever rosters the player.")
    + perk("One link, every season", "Paste it in the group chat once. It updates itself, and a renewed league keeps the same link next year.")
    + `</div></section>`
    + `<section class="seg" aria-labelledby="how-h">${bumper("how-h", "How it works", "No apps, no bots, no logins")}<ol class="steps">`
    + `<li><p><b>Paste your league link</b>See a free preview of your latest week with your real numbers.</p></li>`
    + `<li><p><b>Turn on the jokes</b>One season pass per league. Any manager can buy it.</p></li>`
    + `<li><p><b>Drop the link in the group chat</b>New recap every Tuesday morning, quick hits after every game day.</p></li></ol></section>`
    + `<section class="seg" aria-labelledby="price-h">${bumper("price-h", "Season pass", "Per league, per season")}<div class="day">`
    + `<p class="price">${e(site.price)}</p><p class="dek">Less than a waiver bid, split across the whole league. Not for you? `
    + `<a href="/terms">A full refund</a> within 7 days.</p></div></section>`
    + `</main>` + foot(site.brand, "", site);
  return finish(fill(shell, { title: e(`${site.brand} · Weekly recaps for Sleeper leagues`), description: e("A weekly recap of your Sleeper fantasy league that reads like a sports column, with game-day updates."),
    image: "", image_alt: "", url: e(site.origin + "/"), brand: e(site.brand), body }));
}

/** After checkout: the league's link for the group chat, and the commissioner's private editor link. */
export function paidPage(shell: string, site: Site, lg: { slug: string; name: string; edit_key: string }): string {
  const home = `${site.origin}/${lg.slug}/`, edit = `${home}edit?key=${lg.edit_key}`;
  return messagePage(shell, site, "You're in", `${displayName(lg.name)} is on. The recap lands every Tuesday morning, with quick hits after every game day.`,
    `<p><a class="btn" href="${e(home)}">See your league</a></p><p class="dek">Share <b>${e(home)}</b> in the group chat.</p>`
    + `<p class="dek">Your private editor link, for fixing any line or adding league lore: <a href="${e(edit)}">${e(edit)}</a>. `
    + `Bookmark it and keep it to yourself: anyone with it can edit your league's pages.</p>`);
}

/** /terms: what a season pass is, refunds, privacy and contact, in plain words. */
export function termsPage(shell: string, site: Site): string {
  const mail = `support@${new URL(site.origin).hostname}`, link = `<a href="mailto:${mail}">${mail}</a>`;
  const sec = (id: string, h: string, kicker: string, ps: string[]) => `<section class="seg" aria-labelledby="${id}">${bumper(id, h, kicker)}<div class="day">`
    + ps.map((p) => `<p class="dek fine-print">${p}</p>`).join("") + "</div></section>";
  const body = mast("BP", site.brand, "Terms, refunds and privacy") + "<main>"
    + sec("buy-h", "What you get", "One league, one season", [`A season pass turns on ${e(site.brand)} for one Sleeper league for one NFL season: a recap every Tuesday morning and a quick update after every NFL game day, through the end of that league's season, at one link anyone in the league can open. It's a one-time payment, not a subscription. When Sleeper renews your league next season, that season needs its own pass.`])
    + sec("refund-h", "Refunds", "No hard feelings", [`Not what you hoped for? Email ${link} within 7 days of buying for a full refund, no questions asked.`,
      "If a problem on our end stops your league's recaps during the season and we can't fix it, we'll refund the pass in full."])
    + sec("priv-h", "Privacy", "What we keep", ["We use your league's public Sleeper data (team names, usernames, avatars, rosters and scores) to make its pages, which anyone with the link can read. Stripe handles payments; we never see your card.",
      `No accounts, no ads, no tracking cookies. To take your league's pages down, email ${link}.`])
    + sec("fine-h", "The fine print", "Read it once", ["The recaps are written by AI (Claude) from real stats, for laughs. They can get things wrong, and they roast lineup decisions. The commissioner can edit any line.",
      `${e(site.brand)} isn't affiliated with Sleeper or the NFL. If these terms change, this page has the current version.`])
    + sec("help-h", "Contact", "A real person answers", [`Questions, refunds, a recap that needs fixing: ${link}.`])
    + "</main>" + foot(site.brand, "", site);
  return finish(fill(shell, { title: e(`Terms · ${site.brand}`), description: e(`What a ${site.brand} season pass covers, refunds and privacy.`),
    image: "", image_alt: "", url: e(`${site.origin}/terms`), brand: e(site.brand), body }));
}
