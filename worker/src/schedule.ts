// What's due: decided from Sleeper's NFL schedule and the clock, so Thursday, Saturday, holiday and international
// games all just work.
import type { J } from "./facts.ts";

export interface Due { week: number; kind: string } // kind: "weekly" or "day-<date>"

const HOUR = 3600e3;
const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);

/** A game-day update once all of a day's games are final (for 60 hours after that day; older ones are skipped), and
 *  the weekly recap at 13:00 UTC the day after a week's last game (Tuesday 9am Eastern), for five days after. */
export function due(schedule: J[], now: number): Due[] {
  const byWeek = new Map<number, J[]>();
  for (const x of schedule) byWeek.set(x.week, [...(byWeek.get(x.week) ?? []), x]);
  const out: Due[] = [];
  for (const [week, games] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    const dates = [...new Set(games.map((x) => x.date as string))].sort();
    for (const date of dates) {
      const day = games.filter((x) => x.date === date);
      if (day.every((x) => x.status === "complete") && now - noon(date) < 60 * HOUR && now > noon(date)) out.push({ week, kind: `day-${date}` });
    }
    const recapAt = noon(dates.at(-1)!) + 25 * HOUR; // 13:00 UTC the next day
    if (games.every((x) => x.status === "complete") && now >= recapAt && now - recapAt < 120 * HOUR) out.push({ week, kind: "weekly" });
  }
  return out;
}
