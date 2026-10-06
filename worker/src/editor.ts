// The commissioner's editor at /<league>/edit?key=...: rewrite any line of a posted recap or game-day update, and give
// the writer the league's intro and lore. No accounts: the private key is the login, shown after checkout (/paid) and
// printed by scripts/comp.ts.
import type { J } from "./facts.ts";
import { foot, finish, html, mast, messagePage, type Post, postDay, postUrl, type Site } from "./pages.ts";
import { esc as e, first, words } from "./py.ts";
import { displayName, fill } from "./render.ts";

const MAX = 2000; // characters per field
const TEXT: Record<string, string> = { headline: "Headline", dek: "Dek, the line under the headline", hero_value: "The number",
  hero_caption: "The number's caption", story_title: "Rundown title", signoff: "Signoff" };
const LINES = ["power_lines", "award_lines", "game_lines", "preview_lines"];

/** Every line of a post's copy as [field name, label, text], in page order. Only lines the post already has. */
export function fields(f: J, c: J): [string, string, string][] {
  const game = (g: J) => (g ? `: ${(g.win ?? g.a).team ?? g.a} vs ${(g.lose ?? g.b).team ?? g.b}` : "");
  const label: Record<string, (k: string) => string> = {
    power_lines: (k) => `Power rankings: ${k}`, award_lines: (k) => `Trophy: ${f.awards?.find((a: J) => a.key === k)?.label ?? k}`,
    game_lines: (k) => `Game ${k}${game(f.games?.[Number(k) - 1])}`, preview_lines: (k) => `Next week, game ${k}${game(f.next?.games?.[Number(k) - 1])}`,
  };
  const out: [string, string, string][] = [];
  for (const k of ["headline", "dek", "hero_value", "hero_caption"]) if (typeof c[k] === "string") out.push([k, TEXT[k]!, c[k]]);
  (c.pen_notes ?? []).forEach((n: string, i: number) => out.push([`pen_notes.${i}`, `Red marker note ${i + 1} (22 characters at most)`, n]));
  if (typeof c.story_title === "string") out.push(["story_title", TEXT.story_title!, c.story_title]);
  (c.story ?? []).forEach((p: string, i: number) => out.push([`story.${i}`, `Rundown, paragraph ${i + 1}`, p]));
  for (const list of LINES) for (const x of c[list] ?? []) out.push([`${list}.${x.key}`, label[list]!(x.key), x.line]);
  if (typeof c.signoff === "string") out.push(["signoff", TEXT.signoff!, c.signoff]);
  return out;
}

/** The copy with a submitted form applied. Only lines that already exist change; anything else in the form is ignored. */
export function apply(c: J, form: Iterable<[string, unknown]>): J {
  const out = structuredClone(c);
  for (const [name, raw] of form) {
    if (typeof raw !== "string") continue;
    const v = raw.replace(/\r\n?/g, "\n").trim().slice(0, MAX), dot = name.indexOf("."); // team names can hold dots: split once
    const [k, sub] = dot < 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot + 1)];
    if (dot < 0 && k in TEXT && typeof out[k] === "string") out[k] = v;
    else if ((k === "story" || k === "pen_notes") && /^\d+$/.test(sub) && Number(sub) < (out[k]?.length ?? 0)) out[k][Number(sub)] = v;
    else if (LINES.includes(k)) {
      const x = (out[k] ?? []).find((x: J) => x?.key === sub);
      if (x) x.line = v;
    }
  }
  return out;
}

const view = (shell: string, site: Site, lg: J, title: string, inner: string) => html(finish(fill(shell, {
  title: e(`${title} · ${displayName(lg.name)}`), description: "", image: "", image_alt: "", url: e(site.origin), brand: e(displayName(lg.name)),
  body: mast(words(lg.name).slice(0, 2).map(first).join("").toUpperCase(), lg.name, `${lg.season} · editor`)
    + `<main><section class="seg"><div class="day">${inner}</div></section></main>` + foot(lg.name, "", site),
})), 200, 0, true);

const box = (name: string, label: string, text: string, hint = "", max = MAX) => `<label>${e(label)}${hint ? `<span>${e(hint)}</span>` : ""}`
  + `<textarea name="${e(name)}" maxlength="${max}" rows="${Math.min(12, Math.ceil((text.length + 1) / 64))}">${e(text)}</textarea></label>`;

