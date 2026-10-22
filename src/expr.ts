import { fail, Loc } from "./errors";
import { parseNumberText } from "./literal";
import { instant } from "./time";
import { UnitRegistry } from "./units";
import { fmtQuantity, NumV, toPlain, Value, VOID } from "./values";

/** A reference to a whole soul, produced by following links or by all(). */
export interface SoulRef { k: "soul"; id: string }
/** Any value an expression can produce. */
export type EV = Value | SoulRef;

export type Node =
  | { n: "lit"; v: Value }
  | { n: "str"; parts: (string | Node)[] }
  | { n: "id"; name: string }
  | { n: "member"; obj: Node; name: string }
  | { n: "index"; obj: Node; idx: Node }
  | { n: "call"; name: string; args: Node[] }
  | { n: "bin"; op: string; l: Node; r: Node }
  | { n: "not"; e: Node }
  | { n: "neg"; e: Node }
  | { n: "if"; c: Node; a: Node; b: Node }
  | { n: "where"; list: Node; cond: Node }
  | { n: "conv"; e: Node; unit: string }
  | { n: "list"; items: Node[] }
  | { n: "today" };

interface Tok { t: "num" | "frac" | "date" | "str" | "id" | "op" | "eof"; v: string; start: number; end: number }

const KEYWORDS = new Set(["and", "or", "not", "if", "then", "else", "where", "in", "true", "false", "void", "today"]);

function tokenize(src: string, loc: Loc): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const push = (t: Tok["t"], v: string, start: number) => out.push({ t, v, start, end: i });
  while (i < src.length) {
    const c = src[i];
    if (c === " ") { i++; continue; }
    const rest = src.slice(i);
    const start = i;
    let m: RegExpExecArray | null;
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      if (i >= src.length) fail("K-102", "Text in expression is missing its closing quote", loc);
      i++;
      push("str", src.slice(start + 1, i - 1), start);
    } else if ((m = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?(?![\w-])/.exec(rest))) {
      i += m[0].length; push("date", m[0], start);
    } else if ((m = /^\d+\/\d+(?![\w.])/.exec(rest))) {
      i += m[0].length; push("frac", m[0], start);
    } else if ((m = /^(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(rest))) {
      i += m[0].length; push("num", m[0], start);
    } else if ((m = /^(?:%|[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*)/.exec(rest))) {
      i += m[0].length; push("id", m[0], start);
    } else if ((m = /^(?:==|!=|<=|>=|[<>+\-*/()[\],.])/.exec(rest))) {
      i += m[0].length; push("op", m[0], start);
    } else {
      fail("K-105", `Unexpected "${c}" in expression`, loc);
    }
  }
  out.push({ t: "eof", v: "", start: i, end: i });
  return out;
}

class Parser {
  private p = 0;
  private toks: Tok[];
  constructor(private src: string, private loc: Loc, private units: UnitRegistry) {
    this.toks = tokenize(src, loc);
  }
  private get cur(): Tok { return this.toks[this.p]; }
  private at(v: string): boolean { const t = this.cur; return (t.t === "op" || t.t === "id") && t.v === v; }
  private eat(v: string): boolean { if (this.at(v)) { this.p++; return true; } return false; }
  private need(v: string): void {
    if (!this.eat(v)) fail("K-105", `Expected "${v}" in expression but found "${this.cur.v || "end"}"`, this.loc);
  }

  /** Parses one expression; leaves the parser at the first token it cannot use. */
  parse(): Node { return this.ifExpr(); }
  get done(): boolean { return this.cur.t === "eof"; }
  remaining(): Tok[] { return this.toks.slice(this.p, -1); }

