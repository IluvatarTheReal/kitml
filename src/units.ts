import { fail, Loc } from "./errors";

/** Exponents of base dimensions, e.g. km/h = { L: 1, T: -1 }. */
export type Dims = Record<string, number>;

export interface UnitDef {
  sym: string;
  family: string;
  dims: Dims;
  /** Multiply by this to reach the family's base unit. */
  factor: number;
  /** Added after the factor (temperatures only). */
  offset: number;
}

export interface ParsedUnit {
  atoms: Map<string, number>;
  dims: Dims;
  factor: number;
  offset: number;
}

/** Built-in families: name, base dimension, units as [symbol, factor, offset?]. */
const BUILTIN: [string, Dims, [string, number, number?][]][] = [
  ["length", { L: 1 }, [["mm", 0.001], ["cm", 0.01], ["m", 1], ["km", 1000], ["in", 0.0254], ["ft", 0.3048], ["mi", 1609.344]]],
  ["volume", { L: 3 }, [["ml", 1e-6], ["cl", 1e-5], ["l", 1e-3], ["m3", 1], ["floz", 2.95735295625e-5], ["gal", 3.785411784e-3]]],
  ["mass", { M: 1 },[["mg", 0.001], ["g", 1], ["kg", 1000], ["oz", 28.349523125], ["lb", 453.59237]]],
  ["time", { T: 1 }, [["ms", 0.001], ["s", 1], ["min", 60], ["h", 3600], ["d", 86400], ["w", 604800]]],
  ["data", { D: 1 }, [
    ["B", 1], ["KB", 1e3], ["MB", 1e6], ["GB", 1e9], ["TB", 1e12],
    ["KiB", 1024], ["MiB", 1024 ** 2], ["GiB", 1024 ** 3], ["TiB", 1024 ** 4],
  ]],
  ["temperature", { K: 1 }, [["K", 1, 0], ["C", 1, 273.15], ["F", 5 / 9, 459.67 * 5 / 9]]],
  ["frequency", { T: -1 }, [["Hz", 1], ["kHz", 1e3], ["MHz", 1e6], ["GHz", 1e9]]],
  ["image", { PX: 1 }, [["px", 1], ["MP", 1e6]]],
  ["ratio", { PCT: 1 }, [["%", 1]]],
];

function dimsEqual(a: Dims, b: Dims): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

function addDims(target: Dims, d: Dims, exp: number): void {
  for (const [k, e] of Object.entries(d)) {
    target[k] = (target[k] ?? 0) + e * exp;
    if (target[k] === 0) delete target[k];
  }
}

export class UnitRegistry {
  private defs = new Map<string, UnitDef>();
  private families = new Map<string, Dims>();

  constructor() {
    for (const [family, dims, units] of BUILTIN) {
      this.families.set(family, dims);
      for (const [sym, factor, offset] of units) this.defs.set(sym, { sym, family, dims, factor, offset: offset ?? 0 });
    }
    this.families.set("money", {});
  }

  hasFamily(name: string): boolean {
    return this.families.has(name);
  }

  /** Declares a unit from a `unit ... family ... seal` block. */
  define(sym: string, family: string, factorToBase: number, loc?: Loc): void {
    if (this.defs.has(sym) || /^[A-Z]{3}$/.test(sym)) fail("K-301", `Unit "${sym}" is already defined`, loc);
    if (family === "money") fail("K-301", "Currencies cannot be declared; any ISO 4217 code is already a unit", loc);
    let dims = this.families.get(family);
    if (!dims) {
      dims = { [`fam:${family}`]: 1 };
      this.families.set(family, dims);
    }
    this.defs.set(sym, { sym, family, dims, factor: factorToBase, offset: 0 });
  }

  /** Factor of a unit expression relative to its family base, for custom unit declarations. */
  baseFactor(unit: string, family: string, loc?: Loc): number {
    const p = this.parse(unit, loc);
    const famDims = this.families.get(family);
    if (famDims && !dimsEqual(famDims, p.dims)) fail("K-302", `"${unit}" is not a ${family} unit`, loc);
    return p.factor;
  }

