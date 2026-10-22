import { fail, Loc } from "./errors";
import { LLine, toLines } from "./lexer";
import { LiteralReader, parseLiteral } from "./literal";
import { parseTermType, parseTypeOnly, Term, TypeExpr } from "./types";
import { Value } from "./values";

export type BodyLine =
  | { t: "set"; field: string; value: Value; bound: boolean; loc: Loc }
  | { t: "link"; field: string; ids: string[]; list: boolean; bound: boolean; loc: Loc }
  | { t: "group"; field: string; bound: boolean; body: BodyLine[]; loc: Loc }
  | { t: "window"; from?: string; until?: string; body: BodyLine[]; loc: Loc }
  | { t: "sealed"; to: string[]; body: BodyLine[]; loc: Loc }
  | { t: "invoke"; field: string; type?: TypeExpr; expr: string; loc: Loc }
  | { t: "cset"; path: string[]; value: Value; loc: Loc }
  | { t: "clink"; path: string[]; ids: string[]; list: boolean; loc: Loc }
  | { t: "append"; path: string[]; value: Value; loc: Loc }
  | { t: "banish"; path: string[]; loc: Loc }
  | { t: "soul"; soul: SoulAST };

export interface SoulAST { id: string; cov: string; body: BodyLine[]; loc: Loc }
export interface InvokeAST { field: string; type?: TypeExpr; expr: string; loc: Loc }
export interface CovenantAST {
  name: string;
  extends?: string;
  open: boolean;
  terms: Term[];
  requires: { expr: string; loc: Loc }[];
  invokes: InvokeAST[];
  loc: Loc;
}
export interface UnitAST { family: string; name: string; defs: { sym: string; value: Value; loc: Loc }[]; loc: Loc }
export interface CircleAST { num: number; name: string; always: boolean; body: BodyLine[]; loc: Loc }
export interface FileAST {
  file: string;
  version: string;
  zone?: string;
  covenants: CovenantAST[];
  units: UnitAST[];
  keys: { name: string; pub: string; loc: Loc }[];
  souls: SoulAST[];
  circles: CircleAST[];
  possess: { path: string; loc: Loc }[];
}

const NAME = "[A-Za-z][A-Za-z0-9_-]*";
const ID = "[a-z][a-z0-9-]*";
const PATH = `${ID}(?:\\.${NAME})+`;

const RE = {
  summon: /^summon\s+kitml\s+(\S+)(?:\s+zone\s+(\S+))?$/,
  covenant: new RegExp(`^covenant\\s+(${NAME})(?:\\s+extends\\s+(${NAME}))?(\\s+open)?$`),
  unit: new RegExp(`^unit\\s+(${NAME})\\s+family\\s+(${NAME})$`),
  soul: new RegExp(`^soul\\s+(\\S+)\\s+is\\s+(${NAME})$`),
  circle: new RegExp(`^circle\\s+(\\S+)\\s+(\\S+)(\\s+always)?$`),
  possess: /^possess\s+(.+)$/,
  key: new RegExp(`^key\\s+(${NAME})\\s*=\\s*(.+)$`),
  invoke: new RegExp(`^invoke\\s+(${NAME})\\s*(?::\\s*(.+?))?\\s*=(?!=)\\s*(.+)$`),
  from: /^from\s+(\S+)(?:\s+until\s+(\S+))?$/,
  until: /^until\s+(\S+)$/,
  sealed: /^sealed\s+to\s+(.+)$/,
  link: new RegExp(`^(bound\\s+)?(${NAME})\\s*->\\s*(.+)$`),
  set: new RegExp(`^(bound\\s+)?(${NAME})\\s*=(?!=)\\s*(.+)$`),
  group: new RegExp(`^(bound\\s+)?(${NAME})$`),
  banish: new RegExp(`^banish\\s+(${PATH})$`),
  append: new RegExp(`^(${PATH})\\s*\\+=\\s*(.+)$`),
  clink: new RegExp(`^(${PATH})\\s*->\\s*(.+)$`),
  cset: new RegExp(`^(${PATH})\\s*=(?!=)\\s*(.+)$`),
  require: /^require\s+(.+)$/,
  term: new RegExp(`^(bound\\s+|sealed\\s+)?(${NAME})\\s*:\\s*(.+)$`),
  unitDef: /^(%|[A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/,
};

const locOf = (l: LLine): Loc => ({ file: l.file, line: l.line, col: l.col });

function parseIds(text: string, loc: Loc): { ids: string[]; list: boolean } {
  const t = text.trim();
  const idRe = new RegExp(`^${ID}$`);
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) fail("K-105", "Link list must end with `]`", loc);
    const ids = t.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!idRe.test(id)) fail("K-105", `"${id}" is not a valid soul ID`, loc);
    return { ids, list: true };
  }
  if (t === "void") return { ids: [], list: false };
  if (!idRe.test(t)) fail("K-105", `"${t}" is not a valid soul ID`, loc, "Soul IDs use lowercase letters, digits and -, and start with a letter.");
  return { ids: [t], list: false };
}

