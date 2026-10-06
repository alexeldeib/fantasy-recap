// Python's number formatting, rounding, sums and ordering, so the port renders the same pages as the Python engine.

/** f"{x:.{d}f}": round half to even on the float's exact value (JS toFixed rounds exact ties up). */
export function fixed(x: number, d: number): string {
  const [int, frac] = Math.abs(x).toFixed(100).split(".") as [string, string]; // exact for every float we format
  let n = BigInt(int + frac.slice(0, d));
  const rest = frac.slice(d);
  if (rest[0]! > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || n % 2n === 1n))) n += 1n;
  const s = n.toString().padStart(d + 1, "0");
  return (x < 0 || Object.is(x, -0) ? "-" : "") + (d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s);
}

/** round(x, d) */
export const pyround = (x: number, d = 0): number => Number(fixed(x, d));

/** f"{x:+.{d}f}" */
export const signed = (x: number, d: number): string => (x < 0 || Object.is(x, -0) ? "" : "+") + fixed(x, d);

/** f"{x:g}" for the magnitudes we print (percentages, stat counts): six significant digits, no trailing zeros. */
export const g = (x: number): string => String(Number(x.toPrecision(6)));

/** sum() of floats: CPython 3.12+ adds them with Neumaier compensation. */
export function fsum(xs: Iterable<number>): number {
  let s = 0, c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

export type Key = number | string | boolean | null | Key[];

/** Python's ordering for tuples of numbers and strings: element by element, the shorter tuple first on a tie. */
export function cmp(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i]!, b[i]!);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0; // ponytail: UTF-16 order; Python compares code points (differs only past U+FFFF)
  return Number(a) - Number(b);
}

/** max(xs, key=key): the first of the largest. */
export function maxBy<T>(xs: Iterable<T>, key: (x: T) => Key): T | undefined {
  let best: T | undefined, bestKey: Key = null, any = false;
  for (const x of xs) {
    const k = key(x);
    if (!any || cmp(k, bestKey) > 0) [best, bestKey, any] = [x, k, true];
  }
  return best;
}

/** min(xs, key=key): the first of the smallest. */
export function minBy<T>(xs: Iterable<T>, key: (x: T) => Key): T | undefined {
  let best: T | undefined, bestKey: Key = null, any = false;
  for (const x of xs) {
    const k = key(x);
    if (!any || cmp(k, bestKey) < 0) [best, bestKey, any] = [x, k, true];
  }
  return best;
}

/** sorted(xs, key=key, reverse=reverse): stable both ways, as Python's is. */
export function sortBy<T>(xs: Iterable<T>, key: (x: T) => Key, reverse = false): T[] {
  return [...xs].map((x) => [key(x), x] as const).sort((a, b) => (reverse ? -1 : 1) * cmp(a[0], b[0])).map(([, x]) => x);
}

/** html.escape(s, quote) */
export function esc(s: unknown, quote = true): string {
  const out = String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return quote ? out.replaceAll('"', "&quot;").replaceAll("'", "&#x27;") : out;
}

/** str.split() with no arguments: whitespace runs, no empty strings. */
export const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** s[:1] by code point, so an emoji isn't cut in half. */
export const first = (s: string): string => [...s][0] ?? "";

/** Python's \w for str patterns. */
export const W = String.raw`[\p{L}\p{N}_]`;
