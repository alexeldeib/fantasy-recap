// The hosted version's own pages and page parts: the landing page, the free-preview banner, and game-day updates.
// They reuse the recap template's look (its CSS tokens and components); EXTRA_CSS adds the few new pieces.
import type { J } from "./facts.ts";
import { bumper, displayName, fill, fit, litAt, SCRIBBLE } from "./render.ts";
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
.live .sb-top .chip { background: var(--pen); color: var(--chalk); }
.sb-left { padding: 6px 14px 12px 60px; color: var(--chalk-3); font-size: .9rem; line-height: 1.35; }
.earlier { display: grid; gap: 10px; }
.earlier summary { cursor: pointer; color: var(--aqua); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; font-size: .9rem; }
</style>`;

/** Every page: the extra styles, a football favicon, and no link-preview image (the hosted version doesn't draw one yet). */
export const finish = (html: string): string => html
  .replace("</head>", `${EXTRA_CSS}</head>`)
  .replace(/<!-- The link preview[^\n]*\n(<meta property="og:image[^\n]*\n)+/, "")
  .replace('content="summary_large_image"', 'content="summary"')
  .replace(/font-size='90'>[^<]*</, "font-size='90'>🏈<");

const avatar = (t: J, team: string) => (t?.avatar
  ? `<img class="av" src="${e(t.avatar)}" alt="" width="34" height="34" loading="lazy" decoding="async">`
  : `<span class="av" aria-hidden="true">${e(first(team).toUpperCase())}</span>`);

/** One game-day update: its headline, then a live score bug per matchup with the writer's line under it. Marker note 0
 *  rides the section header beside the headline, note 1 sits on the scores (as the game-day prompt tells the writer). */
export function daySection(doc: J, open = true): string {
  const { facts: f, copy: c } = doc;
  const who = new Map<string, J>(f.teams.map((t: J) => [t.team, t]));
  const lines: Record<string, string> = Object.fromEntries((c.game_lines || []).map((x: J) => [x.key, x.line]));
  const note = (i: number) => ((c.pen_notes || [])[i] ? `<p class="pen">${e(c.pen_notes[i])}${SCRIBBLE}</p>` : "");
  const row = (s: J, lead: boolean) => {
    const left = s.left ? `${s.left} left (${[...new Set(s.still_to_play.map((p: J) => p.when.slice(0, 3)))].join(", ")}) · proj ${fixed(s.proj_final, 1)}` : "Done";
    return `<p class="sb-row${lead ? " win" : ""}">${avatar(who.get(s.team), s.team)}<span class="sb-t" style="--n:${fit(s.team)}">${e(s.team)}</span>`
      + `<b class="sb-s">${fixed(s.pts, 2)}</b></p><p class="sb-left">${e(left)}${s.left ? ` · ${s.win_pct}% to win` : ""}</p>`;
  };
  const bugs = f.games.map((x: J) => `<article class="sb live"><h3 class="sr">${e(x.a.team)} vs ${e(x.b.team)}</h3>`
    + `<p class="sb-top"><span class="chip">${x.final ? "Final" : "Live"}</span><span>Game ${x.key}</span>`
    + `<span class="sb-m">${x.final ? `+${fixed(x.margin, 2)}` : ""}</span></p>`
    + row(x.a, x.a.pts >= x.b.pts) + row(x.b, x.b.pts > x.a.pts)
    + (lines[x.key] ? `<p class="sb-line">${litAt(lines[x.key]!)}</p>` : "") + "</article>").join("");
  const body = `<div class="day"><h3 class="day-h">${e(c.headline || `${f.day_name} update`)}</h3>`
    + (c.dek ? `<p class="dek">${litAt(c.dek)}</p>` : "") + note(1) + `<div class="bugs">${bugs}</div>`
    + (c.signoff ? `<p class="pen signoff">${e(c.signoff)}${SCRIBBLE}</p>` : "") + "</div>";
  const id = `day-${f.day}`;
  return open
    ? `<section class="seg" aria-labelledby="${id}" id="${f.day}">${bumper(id, `${f.day_name} update`, `Week ${f.week} · after ${f.day_name}'s games`, note(0))}${body}</section>`
    : `<details class="earlier" id="${f.day}"><summary>${e(f.day_name)}: ${e(c.headline || "update")}</summary>${body}</details>`;
}

/** The game-day updates under a week, newest first: the latest one open, earlier ones folded. */
export const dayTail = (docs: J[]): string =>
  docs.length ? docs.map((d, i) => daySection(d, i === 0)).join("") : "";

/** A week that has game-day updates but no recap yet: the newest update leads the page. */
export function dayPage(shell: string, docs: J[], site: Site, url: string, home: string, recaps: J[]): string {
  const f = docs[0].facts, c = docs[0].copy, league = f.league;
  const mark = words(league).slice(0, 2).map(first).join("").toUpperCase();
  const archive = recaps.map((d) => `<li><a href="${home}${d.facts.season}/${d.facts.week}/"><span class="arc-wk">Wk ${d.facts.week}</span>${e(d.copy.headline || "")}</a></li>`).reverse().join("");
  const body = mast(mark, league, `${f.season} · week ${f.week} live`) + `<main>${dayTail(docs)}</main>`
    + foot(league, archive, site);
  return finish(fill(shell, { title: e(`${c.headline || `${f.day_name} update`} · ${displayName(league)} Week ${f.week}`),
    description: e(c.dek || ""), image: "", image_alt: "", url: e(url), brand: e(displayName(league)), body }));
}

const mast = (mark: string, league: string, sub: string) => `<header class="mast"><div class="mast-in"><p class="mark" aria-hidden="true">${e(mark)}</p>`
  + `<p class="brand"><b>${e(league)}</b><span>${e(sub)}</span></p></div></header>`;

const foot = (league: string, archive: string, site: Site) => `<footer class="foot">`
  + (archive ? `<nav aria-labelledby="arc-h"><h2 id="arc-h" class="foot-h">Previously on ${e(league)}</h2><ul class="archive">${archive}</ul></nav>` : "")
  + `<p class="fine">${fine(site)}</p></footer>`;

export const fine = (site: Site) => `Numbers from Sleeper. Jokes from Claude. A recap every Tuesday morning, quick hits after every game day. `
  + `<a href="${site.origin}/">Get ${e(site.brand)} for your league</a>. Not affiliated with Sleeper.`;

/** The free preview's banner: the numbers are real, the jokes switch on with a season pass. */
export function previewBanner(site: Site, league: J, leagueId: string): string {
  const pay = site.payLink ? `<a class="btn" href="${e(`${site.payLink}?client_reference_id=${leagueId}`)}">Turn on the jokes · ${e(site.price)}</a>`
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

export function messagePage(shell: string, site: Site, title: string, text: string): string {
  const body = mast("?!", site.brand, title) + `<main><section class="seg"><div class="day"><h1 class="day-h">${e(title)}</h1><p class="dek">${e(text)}</p>`
    + `<p><a class="btn" href="${site.origin}/">Try another league</a></p></div></section></main>` + foot(site.brand, "", site);
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
    + `<p class="price">${e(site.price)}</p><p class="dek">Less than a waiver bid, split across the whole league.</p></div></section>`
    + `</main>` + foot(site.brand, "", site);
  return finish(fill(shell, { title: e(`${site.brand} · Weekly recaps for Sleeper leagues`), description: e("A weekly recap of your Sleeper fantasy league that reads like a sports column, with game-day updates."),
    image: "", image_alt: "", url: e(site.origin + "/"), brand: e(site.brand), body }));
}