  private ifExpr(): Node {
    if (this.eat("if")) {
      const c = this.ifExpr(); this.need("then");
      const a = this.ifExpr(); this.need("else");
      return { n: "if", c, a, b: this.ifExpr() };
    }
    let e = this.or();
    while (this.eat("where")) e = { n: "where", list: e, cond: this.or() };
    return e;
  }
  private or(): Node { let e = this.and(); while (this.eat("or")) e = { n: "bin", op: "or", l: e, r: this.and() }; return e; }
  private and(): Node { let e = this.not(); while (this.eat("and")) e = { n: "bin", op: "and", l: e, r: this.not() }; return e; }
  private not(): Node { return this.eat("not") ? { n: "not", e: this.not() } : this.cmp(); }
  private cmp(): Node {
    const l = this.conv();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"]) if (this.cur.t === "op" && this.cur.v === op) { this.p++; return { n: "bin", op, l, r: this.conv() }; }
    return l;
  }
  private conv(): Node {
    const e = this.add();
    if (this.at("in") && this.toks[this.p + 1].t === "id") {
      this.p++;
      const unit = this.unitAt();
      if (!unit) fail("K-301", `Unknown unit "${this.cur.v}"`, this.loc);
      return { n: "conv", e, unit };
    }
    return e;
  }
  private add(): Node {
    let e = this.mul();
    while (this.cur.t === "op" && (this.cur.v === "+" || this.cur.v === "-")) { const op = this.cur.v; this.p++; e = { n: "bin", op, l: e, r: this.mul() }; }
    return e;
  }
  private mul(): Node {
    let e = this.unary();
    while (this.cur.t === "op" && (this.cur.v === "*" || this.cur.v === "/")) { const op = this.cur.v; this.p++; e = { n: "bin", op, l: e, r: this.unary() }; }
    return e;
  }
  private unary(): Node {
    if (this.cur.t === "op" && this.cur.v === "-") { this.p++; return { n: "neg", e: this.unary() }; }
    return this.postfix();
  }
  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.cur.t === "op" && this.cur.v === "." ) {
        this.p++;
        const t: Tok = this.cur;
        if (t.t !== "id") fail("K-105", "Expected a field name after `.`", this.loc);
        e = { n: "member", obj: e, name: t.v }; this.p++;
      } else if (this.cur.t === "op" && this.cur.v === "[" && this.toks[this.p - 1].end === this.cur.start) {
        this.p++; const idx = this.ifExpr(); this.need("]");
        e = { n: "index", obj: e, idx };
      } else return e;
    }
  }

  /** Reads a unit at the current token (e.g. `GB`, `km/h` written without spaces). */
  private unitAt(): string | undefined {
    const t = this.cur;
    if (t.t !== "id" || (KEYWORDS.has(t.v) && t.v !== "in")) return undefined;
    let text = t.v;
    let q = this.p + 1;
    while (this.toks[q].t === "op" && (this.toks[q].v === "/" || this.toks[q].v === "*") && this.toks[q].start === this.toks[q - 1].end && this.toks[q + 1].t === "id" && this.toks[q + 1].start === this.toks[q].end) {
      text += this.toks[q].v + this.toks[q + 1].v;
      q += 2;
    }
    if (!this.units.isUnit(text)) return undefined;
    const next = this.toks[q];
    if (next.t === "op" && (next.v === "(" || next.v === ".")) return undefined;
    this.p = q;
    return text;
  }

  private numberUnit(v: number, frac?: [number, number]): Node {
    let unit: string | undefined;
    const t = this.cur;
    const isConversion = t.t === "id" && t.v === "in" && this.toks[this.p + 1].t === "id" && this.units.isUnit(this.toks[this.p + 1].v);
    if (!isConversion) unit = this.unitAt();
    const nv: NumV = { k: "num", v };
    if (unit) nv.unit = unit;
    if (frac) nv.frac = frac;
    return { n: "lit", v: nv };
  }

  private primary(): Node {
    const t = this.cur;
    switch (t.t) {
      case "num": this.p++; return this.numberUnit(parseNumberText(t.v, this.loc));
      case "frac": {
        this.p++;
        const [a, b] = t.v.split("/").map(Number);
        if (b === 0) fail("K-204", "Fraction has a zero denominator", this.loc);
        return this.numberUnit(a / b, [a, b]);
      }
      case "date": this.p++; return { n: "lit", v: t.v.includes("T") ? { k: "ts", v: t.v } : { k: "date", v: t.v } };
      case "str": this.p++; return parseInterpolated(t.v, this.loc, this.units);
      case "id": {
        this.p++;
        switch (t.v) {
          case "true": return { n: "lit", v: { k: "bool", v: true } };
          case "false": return { n: "lit", v: { k: "bool", v: false } };
          case "void": return { n: "lit", v: VOID };
          case "today": return { n: "today" };
        }
        if (KEYWORDS.has(t.v)) fail("K-105", `Unexpected "${t.v}" in expression`, this.loc);
        if (this.cur.t === "op" && this.cur.v === "(") {
          this.p++;
          const args: Node[] = [];
          if (!this.eat(")")) {
            do args.push(this.ifExpr()); while (this.eat(","));
            this.need(")");
          }
          return { n: "call", name: t.v, args };
        }
        return { n: "id", name: t.v };
      }
      case "op":
        if (t.v === "(") { this.p++; const e = this.ifExpr(); this.need(")"); return e; }
        if (t.v === "[") {
          this.p++;
          const items: Node[] = [];
          while (!this.eat("]")) { items.push(this.ifExpr()); if (!this.eat(",") && !this.at("]")) fail("K-105", "Expected `,` or `]`", this.loc); }
          return { n: "list", items };
        }
    }
    fail("K-105", `Unexpected "${t.v || "end of expression"}" in expression`, this.loc);
  }
}