/** GET shows a form and POST saves it: the league's settings and its posts (no `post`), or one post's copy. */
export async function editor(req: Request, db: D1Database, site: Site, shell: string, slug: string): Promise<Response> {
  const url = new URL(req.url), form = req.method === "POST" ? await req.formData() : null;
  const param = (k: string) => String(form?.get(k) ?? url.searchParams.get(k) ?? "");
  const key = param("key");
  const lg = key && await db.prepare("SELECT league_id, slug, name, season, intro, lore FROM leagues WHERE slug = ? AND edit_key = ? ORDER BY season DESC LIMIT 1")
    .bind(slug, key).first<J>();
  if (!lg) return html(messagePage(shell, site, "Link not recognized", "That editor link doesn't match a league. Use the private link from your checkout page, or email support for a new one."), 404, 0, true);
  const home = `${site.origin}/${lg.slug}/`, self = `${home}edit?key=${encodeURIComponent(key)}`;
  const hidden = `<input type="hidden" name="key" value="${e(key)}">`;
  const post = param("post").match(/^(\d{1,2})\/(weekly|day-\d{4}-\d{2}-\d{2})$/);

  if (!post) {
    if (form) {
      const lore = param("lore").split("\n").map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 40);
      await db.prepare("UPDATE leagues SET intro = ?, lore = ? WHERE league_id = ?").bind(param("intro").trim().slice(0, MAX), JSON.stringify(lore), lg.league_id).run();
      return Response.redirect(`${self}&saved=1`, 303);
    }
    const posts = (await db.prepare(`SELECT season, week, kind, headline FROM recaps WHERE league_id = ? AND status = 'done' AND kind != 'preview'
      ORDER BY week DESC, kind = 'weekly' DESC, kind DESC`).bind(lg.league_id).all<Post>()).results;
    return view(shell, site, lg, "Editor", `<h1 class="day-h">Editor</h1>`
      + `<p class="dek">This page is private: anyone with its link can edit ${e(displayName(lg.name))}'s pages. Bookmark it and keep it to yourself.</p>`
      + (url.searchParams.has("saved") ? `<p class="pen">SAVED</p>` : "")
      + `<form class="ed-form" method="post">${hidden}`
      + box("intro", "The writer's brief", lg.intro, "Optional. Who the league is, in a sentence. Empty uses the default.")
      + box("lore", "League lore", JSON.parse(lg.lore || "[]").join("\n"), "One per line, up to 40 lines of 300 characters: in-jokes, rivalries, nicknames, past champions. The writer works them into the next recaps.", 40 * 301)
      + `<button class="btn" type="submit">Save</button></form>`
      + `<h2 class="day-h">Fix a post</h2><ol class="posts" role="list">${posts.map((p) => `<li><a class="post${p.kind === "weekly" ? " recap" : ""}" `
        + `href="${e(`${self}&post=${p.week}/${p.kind}`)}"><span class="sum-day">${postDay(p)}</span><span class="sum-h"><b>${e(p.headline || "")}</b>`
        + `<span>Week ${p.week}</span></span></a></li>`).join("") || "<li>Nothing posted yet.</li>"}</ol>`);
  }

  const week = post[1]!, kind = post[2]!;
  const where = [lg.league_id, lg.season, Number(week), kind];
  const row = await db.prepare("SELECT doc FROM recaps WHERE league_id = ? AND season = ? AND week = ? AND kind = ? AND status = 'done'").bind(...where).first<{ doc: string }>();
  if (!row) return html(messagePage(shell, site, "Post not found", "That post doesn't exist (yet).", `<p><a class="btn" href="${e(self)}">Back to the editor</a></p>`), 404, 0, true);
  const doc = JSON.parse(row.doc), live = postUrl(home, { season: lg.season, week: Number(week), kind, headline: null });
  if (form) {
    doc.copy = apply(doc.copy, form);
    await db.prepare("UPDATE recaps SET headline = ?, dek = ?, doc = ? WHERE league_id = ? AND season = ? AND week = ? AND kind = ?")
      .bind(doc.copy.headline ?? null, doc.copy.dek ?? null, JSON.stringify(doc), ...where).run();
    return Response.redirect(live.replace(/\/(#|$)/, `/?edited=${Date.now()}$1`), 303); // a fresh URL: the browser may still hold the old page
  }
  const what = kind === "weekly" ? `Week ${week} recap` : `${doc.facts.day_name} update, week ${week}`;
  return view(shell, site, lg, what, `<h1 class="day-h">${e(what)}</h1><p class="dek"><a href="${e(live)}">See it live</a>. Saved changes show within a minute.</p>`
    + `<form class="ed-form" method="post">${hidden}<input type="hidden" name="post" value="${e(`${week}/${kind}`)}">`
    + fields(doc.facts, doc.copy).map(([name, label, text]) => box(name, label, text)).join("")
    + `<button class="btn" type="submit">Save</button></form><p class="dek"><a href="${e(self)}">Back to the editor</a></p>`);
}
