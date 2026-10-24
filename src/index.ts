import * as path from "path";
import { Checker } from "./checker";
import { fail, KitmlError } from "./errors";
import { parseFile } from "./parser";
import { Realm } from "./realm";
import { buildCovenants, FileCache, layer, loadFiles, materialize, SoulData, todayFor } from "./resolver";
import { dateIn, instant } from "./time";
import { UnitRegistry } from "./units";

export { KitmlError, ERROR_NAMES } from "./errors";
export type { Loc } from "./errors";
export { Realm, Quantity, Sealed } from "./realm";
export type { OriginInfo, LinkRef, TimelineEvent, Soul } from "./realm";
export { parseFile } from "./parser";
export { UnitRegistry } from "./units";
export type { Value } from "./values";
export { toKitml } from "./values";

export const VERSION = "0.1.0";

export interface LoadOptions {
  /** Circles to apply, by name. Circles marked `always` apply regardless. */
  circles?: string[];
  /** Moment for time windows and `today`: a Kitml date/timestamp, a Date, or epoch ms. Default: now. */
  at?: string | number | Date;
  /** Allow `possess` to reach files outside the entry file's folder. */
  allowOutside?: boolean;
  /** Also fail on plain-text values inside `sealed to` blocks (K-701). */
  strict?: boolean;
  /** Reserved for decryption keys. Engine 0.1 cannot decrypt, so this is ignored. */
  keys?: Record<string, string>;
}

function resolveAt(at: LoadOptions["at"], zone: string): number {
  if (at === undefined) return Date.now();
  if (at instanceof Date) return at.getTime();
  if (typeof at === "number") return at;
  return instant(at, zone);
}

function build(entry: string, opts: LoadOptions, cache: FileCache): Realm {
  const files = loadFiles(entry, !!opts.allowOutside, cache);
  for (const f of files) if (f.zone) instant("2000-01-01", f.zone, { file: f.file, line: 1, col: 1 });
  const zone = files[0].zone ?? "UTC";
  const at = resolveAt(opts.at, zone);

  const units = new UnitRegistry();
  for (const f of files) {
    for (const u of f.units) {
      for (const d of u.defs) {
        if (d.value.k !== "num") continue;
        let factor = d.value.v;
        if (d.value.unit) {
          if (!units.hasFamily(u.family)) fail("K-302", `The first unit of the new family "${u.family}" must be a plain number`, d.loc);
          factor *= units.baseFactor(d.value.unit, u.family, d.loc);
        }
        units.define(d.sym, u.family, factor, d.loc);
      }
    }
  }

  const covenants = buildCovenants(files.flatMap((f) => f.covenants), units);
  const layered = layer(files, opts.circles ?? [], at, zone);
  const souls = new Map<string, SoulData>();
  for (const id of layered.order) souls.set(id, materialize(layered.souls.get(id)!));

  new Checker({ souls, order: layered.order, covenants, units, today: todayFor(at, zone), zone, strict: !!opts.strict }).run();

  return new Realm({
    souls, order: layered.order, covenants, units, windows: layered.windows,
    activeCircles: layered.activeCircles, at, zone, files: files.map((f) => f.file),
  });
}

/** Loads and checks a realm at one moment. Throws KitmlError on the first problem. */
export function load(file: string, opts: LoadOptions = {}): Realm {
  return build(path.resolve(file), opts, new Map());
}

/** Loads a realm from text instead of a file. `possess` paths resolve against `filename`. */
export function loadText(text: string, opts: LoadOptions & { filename?: string } = {}): Realm {
  const file = path.resolve(opts.filename ?? "inline.kitml");
  const cache: FileCache = new Map([[file, parseFile(text, file)]]);
  return build(file, opts, cache);
}

export interface CheckResult {
  realm: Realm;
  /** Number of moments checked: `at` plus every future window boundary. */
  moments: number;
}

/**
 * Loads a realm and then checks it again at every future time-window boundary,
 * so a value that will expire into an invalid state is caught today.
 */
export function check(file: string, opts: LoadOptions = {}): CheckResult {
  const entry = path.resolve(file);
  const cache: FileCache = new Map();
  const realm = build(entry, opts, cache);
  const zone = (cache.get(entry)?.zone) ?? "UTC";
  const boundaries = realm.futureBoundaries();
  for (const ms of boundaries) {
    try {
      build(entry, { ...opts, at: ms }, cache);
    } catch (e) {
      if (e instanceof KitmlError) {
        throw new KitmlError(e.code, `${e.message}. This becomes true on ${dateIn(ms, zone)}, when a time window starts or ends`, e.loc, e.hint);
      }
      throw e;
    }
  }
  return { realm, moments: boundaries.length + 1 };
}