function parseInterpolated(raw: string, loc: Loc, units: UnitRegistry): Node {
  const parts: (string | Node)[] = [];
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const e = raw[++i];
      if (e === "n") buf += "\n";
      else if (e === "t") buf += "\t";
      else if (e === "u" && raw[i + 1] === "{") { const end = raw.indexOf("}", i); buf += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16)); i = end; }
      else buf += e;
    } else if (c === "{") {
      let depth = 1, j = i + 1;
      while (j < raw.length && depth) { if (raw[j] === "{") depth++; else if (raw[j] === "}") depth--; if (depth) j++; }
      if (depth) fail("K-105", "Unclosed `{` in interpolated text", loc, "Write \\{ for a literal brace.");
      if (buf) { parts.push(buf); buf = ""; }
      parts.push(parseExpr(raw.slice(i + 1, j), loc, units));
      i = j;
    } else buf += c;
  }
  if (buf || !parts.length) parts.push(buf);
  if (parts.length === 1 && typeof parts[0] === "string") return { n: "lit", v: { k: "text", v: parts[0] } };
  return { n: "str", parts };
}

export function parseExpr(src: string, loc: Loc, units: UnitRegistry): Node {
  const p = new Parser(src, loc, units);
  const e = p.parse();
  if (!p.done) fail("K-105", `Unexpected "${p.remaining()[0].v}" in expression`, loc);
  return e;
}

/** Parses `require <condition> ["message"]`. */
export function parseRequire(src: string, loc: Loc, units: UnitRegistry): { cond: Node; message?: string } {
  const p = new Parser(src, loc, units);
  const cond = p.parse();
  const rest = p.remaining();
  if (rest.length === 0) return { cond };
  if (rest.length === 1 && rest[0].t === "str") return { cond, message: rest[0].v.replace(/\\(.)/g, "$1") };
  fail("K-105", `Unexpected "${rest[0].v}" in requirement`, loc);
}

// ---------------------------------------------------------------- evaluation

export interface EvalContext {
  units: UnitRegistry;
  /** Today's date for `today`, honouring the load moment. */
  today: string;
  zone: string;
  loc: Loc;
  /** Field of the current group; undefined when the name is not a field there. */
  lookup(name: string): EV | undefined;
  soulExists(id: string): boolean;
  /** Field of another soul; undefined when the soul has no such field. */
  soulField(id: string, name: string): EV | undefined;
  covenantSouls(name: string): string[] | undefined;
}

const isSealed = (v: EV): v is Extract<Value, { k: "sealed" }> => v.k === "sealed";

function sealedOf(...vs: EV[]): Value | undefined {
  const s = vs.filter(isSealed);
  if (!s.length) return undefined;
  return { k: "sealed", to: [...new Set(s.flatMap((x) => x.to))] };
}

function num(v: EV, ctx: EvalContext, what: string): NumV {
  if (v.k !== "num") fail("K-203", `${what} needs a number, got ${v.k === "soul" ? "a soul" : v.k}`, ctx.loc);
  return v;
}