function parseKeyList(text: string, loc: Loc): string[] {
  const t = text.trim();
  const names = t.startsWith("[") ? t.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean) : [t];
  for (const n of names) if (!new RegExp(`^${NAME}$`).test(n)) fail("K-105", `"${n}" is not a valid key name`, loc);
  return names;
}

class BlockReader {
  constructor(private lines: LLine[]) {}

  /** Lines of a `... seal` block whose header is at index i. Returns body and the index after `seal`. */
  sealed(i: number): { body: LLine[]; next: number } {
    const head = this.lines[i];
    const body: LLine[] = [];
    let j = i + 1;
    for (; j < this.lines.length; j++) {
      const l = this.lines[j];
      if (l.indent === head.indent && l.text === "seal") return { body, next: j + 1 };
      if (l.indent <= head.indent) break;
      body.push(l);
    }
    fail("K-101", `This block is never closed with \`seal\``, locOf(head));
  }
}

/** Splits lines at `indent` into items, each with the deeper lines that follow it. */
function children(lines: LLine[], indent: number): { head: LLine; kids: LLine[] }[] {
  const out: { head: LLine; kids: LLine[] }[] = [];
  for (const l of lines) {
    if (l.indent === indent) out.push({ head: l, kids: [] });
    else if (l.indent > indent && out.length) out[out.length - 1].kids.push(l);
    else fail("K-003", "Unexpected indentation", locOf(l));
  }
  for (const item of out) {
    if (item.kids.length && item.kids[0].indent !== indent + 2) {
      fail("K-003", `Expected ${indent + 2} spaces of indentation`, locOf(item.kids[0]));
    }
  }
  return out;
}

type Mode = "soul" | "circle" | "sealed";

