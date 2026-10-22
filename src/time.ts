import { fail, Loc } from "./errors";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, loc?: Loc): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      fail("K-105", `Unknown time zone "${zone}"`, loc, "Use an IANA zone name such as America/Toronto or Europe/Paris.");
    }
    formatters.set(zone, f);
  }
  return f;
}

function parts(ms: number, zone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Offset of `zone` from UTC at the given instant, in milliseconds. */
function offsetMs(ms: number, zone: string): number {
  const p = parts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Converts a Kitml date or timestamp to epoch milliseconds. Dates mean midnight in `zone`. */
export function instant(s: string, zone: string = "UTC", loc?: Loc): number {
  formatter(zone, loc);
  let m = DATE.exec(s);
  let wall: number;
  if (m) {
    wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  } else if ((m = TS.exec(s))) {
    const ms = m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0;
    wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms);
    if (m[8]) {
      if (m[8] === "Z") return wall;
      const sign = m[8][0] === "-" ? -1 : 1;
      const [hh, mm] = m[8].slice(1).split(":").map(Number);
      return wall - sign * (hh * 60 + mm) * 60000;
    }
  } else {
    fail("K-203", `"${s}" is not a date or timestamp`, loc);
  }
  const check = new Date(wall);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== +m[3]) fail("K-204", `"${s}" is not a real calendar date`, loc);
  // Wall-clock time in the zone: subtract the zone offset (twice, to settle DST edges).
  let guess = wall - offsetMs(wall, zone);
  guess = wall - offsetMs(guess, zone);
  return guess;
}

/** The calendar date of an instant in `zone`, as YYYY-MM-DD. */
export function dateIn(ms: number, zone: string = "UTC"): string {
  const p = parts(ms, zone);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function isDateText(s: string): boolean {
  return DATE.test(s) || TS.test(s);
}