function boolOf(v: EV, ctx: EvalContext, what: string): boolean {
  if (v.k !== "bool") fail("K-203", `${what} needs true or false, got ${v.k === "soul" ? "a soul" : v.k}`, ctx.loc);
  return v.v;
}

/** Brings b into a's unit. Throws K-302 when the units are incompatible. */
function align(a: NumV, b: NumV, ctx: EvalContext): [number, number, string | undefined] {
  if (!a.unit && !b.unit) return [a.v, b.v, undefined];
  if (!a.unit || !b.unit) fail("K-302", `Cannot combine ${fmtQuantity(a)} with ${fmtQuantity(b)}: one has a unit and the other does not`, ctx.loc);
  if (!ctx.units.sameDims(a.unit, b.unit)) fail("K-302", `Cannot combine ${a.unit} with ${b.unit}`, ctx.loc);
  return [a.v, ctx.units.convert(b.v, b.unit, a.unit, ctx.loc), a.unit];
}

function compare(a: EV, b: EV, ctx: EvalContext): number {
  if (a.k === "num" && b.k === "num") { const [x, y] = align(a, b, ctx); return x - y; }
  const textual = (v: EV) => (v.k === "text" || v.k === "sym" ? v.v : undefined);
  const ta = textual(a), tb = textual(b);
  if (ta !== undefined && tb !== undefined) return ta < tb ? -1 : ta > tb ? 1 : 0;
  if ((a.k === "date" || a.k === "ts") && (b.k === "date" || b.k === "ts")) return instant(a.v, ctx.zone, ctx.loc) - instant(b.v, ctx.zone, ctx.loc);
  fail("K-203", `Cannot compare ${a.k} with ${b.k}`, ctx.loc);
}

function idOf(v: EV): string | undefined {
  return v.k === "soul" || v.k === "link" ? v.id : undefined;
}

function equal(a: EV, b: EV, ctx: EvalContext): boolean {
  if (a.k === "void" || b.k === "void") return a.k === b.k;
  const ia = idOf(a), ib = idOf(b);
  if (ia !== undefined || ib !== undefined) return ia === ib;
  if (a.k === "bool" && b.k === "bool") return a.v === b.v;
  if (a.k === "list" && b.k === "list") return a.items.length === b.items.length && a.items.every((x, i) => equal(x, b.items[i], ctx));
  if (a.k === "num" && b.k === "num" && (!!a.unit !== !!b.unit || (a.unit && b.unit && !ctx.units.sameDims(a.unit, b.unit)))) return false;
  try { return compare(a, b, ctx) === 0; } catch { return false; }
}

function member(obj: EV, name: string, ctx: EvalContext): EV {
  switch (obj.k) {
    case "soul": return ctx.soulField(obj.id, name) ?? fail("K-203", `Soul "${obj.id}" has no field "${name}"`, ctx.loc);
    case "link": return member({ k: "soul", id: obj.id }, name, ctx);
    case "group": return obj.fields.get(name) ?? VOID;
    case "list": return { k: "list", items: obj.items.map((x) => toValue(member(x, name, ctx))) };
    case "void": return VOID;
    case "sealed": return obj;
    default: fail("K-203", `Cannot read field "${name}" of a ${obj.k}`, ctx.loc);
  }
}

/** Converts an evaluation result back into a storable value. */
export function toValue(v: EV): Value {
  return v.k === "soul" ? { k: "link", id: v.id } : v;
}

function listOf(v: EV, ctx: EvalContext, fn: string): EV[] {
  if (v.k !== "list") fail("K-203", `${fn}() needs a list`, ctx.loc);
  return v.items;
}

function aggregate(items: EV[], fn: string, ctx: EvalContext): EV {
  const sealed = sealedOf(...items);
  if (sealed) return sealed;
  const nums = items.filter((x) => x.k !== "void").map((x) => num(x, ctx, `${fn}()`));
  if (!nums.length) return fn === "sum" ? { k: "num", v: 0 } : VOID;
  const unit = nums[0].unit;
  const vals = nums.map((x) => align(nums[0], x, ctx)[1]);
  let v: number;
  if (fn === "sum") v = vals.reduce((a, b) => a + b, 0);
  else if (fn === "avg") v = vals.reduce((a, b) => a + b, 0) / vals.length;
  else if (fn === "min") v = Math.min(...vals);
  else v = Math.max(...vals);
  return unit ? { k: "num", v, unit } : { k: "num", v };
}

