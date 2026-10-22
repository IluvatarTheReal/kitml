import { fail, Loc } from "./errors";
import { Value, VOID } from "./values";

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?(?![\w-])/;
const NUM_RE = /^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;
const UNIT_RE = /^(?:%|[A-Za-z][A-Za-z0-9]*(?:[/*][A-Za-z][A-Za-z0-9]*)?)/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]*/;

/** Words that end a value and can never be read as a unit. */
const RESERVED = new Set(["and", "or", "not", "optional", "default", "between", "whole", "matching", "length", "unique", "then", "else", "where"]);

export function parseNumberText(t: string, loc: Loc): number {
  const clean = t.replace(/_/g, "");
  const neg = clean.startsWith("-");
  const body = clean.replace(/^[+-]/, "");
  let v: number;
  if (/^0x/i.test(body)) v = parseInt(body.slice(2), 16);
  else if (/^0o/i.test(body)) v = parseInt(body.slice(2), 8);
  else if (/^0b/i.test(body)) v = parseInt(body.slice(2), 2);
  else {
    if (/^0\d/.test(body)) fail("K-104", `"${t}" starts with a leading zero`, loc);
    v = Number(body);
  }
  if (Number.isNaN(v)) fail("K-105", `"${t}" is not a valid number`, loc);
  return neg ? -v : v;
}

/** Reads Kitml literal values (the right-hand side of `field = value`). */
export class LiteralReader {
  pos = 0;
  constructor(readonly s: string, readonly loc: Loc) {}

  private ws(): void {
    while (this.pos < this.s.length && this.s[this.pos] === " ") this.pos++;
  }
  get rest(): string {
    return this.s.slice(this.pos);
  }
  atEnd(): boolean {
    this.ws();
    return this.pos >= this.s.length;
  }
  peek(): string {
    this.ws();
    return this.s[this.pos] ?? "";
  }
  expect(ch: string): void {
    if (this.peek() !== ch) fail("K-105", `Expected "${ch}" but found "${this.rest.slice(0, 12) || "end of line"}"`, this.loc);
    this.pos++;
  }

  readString(): string {
    this.expect('"');
    let out = "";
    while (this.pos < this.s.length) {
      const c = this.s[this.pos++];
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.pos++];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === '"' || e === "\\" || e === "{" || e === "}" || e === "@") out += e;
      else if (e === "u") {
        let hex: string;
        if (this.s[this.pos] === "{") {
          const end = this.s.indexOf("}", this.pos);
          if (end < 0) fail("K-105", "Unclosed \\u{...} escape", this.loc);
          hex = this.s.slice(this.pos + 1, end);
          this.pos = end + 1;
        } else {
          hex = this.s.slice(this.pos, this.pos + 4);
          this.pos += 4;
        }
        const cp = parseInt(hex, 16);
        if (Number.isNaN(cp)) fail("K-105", `Invalid unicode escape \\u${hex}`, this.loc);
        out += String.fromCodePoint(cp);
      } else fail("K-105", `Unknown escape "\\${e}"`, this.loc);
    }
    fail("K-102", "Text is missing its closing quote", this.loc);
  }

  readValue(): Value {
    const c = this.peek();
    if (c === "") fail("K-105", "Expected a value", this.loc);
    if (c === '"') return { k: "text", v: this.readString() };
    if (c === "[") return this.readList();
    if (c === "{") return this.readGroup();

    const rest = this.rest;
    const d = DATE_RE.exec(rest);
    if (d) {
      this.pos += d[0].length;
      return d[0].includes("T") ? { k: "ts", v: d[0] } : { k: "date", v: d[0] };
    }

    const n = NUM_RE.exec(rest);
    if (n && /[\d]/.test(n[0])) {
      this.pos += n[0].length;
      let frac: [number, number] | undefined;
      let v = parseNumberText(n[0], this.loc);
      const fm = /^\/(\d+)(?![\w.])/.exec(this.rest);
      if (fm && Number.isInteger(v)) {
        const den = parseInt(fm[1], 10);
        if (den === 0) fail("K-204", "Fraction has a zero denominator", this.loc);
        frac = [v, den];
        v = v / den;
        this.pos += fm[0].length;
      }
      const save = this.pos;
      if (this.s[this.pos] === " ") {
        this.ws();
        const u = UNIT_RE.exec(this.rest);
        if (u && !RESERVED.has(u[0])) {
          const after = this.rest[u[0].length] ?? "";
          if (after === "" || /[\s,\]}]/.test(after)) {
            this.pos += u[0].length;
            return frac ? { k: "num", v, unit: u[0], frac } : { k: "num", v, unit: u[0] };
          }
        }
        this.pos = save;
      }
      return frac ? { k: "num", v, frac } : { k: "num", v };
    }

    const w = WORD_RE.exec(rest);
    if (w) {
      this.pos += w[0].length;
      switch (w[0]) {
        case "true": return { k: "bool", v: true };
        case "false": return { k: "bool", v: false };
        case "void": return VOID;
        case "eternity": return { k: "num", v: Infinity };
        case "sealed": {
          if (this.peek() !== '"') fail("K-105", "`sealed` must be followed by quoted ciphertext", this.loc);
          return { k: "sealed", to: [], cipher: this.readString() };
        }
        default: return { k: "sym", v: w[0] };
      }
    }
    fail("K-105", `Cannot read a value from "${rest.slice(0, 20)}"`, this.loc);
  }

  private readList(): Value {
    this.expect("[");
    const items: Value[] = [];
    while (this.peek() !== "]") {
      items.push(this.readValue());
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "]") fail("K-105", "Expected `,` or `]` in list", this.loc);
    }
    this.pos++;
    return { k: "list", items };
  }

  private readGroup(): Value {
    this.expect("{");
    const fields = new Map<string, Value>();
    while (this.peek() !== "}") {
      this.ws();
      const key = WORD_RE.exec(this.rest);
      if (!key) fail("K-105", "Expected a field name in group", this.loc);
      this.pos += key[0].length;
      this.expect(":");
      if (fields.has(key[0])) fail("K-103", `Field "${key[0]}" appears twice in this group`, this.loc);
      fields.set(key[0], this.readValue());
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "}") fail("K-105", "Expected `,` or `}` in group", this.loc);
    }
    this.pos++;
    return { k: "group", fields };
  }
}

/** Parses a complete literal; anything left over is an error. */
export function parseLiteral(s: string, loc: Loc): Value {
  const r = new LiteralReader(s, loc);
  const v = r.readValue();
  if (!r.atEnd()) {
    const hint = v.k === "sym" ? "Text must be written in double quotes." : undefined;
    fail("K-105", `Unexpected "${r.rest.trim()}" after the value`, loc, hint);
  }
  return v;
}