function parseBody(lines: LLine[], indent: number, mode: Mode): BodyLine[] {
  const out: BodyLine[] = [];
  const items = children(lines, indent);
  for (let k = 0; k < items.length; k++) {
    const { head, kids } = items[k];
    const loc = locOf(head);
    const text = head.text;
    let m: RegExpExecArray | null;
    const noKids = () => {
      if (kids.length) fail("K-003", "Unexpected indentation", locOf(kids[0]));
    };

    // Windows work in souls and circles alike.
    if ((m = RE.from.exec(text)) || (m = RE.until.exec(text))) {
      if (mode === "sealed") fail("K-105", "Time windows cannot sit inside a sealed block", loc);
      const isFrom = text.startsWith("from");
      if (!kids.length) fail("K-105", "This time window has no fields", loc);
      out.push({ t: "window", from: isFrom ? m[1] : undefined, until: isFrom ? m[2] : m[1], body: parseBody(kids, indent + 2, mode), loc });
      continue;
    }

    if (mode === "circle") {
      if ((m = RE.soul.exec(text))) {
        // The closing `seal` sits at the same indentation, so it is the next sibling item.
        const closer = items[k + 1];
        if (!closer || closer.head.text !== "seal") fail("K-101", "This soul is never closed with `seal`", loc);
        if (closer.kids.length) fail("K-003", "Unexpected indentation", locOf(closer.kids[0]));
        out.push({ t: "soul", soul: makeSoul(m, kids, loc) });
        k++;
        continue;
      }
      if (text === "seal") fail("K-105", "`seal` without an open soul", loc);
      if ((m = RE.banish.exec(text))) { noKids(); out.push({ t: "banish", path: m[1].split("."), loc }); continue; }
      if ((m = RE.append.exec(text))) { noKids(); out.push({ t: "append", path: m[1].split("."), value: parseLiteral(m[2], loc), loc }); continue; }
      if ((m = RE.clink.exec(text))) { noKids(); const p = parseIds(m[2], loc); out.push({ t: "clink", path: m[1].split("."), ids: p.ids, list: p.list, loc }); continue; }
      if ((m = RE.cset.exec(text))) { noKids(); out.push({ t: "cset", path: m[1].split("."), value: parseLiteral(m[2], loc), loc }); continue; }
      fail("K-105", `Cannot read circle line "${text}"`, loc, "Circle lines look like `soul-id.field = value`, `soul-id.field -> other`, `soul-id.list += [...]` or `banish soul-id.field`.");
    }

    if ((m = RE.invoke.exec(text))) {
      if (mode === "sealed") fail("K-105", "Computed fields cannot be sealed", loc);
      noKids();
      out.push({ t: "invoke", field: m[1], type: m[2] ? parseTypeOnly(m[2], loc) : undefined, expr: m[3], loc });
      continue;
    }
    if ((m = RE.sealed.exec(text))) {
      if (mode === "sealed") fail("K-105", "Sealed blocks cannot be nested", loc);
      if (!kids.length) fail("K-105", "This sealed block has no fields", loc);
      out.push({ t: "sealed", to: parseKeyList(m[1], loc), body: parseBody(kids, indent + 2, "sealed"), loc });
      continue;
    }
    if ((m = RE.link.exec(text))) {
      noKids();
      const p = parseIds(m[3], loc);
      out.push({ t: "link", field: m[2], ids: p.ids, list: p.list, bound: !!m[1], loc });
      continue;
    }
    if ((m = RE.set.exec(text))) {
      noKids();
      out.push({ t: "set", field: m[2], value: parseLiteral(m[3], loc), bound: !!m[1], loc });
      continue;
    }
    if ((m = RE.group.exec(text)) && text !== "seal") {
      if (!kids.length) fail("K-105", `Field "${m[2]}" has no value`, loc, "Write `field = value`, or indent the fields of a nested group below it.");
      out.push({ t: "group", field: m[2], bound: !!m[1], body: parseBody(kids, indent + 2, mode), loc });
      continue;
    }
    if (text === "seal") fail("K-003", "`seal` must line up with the block it closes", loc);
    fail("K-105", `Cannot read line "${text}"`, loc, "Fields look like `name = value` or `name -> soul-id`.");
  }
  return out;
}

function makeSoul(m: RegExpExecArray, body: LLine[], loc: Loc): SoulAST {
  const id = m[1];
  if (!new RegExp(`^${ID}$`).test(id)) fail("K-105", `"${id}" is not a valid soul ID`, loc, "Soul IDs use lowercase letters, digits and -, and start with a letter.");
  return { id, cov: m[2], body: body.length ? parseBody(body, loc.col + 1, "soul") : [], loc };
}

function parseCovenant(m: RegExpExecArray, body: LLine[], loc: Loc): CovenantAST {
  const cov: CovenantAST = { name: m[1], extends: m[2], open: !!m[3], terms: [], requires: [], invokes: [], loc };
  for (const { head, kids } of children(body, 2)) {
    const l = locOf(head);
    if (kids.length) fail("K-003", "Unexpected indentation", locOf(kids[0]));
    let x: RegExpExecArray | null;
    if ((x = RE.require.exec(head.text))) cov.requires.push({ expr: x[1], loc: l });
    else if ((x = RE.invoke.exec(head.text))) cov.invokes.push({ field: x[1], type: x[2] ? parseTypeOnly(x[2], l) : undefined, expr: x[3], loc: l });
    else if ((x = RE.term.exec(head.text))) {
      const { type, rules } = parseTermType(x[3], l);
      const mod = (x[1] ?? "").trim();
      if (cov.terms.some((t) => t.field === x![2])) fail("K-103", `Field "${x[2]}" is declared twice`, l);
      cov.terms.push({ field: x[2], type, rules, bound: mod === "bound", sealed: mod === "sealed", loc: l });
    } else fail("K-105", `Cannot read covenant line "${head.text}"`, l, "Covenant lines look like `name : type rules`, `require condition \"message\"` or `invoke name : type = expression`.");
  }
  return cov;
}

