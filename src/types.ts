import { fail, Loc } from "./errors";
import { LiteralReader } from "./literal";
import { Value } from "./values";

/** The type part of a covenant term, e.g. `number GB`, `list of -> Lens`. */
export type TypeExpr =
  | { t: "text" }
  | { t: "bool" }
  | { t: "date" }
  | { t: "timestamp" }
  | { t: "any" }
  | { t: "number"; unit?: string }
  | { t: "fraction"; unit?: string }
  | { t: "oneof"; options: string[] }
  | { t: "list"; of: TypeExpr }
  | { t: "link"; cov: string }
  | { t: "cov"; name: string }
  | { t: "shape"; fields: Map<string, TypeExpr> };

export interface Rules {
  optional: boolean;
  default?: Value;
  between?: [Value, Value];
  whole: boolean;
  matching?: { source: string; re: RegExp };
  length?: [number, number];
  unique: boolean;
}

export interface Term {
  field: string;
  type: TypeExpr;
  rules: Rules;
  bound: boolean;
  sealed: boolean;
  loc: Loc;
}

const RULE_WORDS = new Set(["optional", "default", "between", "whole", "matching", "length", "unique"]);
const UNIT_TOKEN = /^(?:%|[A-Za-z][A-Za-z0-9]*(?:[/*][A-Za-z][A-Za-z0-9]*)*)/;

function word(r: LiteralReader): string | undefined {
  r.peek();
  const m = /^(?:->|[A-Za-z][\w-]*)/.exec(r.rest);
  return m ? m[0] : undefined;
}

function take(r: LiteralReader, w: string): void {
  if (word(r) !== w) fail("K-105", `Expected "${w}" but found "${r.rest.trim() || "end of line"}"`, r.loc);
  r.pos += w.length;
}

function optionalUnit(r: LiteralReader): string | undefined {
  const save = r.pos;
  if (r.s[r.pos] !== " ") return undefined;
  r.peek();
  const m = UNIT_TOKEN.exec(r.rest);
  if (!m || RULE_WORDS.has(m[0]) || m[0] === "and") {
    r.pos = save;
    return undefined;
  }
  const after = r.rest[m[0].length] ?? "";
  if (after !== "" && !/[\s,}\]]/.test(after)) {
    r.pos = save;
    return undefined;
  }
  r.pos += m[0].length;
  return m[0];
}

export function readType(r: LiteralReader): TypeExpr {
  if (r.peek() === "{") {
    r.pos++;
    const fields = new Map<string, TypeExpr>();
    while (r.peek() !== "}") {
      const name = word(r);
      if (!name) fail("K-105", "Expected a field name in shape", r.loc);
      r.pos += name.length;
      r.expect(":");
      fields.set(name, readType(r));
      if (r.peek() === ",") r.pos++;
      else if (r.peek() !== "}") fail("K-105", "Expected `,` or `}` in shape", r.loc);
    }
    r.pos++;
    return { t: "shape", fields };
  }
  const w = word(r);
  if (!w) fail("K-105", `Expected a type but found "${r.rest.trim() || "end of line"}"`, r.loc);
  r.pos += w.length;
  switch (w) {
    case "->": {
      const cov = word(r);
      if (!cov) fail("K-105", "Expected a covenant name after ->", r.loc);
      r.pos += cov.length;
      return { t: "link", cov };
    }
    case "text": return { t: "text" };
    case "bool": return { t: "bool" };
    case "date": return { t: "date" };
    case "timestamp": return { t: "timestamp" };
    case "any": return { t: "any" };
    case "number": case "fraction": {
      const unit = optionalUnit(r);
      return unit ? { t: w, unit } : { t: w };
    }
    case "one": {
      take(r, "of");
      r.expect("[");
      const options: string[] = [];
      while (r.peek() !== "]") {
        const o = word(r);
        if (!o) fail("K-105", "Expected a symbol in `one of` list", r.loc);
        r.pos += o.length;
        options.push(o);
        if (r.peek() === ",") r.pos++;
        else if (r.peek() !== "]") fail("K-105", "Expected `,` or `]` in `one of` list", r.loc);
      }
      r.pos++;
      return { t: "oneof", options };
    }
    case "list": {
      take(r, "of");
      return { t: "list", of: readType(r) };
    }
    default:
      if (RULE_WORDS.has(w)) fail("K-105", `Expected a type before "${w}"`, r.loc);
      return { t: "cov", name: w };
  }
}

/** Parses `type rule rule ...` from a covenant term. */
export function parseTermType(text: string, loc: Loc): { type: TypeExpr; rules: Rules } {
  const r = new LiteralReader(text, loc);
  const type = readType(r);
  const rules: Rules = { optional: false, whole: false, unique: false };
  while (!r.atEnd()) {
    const w = word(r);
    if (!w || !RULE_WORDS.has(w)) fail("K-105", `Unknown rule "${r.rest.trim()}"`, loc);
    r.pos += w.length;
    switch (w) {
      case "optional": rules.optional = true; break;
      case "whole": rules.whole = true; break;
      case "unique": rules.unique = true; break;
      case "default": rules.default = r.readValue(); rules.optional = true; break;
      case "between": {
        const lo = r.readValue();
        take(r, "and");
        rules.between = [lo, r.readValue()];
        break;
      }
      case "length": {
        take(r, "between");
        const lo = r.readValue();
        take(r, "and");
        const hi = r.readValue();
        if (lo.k !== "num" || hi.k !== "num") fail("K-203", "Length bounds must be plain numbers", loc);
        rules.length = [lo.v, hi.v];
        break;
      }
      case "matching": {
        if (r.peek() !== '"') fail("K-105", "`matching` needs a quoted regular expression", loc);
        const source = r.readString();
        try {
          rules.matching = { source, re: new RegExp(source, "u") };
        } catch (e) {
          fail("K-105", `Invalid regular expression: ${(e as Error).message}`, loc);
        }
        break;
      }
    }
  }
  return { type, rules };
}

export function parseTypeOnly(text: string, loc: Loc): TypeExpr {
  const r = new LiteralReader(text, loc);
  const t = readType(r);
  if (!r.atEnd()) fail("K-105", `Unexpected "${r.rest.trim()}" after type`, loc);
  return t;
}

export function describeType(t: TypeExpr): string {
  switch (t.t) {
    case "number": case "fraction": return t.unit ? `${t.t} ${t.unit}` : t.t;
    case "oneof": return `one of [${t.options.join(", ")}]`;
    case "list": return `list of ${describeType(t.of)}`;
    case "link": return `-> ${t.cov}`;
    case "cov": return t.name;
    case "shape": return "{ " + [...t.fields].map(([k, v]) => `${k}: ${describeType(v)}`).join(", ") + " }";
    default: return t.t;
  }
}
