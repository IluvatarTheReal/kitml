/** Runtime representation of every Kitml value. */
export type Value =
  | TextV
  | NumV
  | BoolV
  | VoidV
  | DateV
  | TsV
  | SymV
  | ListV
  | GroupV
  | LinkV
  | SealedV;

export interface TextV { k: "text"; v: string }
/** A number, optionally with a unit and an exact fraction (n/d). */
export interface NumV { k: "num"; v: number; unit?: string; frac?: [number, number] }
export interface BoolV { k: "bool"; v: boolean }
export interface VoidV { k: "void" }
export interface DateV { k: "date"; v: string }
export interface TsV { k: "ts"; v: string }
export interface SymV { k: "sym"; v: string }
export interface ListV { k: "list"; items: Value[] }
export interface GroupV { k: "group"; fields: Map<string, Value> }
export interface LinkV { k: "link"; id: string }
/** An encrypted value. Engine 0.1 cannot decrypt, so only recipients are known. */
export interface SealedV { k: "sealed"; to: string[]; cipher?: string }

export const VOID: VoidV = { k: "void" };
export const text = (v: string): TextV => ({ k: "text", v });
export const num = (v: number, unit?: string): NumV => (unit ? { k: "num", v, unit } : { k: "num", v });
export const bool = (v: boolean): BoolV => ({ k: "bool", v });
export const sym = (v: string): SymV => ({ k: "sym", v });
export const group = (entries?: Iterable<[string, Value]>): GroupV => ({ k: "group", fields: new Map(entries ?? []) });

/** Removes floating-point noise: 0.1 + 0.2 prints as 0.3. */
export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(12)));
}

export function fmtQuantity(n: NumV): string {
  const base = n.frac ? `${n.frac[0]}/${n.frac[1]}` : fmtNum(n.v);
  return n.unit ? `${base} ${n.unit}` : base;
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

/** Renders a value the way it would be written in a .kitml file. */
export function toKitml(v: Value): string {
  switch (v.k) {
    case "text": return quote(v.v);
    case "num": return fmtQuantity(v);
    case "bool": return v.v ? "true" : "false";
    case "void": return "void";
    case "date": case "ts": case "sym": return v.v;
    case "list": return "[" + v.items.map(toKitml).join(", ") + "]";
    case "group": return "{ " + [...v.fields].map(([k, x]) => `${k}: ${toKitml(x)}`).join(", ") + " }";
    case "link": return `-> ${v.id}`;
    case "sealed": return v.cipher ? `sealed ${quote(v.cipher)}` : "<sealed>";
  }
}

/** Plain-text rendering used inside interpolated strings. */
export function toPlain(v: Value): string {
  switch (v.k) {
    case "text": return v.v;
    case "link": return v.id;
    case "sealed": return "<sealed>";
    case "list": return v.items.map(toPlain).join(", ");
    default: return toKitml(v);
  }
}

/** JSON form used by `kitml to json` and Realm.toJSON(). */
export function toJSONValue(v: Value): unknown {
  switch (v.k) {
    case "text": case "date": case "ts": case "sym": return v.v;
    case "bool": return v.v;
    case "void": return null;
    case "num": {
      if (!v.unit && !v.frac) return Number(fmtNum(v.v));
      const out: Record<string, unknown> = { value: Number(fmtNum(v.v)) };
      if (v.frac) out.fraction = `${v.frac[0]}/${v.frac[1]}`;
      if (v.unit) out.unit = v.unit;
      return out;
    }
    case "list": return v.items.map(toJSONValue);
    case "group": {
      const o: Record<string, unknown> = {};
      for (const [k, x] of v.fields) o[k] = toJSONValue(x);
      return o;
    }
    case "link": return { $link: v.id };
    case "sealed": return { $sealed: v.to };
  }
}

export function clone(v: Value): Value {
  switch (v.k) {
    case "list": return { k: "list", items: v.items.map(clone) };
    case "group": return { k: "group", fields: new Map([...v.fields].map(([k, x]) => [k, clone(x)])) };
    case "num": return { ...v, frac: v.frac ? [v.frac[0], v.frac[1]] : undefined };
    case "sealed": return { ...v, to: [...v.to] };
    default: return { ...v };
  }
}

export function typeName(v: Value): string {
  switch (v.k) {
    case "text": return "text";
    case "num": return v.unit ? `quantity (${v.unit})` : v.frac ? "fraction" : "number";
    case "bool": return "boolean";
    case "void": return "void";
    case "date": return "date";
    case "ts": return "timestamp";
    case "sym": return `symbol ${v.v}`;
    case "list": return "list";
    case "group": return "group";
    case "link": return "link";
    case "sealed": return "sealed value";
  }
}