export function parseFile(src: string, file: string): FileAST {
  const lines = toLines(src, file);
  if (!lines.length) fail("K-001", "The file is empty", { file, line: 1, col: 1 });
  const first = lines[0];
  const sm = RE.summon.exec(first.text);
  if (!sm || first.indent !== 0) fail("K-001", "The file does not start with `summon kitml 1`", locOf(first));
  if (!/^1(\.\d+)?$/.test(sm[1])) fail("K-001", `Kitml version ${sm[1]} is not supported by this engine (supports 1)`, locOf(first));
  const ast: FileAST = { file, version: sm[1], zone: sm[2], covenants: [], units: [], keys: [], souls: [], circles: [], possess: [] };
  const reader = new BlockReader(lines);

  let i = 1;
  while (i < lines.length) {
    const l = lines[i];
    const loc = locOf(l);
    if (l.indent !== 0) fail("K-003", "Unexpected indentation at the top level", loc);
    let m: RegExpExecArray | null;
    if ((m = RE.covenant.exec(l.text))) {
      const { body, next } = reader.sealed(i);
      ast.covenants.push(parseCovenant(m, body, loc));
      i = next;
    } else if ((m = RE.soul.exec(l.text))) {
      const { body, next } = reader.sealed(i);
      ast.souls.push(makeSoul(m, body, loc));
      i = next;
    } else if ((m = RE.circle.exec(l.text))) {
      const num = Number(m[1]);
      if (!/^[1-9]$/.test(m[1])) fail("K-105", `Circle number must be 1 to 9, not ${m[1]}`, loc);
      if (!new RegExp(`^${ID}$`).test(m[2])) fail("K-105", `"${m[2]}" is not a valid circle name`, loc);
      const { body, next } = reader.sealed(i);
      ast.circles.push({ num, name: m[2], always: !!m[3], body: body.length ? parseBody(body, 2, "circle") : [], loc });
      i = next;
    } else if ((m = RE.unit.exec(l.text))) {
      const { body, next } = reader.sealed(i);
      const u: UnitAST = { name: m[1], family: m[2], defs: [], loc };
      for (const { head, kids } of children(body, 2)) {
        const dl = locOf(head);
        if (kids.length) fail("K-003", "Unexpected indentation", locOf(kids[0]));
        const d = RE.unitDef.exec(head.text);
        if (!d) fail("K-105", `Cannot read unit definition "${head.text}"`, dl, "Unit lines look like `fps = 1` or `floppy = 1.44 MB`.");
        const value = parseLiteral(d[2], dl);
        if (value.k !== "num") fail("K-203", "A unit must be defined as a number, optionally with a unit", dl);
        u.defs.push({ sym: d[1], value, loc: dl });
      }
      ast.units.push(u);
      i = next;
    } else if ((m = RE.possess.exec(l.text))) {
      const r = new LiteralReader(m[1], loc);
      const p = r.readString();
      if (!r.atEnd()) fail("K-105", "Unexpected text after the possessed path", loc);
      ast.possess.push({ path: p, loc });
      i++;
    } else if ((m = RE.key.exec(l.text))) {
      const r = new LiteralReader(m[2], loc);
      const pub = r.readString();
      if (!r.atEnd()) fail("K-105", "Unexpected text after the key", loc);
      ast.keys.push({ name: m[1], pub, loc });
      i++;
    } else if (l.text === "seal") {
      fail("K-105", "`seal` without an open block", loc);
    } else if (RE.summon.test(l.text)) {
      fail("K-105", "Only one summoning line is allowed per file", loc);
    } else {
      fail("K-105", `Cannot read "${l.text}"`, loc, "Top-level lines start with covenant, soul, circle, unit, key or possess.");
    }
  }
  return ast;
}