  atom(sym: string): UnitDef | undefined {
    const d = this.defs.get(sym);
    if (d) return d;
    if (/^[A-Z]{3}$/.test(sym)) return { sym, family: "money", dims: { [`$${sym}`]: 1 }, factor: 1, offset: 0 };
    return undefined;
  }

  isUnit(s: string): boolean {
    try {
      this.parse(s);
      return true;
    } catch {
      return false;
    }
  }

  /** Parses a unit expression such as "GB", "km/h", "cm2" or "m*s". */
  parse(unit: string, loc?: Loc): ParsedUnit {
    const exact = this.atom(unit);
    if (exact) return { atoms: new Map([[unit, 1]]), dims: { ...exact.dims }, factor: exact.factor, offset: exact.offset };
    const slash = unit.split("/");
    if (slash.length > 2 || unit.length === 0) fail("K-301", `Unknown unit "${unit}"`, loc);
    const atoms = new Map<string, number>();
    const dims: Dims = {};
    let factor = 1;
    slash.forEach((side, i) => {
      const sign = i === 0 ? 1 : -1;
      if (i === 0 && side === "1" && slash.length === 2) return;
      for (const part of side.split(/[*·]/)) {
        const m = /^(.+?)(\d*)$/.exec(part);
        const def = m && this.atom(m[1]);
        if (!m || !def) fail("K-301", `Unknown unit "${unit}"`, loc);
        const exp = (m[2] ? parseInt(m[2], 10) : 1) * sign;
        atoms.set(m[1], (atoms.get(m[1]) ?? 0) + exp);
        addDims(dims, def.dims, exp);
        factor *= def.factor ** exp;
      }
    });
    return { atoms, dims, factor, offset: 0 };
  }

  family(unit: string): string | undefined {
    const a = this.atom(unit);
    return a?.family;
  }

  isMoney(unit: string | undefined): boolean {
    return !!unit && /^[A-Z]{3}$/.test(unit) && !this.defs.has(unit);
  }

  sameDims(a: string, b: string): boolean {
    return dimsEqual(this.parse(a).dims, this.parse(b).dims);
  }

  /** Converts a value between two units of the same dimension. */
  convert(v: number, from: string, to: string, loc?: Loc): number {
    if (from === to) return v;
    const a = this.parse(from, loc);
    const b = this.parse(to, loc);
    if (!dimsEqual(a.dims, b.dims)) fail("K-302", `Cannot convert ${from} to ${to}`, loc);
    const base = v * a.factor + a.offset;
    return (base - b.offset) / b.factor;
  }

  /**
   * Combines two units for multiplication (sign 1) or division (sign -1).
   * Returns the resulting unit (undefined when dimensionless) and a scale
   * that must be applied to the numeric result, e.g. m / km cancels with scale 0.001.
   */
  combine(u1: string | undefined, u2: string | undefined, sign: 1 | -1): { unit?: string; scale: number } {
    const result = new Map<string, number>(u1 ? this.parse(u1).atoms : []);
    let scale = 1;
    if (u2) {
      for (const [sym, e] of this.parse(u2).atoms) {
        const exp = e * sign;
        if (result.has(sym)) {
          result.set(sym, result.get(sym)! + exp);
          continue;
        }
        const def = this.atom(sym)!;
        let merged = false;
        for (const [other] of result) {
          const od = this.atom(other)!;
          if (dimsEqual(od.dims, def.dims)) {
            scale *= (def.factor / od.factor) ** exp;
            result.set(other, result.get(other)! + exp);
            merged = true;
            break;
          }
        }
        if (!merged) result.set(sym, exp);
      }
    }
    for (const [k, e] of result) if (e === 0) result.delete(k);
    return { unit: renderAtoms(result), scale };
  }
}

function renderAtoms(atoms: Map<string, number>): string | undefined {
  if (atoms.size === 0) return undefined;
  const part = (list: [string, number][]) => list.map(([s, e]) => (e === 1 ? s : `${s}${e}`)).join("*");
  const num = [...atoms].filter(([, e]) => e > 0);
  const den = [...atoms].filter(([, e]) => e < 0).map(([s, e]) => [s, -e] as [string, number]);
  if (den.length === 0) return part(num);
  return `${num.length ? part(num) : "1"}/${part(den)}`;
}