export function evaluate(node: Node, ctx: EvalContext, scopes: EV[] = []): EV {
  const ev = (n: Node) => evaluate(n, ctx, scopes);
  switch (node.n) {
    case "lit": return node.v;
    case "today": return { k: "date", v: ctx.today };
    case "str": {
      let out = "";
      for (const part of node.parts) {
        if (typeof part === "string") { out += part; continue; }
        const v = ev(part);
        if (isSealed(v)) return v;
        out += v.k === "soul" ? v.id : v.k === "num" ? fmtQuantity(v) : toPlain(v);
      }
      return { k: "text", v: out };
    }
    case "id": {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const s = scopes[i];
        if (s.k === "soul") { const f = ctx.soulField(s.id, node.name); if (f !== undefined) return f; }
        else if (s.k === "group" && s.fields.has(node.name)) return s.fields.get(node.name)!;
      }
      const local = ctx.lookup(node.name);
      if (local !== undefined) return local;
      if (ctx.soulExists(node.name)) return { k: "soul", id: node.name };
      return { k: "sym", v: node.name };
    }
    case "member": return member(ev(node.obj), node.name, ctx);
    case "index": {
      const obj = ev(node.obj), idx = ev(node.idx);
      if (obj.k !== "list") fail("K-203", "Only lists can be indexed with [n]", ctx.loc);
      const i = num(idx, ctx, "An index").v;
      return obj.items[i] ?? VOID;
    }
    case "list": return { k: "list", items: node.items.map((n) => toValue(ev(n))) };
    case "not": { const v = ev(node.e); return sealedOf(v) ?? { k: "bool", v: !boolOf(v, ctx, "not") }; }
    case "neg": {
      const v = ev(node.e);
      if (isSealed(v)) return v;
      const n = num(v, ctx, "Negation");
      return { ...n, v: -n.v, frac: n.frac ? [-n.frac[0], n.frac[1]] : undefined };
    }
    case "if": {
      const c = ev(node.c);
      if (isSealed(c)) return c;
      return boolOf(c, ctx, "if") ? ev(node.a) : ev(node.b);
    }
    case "where": {
      const items = listOf(ev(node.list), ctx, "where");
      const kept = items.filter((item) => {
        const c = evaluate(node.cond, ctx, [...scopes, item.k === "link" ? { k: "soul", id: item.id } : item]);
        return boolOf(c, ctx, "where");
      });
      return { k: "list", items: kept.map(toValue) };
    }
    case "conv": {
      const v = ev(node.e);
      if (isSealed(v)) return v;
      const n = num(v, ctx, "Unit conversion");
      if (!n.unit) fail("K-302", `Cannot convert a plain number to ${node.unit}`, ctx.loc);
      return { k: "num", v: ctx.units.convert(n.v, n.unit, node.unit, ctx.loc), unit: node.unit };
    }
    case "call": return call(node.name, node.args, ctx, scopes);
    case "bin": {
      if (node.op === "and" || node.op === "or") {
        const l = ev(node.l);
        if (isSealed(l)) return l;
        const lb = boolOf(l, ctx, node.op);
        if (node.op === "and" && !lb) return { k: "bool", v: false };
        if (node.op === "or" && lb) return { k: "bool", v: true };
        const r = ev(node.r);
        return sealedOf(r) ?? { k: "bool", v: boolOf(r, ctx, node.op) };
      }
      const l = ev(node.l), r = ev(node.r);
      const s = sealedOf(l, r);
      if (s) return s;
      switch (node.op) {
        case "==": return { k: "bool", v: equal(l, r, ctx) };
        case "!=": return { k: "bool", v: !equal(l, r, ctx) };
        case "<": return { k: "bool", v: compare(l, r, ctx) < 0 };
        case "<=": return { k: "bool", v: compare(l, r, ctx) <= 0 };
        case ">": return { k: "bool", v: compare(l, r, ctx) > 0 };
        case ">=": return { k: "bool", v: compare(l, r, ctx) >= 0 };
        case "+":
          if (l.k === "text" && r.k === "text") return { k: "text", v: l.v + r.v };
        // falls through
        case "-": {
          const a = num(l, ctx, node.op), b = num(r, ctx, node.op);
          const [x, y, unit] = align(a, b, ctx);
          const v = node.op === "+" ? x + y : x - y;
          return unit ? { k: "num", v, unit } : { k: "num", v };
        }
        case "*": case "/": {
          const a = num(l, ctx, node.op), b = num(r, ctx, node.op);
          if (node.op === "/" && b.v === 0) fail("K-204", "Division by zero", ctx.loc);
          const { unit, scale } = ctx.units.combine(a.unit, b.unit, node.op === "*" ? 1 : -1);
          const v = (node.op === "*" ? a.v * b.v : a.v / b.v) * scale;
          return unit ? { k: "num", v, unit } : { k: "num", v };
        }
      }
    }
  }
  fail("K-105", "Cannot evaluate expression", ctx.loc);
}

function call(name: string, args: Node[], ctx: EvalContext, scopes: EV[]): EV {
  const arity = (n: number, m = n) => {
    if (args.length < n || args.length > m) fail("K-203", `${name}() takes ${n === m ? n : `${n} to ${m}`} argument${m === 1 ? "" : "s"}`, ctx.loc);
  };
  const ev = (n: Node) => evaluate(n, ctx, scopes);
  switch (name) {
    case "all": {
      arity(1);
      const a = args[0];
      if (a.n !== "id") fail("K-203", "all() takes a covenant name, e.g. all(Server)", ctx.loc);
      const ids = ctx.covenantSouls(a.name);
      if (!ids) fail("K-201", `Unknown covenant "${a.name}"`, ctx.loc);
      return { k: "list", items: ids.map((id) => ({ k: "link", id })) };
    }
    case "count": arity(1); return { k: "num", v: listOf(ev(args[0]), ctx, name).length };
    case "sum": case "avg": case "min": case "max": {
      if (args.length === 1) return aggregate(listOf(ev(args[0]), ctx, name), name, ctx);
      if (args.length === 0) arity(1);
      return aggregate(args.map(ev), name, ctx);
    }
    case "round": {
      arity(1, 2);
      const v = ev(args[0]);
      if (isSealed(v)) return v;
      const n = num(v, ctx, "round()");
      const places = args[1] ? num(ev(args[1]), ctx, "round()").v : 0;
      const f = 10 ** places;
      const r = Math.round((n.v + Number.EPSILON * Math.sign(n.v)) * f) / f;
      return n.unit ? { k: "num", v: r, unit: n.unit } : { k: "num", v: r };
    }
    case "upper": case "lower": {
      arity(1);
      const v = ev(args[0]);
      if (isSealed(v)) return v;
      if (v.k !== "text") fail("K-203", `${name}() needs text`, ctx.loc);
      return { k: "text", v: name === "upper" ? v.v.toUpperCase() : v.v.toLowerCase() };
    }
    case "length": {
      arity(1);
      const v = ev(args[0]);
      if (isSealed(v)) return v;
      if (v.k === "text") return { k: "num", v: [...v.v].length };
      if (v.k === "list") return { k: "num", v: v.items.length };
      fail("K-203", "length() needs text or a list", ctx.loc);
    }
    case "days": {
      arity(2);
      const a = ev(args[0]), b = ev(args[1]);
      const s = sealedOf(a, b);
      if (s) return s;
      if ((a.k !== "date" && a.k !== "ts") || (b.k !== "date" && b.k !== "ts")) fail("K-203", "days() needs two dates", ctx.loc);
      return { k: "num", v: Math.round((instant(b.v, ctx.zone, ctx.loc) - instant(a.v, ctx.zone, ctx.loc)) / 86400000) };
    }
    case "currency": {
      arity(1);
      const v = ev(args[0]);
      if (isSealed(v)) return v;
      if (v.k === "void") return VOID;
      const n = num(v, ctx, "currency()");
      return n.unit && ctx.units.isMoney(n.unit) ? { k: "text", v: n.unit } : VOID;
    }
  }
  fail("K-203", `Unknown function "${name}"`, ctx.loc, "Available: all, count, sum, avg, min, max, round, upper, lower, length, days, currency.");
}
