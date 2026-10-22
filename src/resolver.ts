import * as fs from "fs";
import * as path from "path";
import { fail, Loc } from "./errors";
import { BodyLine, CircleAST, CovenantAST, FileAST, InvokeAST, parseFile, SoulAST } from "./parser";
import { dateIn, instant } from "./time";
import { Term, TypeExpr } from "./types";
import { UnitRegistry } from "./units";
import { GroupV, toKitml, Value, VOID } from "./values";

// ------------------------------------------------------------------ files

export type FileCache = Map<string, FileAST>;

function globFiles(pattern: string, loc: Loc): string[] {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (dir.includes("*")) fail("K-803", "Wildcards are only allowed in the file name, not in folder names", loc);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail("K-803", `Folder "${dir}" does not exist`, loc);
  const re = new RegExp("^" + base.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  const found = fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  if (!found.length) fail("K-803", `No files match "${pattern}"`, loc);
  return found;
}

/** Loads the entry file and everything it possesses, depth first, each file once. */
export function loadFiles(entry: string, allowOutside: boolean, cache: FileCache): FileAST[] {
  const root = path.dirname(path.resolve(entry));
  const order: FileAST[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string, from?: Loc) => {
    const abs = path.resolve(file);
    if (stack.includes(abs)) {
      const chain = [...stack.slice(stack.indexOf(abs)), abs].map((f) => path.basename(f)).join(" -> ");
      fail("K-802", `Files possess each other in a loop: ${chain}`, from);
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    let ast = cache.get(abs);
    if (!ast) {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail("K-803", `File "${file}" does not exist`, from);
      ast = parseFile(fs.readFileSync(abs, "utf8"), abs);
      cache.set(abs, ast);
    }
    order.push(ast);
    stack.push(abs);
    for (const p of ast.possess) {
      const target = path.resolve(path.dirname(abs), p.path);
      const files = p.path.includes("*") ? globFiles(target, p.loc) : [target];
      for (const f of files) {
        const rel = path.relative(root, f);
        if (!allowOutside && (rel.startsWith("..") || path.isAbsolute(rel))) {
          fail("K-803", `"${p.path}" is outside the folder of ${path.basename(entry)}`, p.loc, "Run with --allow-outside (allowOutside: true) to permit this.");
        }
        visit(f, p.loc);
      }
    }
    stack.pop();
  };
  visit(entry);
  return order;
}

// ------------------------------------------------------------------ covenants

export interface FlatTerm extends Term {
  declaredIn: string;
}

export interface Covenant {
  name: string;
  chain: string[];
  open: boolean;
  terms: Map<string, FlatTerm>;
  requires: { expr: string; loc: Loc }[];
  invokes: InvokeAST[];
  loc: Loc;
}

function walkTypeUnits(t: TypeExpr, units: UnitRegistry, loc: Loc, covs: Map<string, CovenantAST>): void {
  switch (t.t) {
    case "number": case "fraction":
      if (t.unit && t.unit !== "money") units.parse(t.unit, loc);
      break;
    case "list": walkTypeUnits(t.of, units, loc, covs); break;
    case "shape": for (const f of t.fields.values()) walkTypeUnits(f, units, loc, covs); break;
    case "link": case "cov": {
      const name = t.t === "link" ? t.cov : t.name;
      if (!covs.has(name)) fail("K-201", `Unknown covenant "${name}"`, loc);
      break;
    }
  }
}

function walkValueUnits(v: Value, units: UnitRegistry, loc: Loc): void {
  if (v.k === "num" && v.unit) units.parse(v.unit, loc);
  else if (v.k === "list") v.items.forEach((x) => walkValueUnits(x, units, loc));
  else if (v.k === "group") v.fields.forEach((x) => walkValueUnits(x, units, loc));
}

export function buildCovenants(asts: CovenantAST[], units: UnitRegistry): Map<string, Covenant> {
  const byName = new Map<string, CovenantAST>();
  for (const c of asts) {
    if (byName.has(c.name)) fail("K-208", `Covenant "${c.name}" is declared twice`, c.loc);
    byName.set(c.name, c);
  }
  const out = new Map<string, Covenant>();
  const building = new Set<string>();
  const build = (name: string, loc?: Loc): Covenant => {
    const done = out.get(name);
    if (done) return done;
    const ast = byName.get(name);
    if (!ast) fail("K-201", `Unknown covenant "${name}"`, loc);
    if (building.has(name)) fail("K-201", `Covenant "${name}" extends itself`, ast.loc);
    building.add(name);
    const parent = ast.extends ? build(ast.extends, ast.loc) : undefined;
    const terms = new Map<string, FlatTerm>(parent ? parent.terms : []);
    for (const t of ast.terms) {
      walkTypeUnits(t.type, units, t.loc, byName);
      if (t.rules.default) walkValueUnits(t.rules.default, units, t.loc);
      if (t.rules.between) t.rules.between.forEach((b) => walkValueUnits(b, units, t.loc));
      const inherited = terms.get(t.field);
      if (inherited && inherited.rules.optional === false && t.rules.optional) {
        fail("K-203", `"${name}" cannot make the inherited field "${t.field}" optional`, t.loc, "A covenant that extends another may add or tighten rules, but not loosen them.");
      }
      terms.set(t.field, { ...t, declaredIn: inherited ? inherited.declaredIn : name });
    }
    for (const inv of ast.invokes) if (inv.type) walkTypeUnits(inv.type, units, inv.loc, byName);
    const cov: Covenant = {
      name,
      chain: [name, ...(parent ? parent.chain : [])],
      open: ast.open,
      terms,
      requires: [...(parent ? parent.requires : []), ...ast.requires],
      invokes: [...(parent ? parent.invokes : []), ...ast.invokes],
      loc: ast.loc,
    };
    building.delete(name);
    out.set(name, cov);
    return cov;
  };
  for (const c of asts) build(c.name);
  return out;
}

// ------------------------------------------------------------------ layering

/** Where a value came from. Layer 0 is the base data; 1-9 are circles. */
export interface Origin {
  layer: number;
  name: string;
  file: string;
  line: number;
  col: number;
  window?: string;
  value?: Value;
  op: "set" | "link" | "append" | "banish" | "default" | "computed";
}

interface Entry {
  value?: Value;
  children?: Map<string, Entry>;
  bound?: Loc;
  sealedTo?: string[];
  history: Origin[];
}

interface Layer {
  layer: number;
  name: string;
  zone: string;
}

export interface WindowInfo {
  soul: string;
  scope: string;
  from?: string;
  until?: string;
  fromMs?: number;
  untilMs?: number;
  fields: { path: string; value: string }[];
  loc: Loc;
}

export interface SoulInvoke extends InvokeAST {
  /** Dotted path of the group the field lives in ("" for the soul itself). */
  prefix: string;
}

export interface SoulState {
  id: string;
  cov: string;
  loc: Loc;
  zone: string;
  layer: number;
  root: Map<string, Entry>;
  invokes: SoulInvoke[];
}

export interface Layered {
  souls: Map<string, SoulState>;
  order: string[];
  windows: WindowInfo[];
  activeCircles: string[];
}

const locStr = (l: Loc) => `${path.basename(l.file)}:${l.line}`;

function windowLabel(from?: string, until?: string): string {
  return [from && `from ${from}`, until && `until ${until}`].filter(Boolean).join(" ");
}

function boundInside(e: Entry): Loc | undefined {
  if (e.bound) return e.bound;
  if (e.children) for (const c of e.children.values()) { const b = boundInside(c); if (b) return b; }
  return undefined;
}

function entryFrom(value: Value, origin: Origin, bound?: Loc, sealedTo?: string[]): Entry {
  if (value.k === "group") {
    const children = new Map<string, Entry>();
    for (const [k, v] of value.fields) children.set(k, entryFrom(v, { ...origin, value: v }, bound, sealedTo));
    return { children, bound, sealedTo, history: [origin] };
  }
  return { value, bound, sealedTo, history: [origin] };
}

class Layering {
  readonly souls = new Map<string, SoulState>();
  readonly order: string[] = [];
  readonly windows: WindowInfo[] = [];

  constructor(private at: number, private keys: Set<string>) {}

  private who(layer: Layer, window?: string): string {
    const base = layer.layer === 0 ? "the base data" : `circle ${layer.layer} (${layer.name})`;
    return window ? `a time window (${window}) in ${base}` : base;
  }

  /** Writes a value at a path inside a soul. `override` is false only for plain base lines. */
  private write(soul: SoulState, segs: string[], value: Value | undefined, origin: Origin, opts: { override: boolean; bound?: Loc; sealedTo?: string[]; layer: Layer; window?: string; append?: boolean }): void {
    let map = soul.root;
    const full = `${soul.id}.${segs.join(".")}`;
    const broken = (b: Loc) =>
      fail("K-501", `${full} is bound at ${locStr(b)} and cannot be changed by ${this.who(opts.layer, opts.window)}`, { file: origin.file, line: origin.line, col: origin.col });
    for (let i = 0; i < segs.length - 1; i++) {
      let e = map.get(segs[i]);
      if (!e) {
        e = { children: new Map(), history: [] };
        map.set(segs[i], e);
      } else if (!e.children) {
        if (e.value?.k === "group") {
          const expanded = entryFrom(e.value, e.history[e.history.length - 1], e.bound, e.sealedTo);
          e.children = expanded.children;
          delete e.value;
        } else {
          fail("K-203", `${soul.id}.${segs.slice(0, i + 1).join(".")} is not a group, so it has no field "${segs[i + 1]}"`, { file: origin.file, line: origin.line, col: origin.col });
        }
      }
      if (opts.override && e.bound) broken(e.bound);
      map = e.children!;
    }
    const last = segs[segs.length - 1];
    const old = map.get(last);
    if (old && !opts.override) fail("K-103", `Field "${segs.join(".")}" is set twice in soul ${soul.id}`, { file: origin.file, line: origin.line, col: origin.col });
    if (old && opts.override) { const b = boundInside(old); if (b) broken(b); }

    if (origin.op === "banish") {
      if (old) map.delete(last);
      return;
    }
    if (opts.append) {
      if (!old || old.value?.k !== "list") fail("K-203", `${full} is not a list, so it cannot be appended to`, { file: origin.file, line: origin.line, col: origin.col });
      if (value?.k !== "list") fail("K-203", "`+=` needs a list on the right, e.g. += [\"x\"]", { file: origin.file, line: origin.line, col: origin.col });
      old.value = { k: "list", items: [...old.value.items, ...value.items] };
      old.history.push(origin);
      return;
    }
    const sealedTo = opts.sealedTo ?? old?.sealedTo;
    let v = value!;
    if (v.k === "sealed") {
      if (!sealedTo) fail("K-105", "Ciphertext (`sealed \"...\"`) must sit inside a `sealed to` block", { file: origin.file, line: origin.line, col: origin.col });
      v = { ...v, to: sealedTo };
    }
    const entry = entryFrom(v, origin, opts.bound, sealedTo);
    entry.history = [...(old?.history ?? []), origin];
    map.set(last, entry);
  }

  private origin(line: { loc: Loc }, layer: Layer, op: Origin["op"], value?: Value, window?: string): Origin {
    return { layer: layer.layer, name: layer.layer === 0 ? "base" : layer.name, file: line.loc.file, line: line.loc.line, col: line.loc.col, value, window, op };
  }

  private windowRange(w: { from?: string; until?: string; loc: Loc }, zone: string): [number | undefined, number | undefined] {
    const f = w.from !== undefined ? instant(w.from, zone, w.loc) : undefined;
    const u = w.until !== undefined ? instant(w.until, zone, w.loc) : undefined;
    if (f !== undefined && u !== undefined && f >= u) fail("K-204", "A time window must start before it ends", w.loc);
    return [f, u];
  }

  private active(range: [number | undefined, number | undefined]): boolean {
    return (range[0] === undefined || this.at >= range[0]) && (range[1] === undefined || this.at < range[1]);
  }

  private checkOverlaps(list: { range: [number | undefined, number | undefined]; paths: string[]; loc: Loc }[]): void {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const overlap = (a.range[0] ?? -Infinity) < (b.range[1] ?? Infinity) && (b.range[0] ?? -Infinity) < (a.range[1] ?? Infinity);
        if (!overlap) continue;
        const shared = a.paths.find((p) => b.paths.some((q) => p === q || p.startsWith(q + ".") || q.startsWith(p + ".")));
        if (shared) fail("K-603", `Two overlapping time windows both set "${shared}"`, b.loc, `The other window is at ${locStr(a.loc)}.`);
      }
    }
  }

  private checkKeys(to: string[], loc: Loc): void {
    for (const k of to) if (!this.keys.has(k)) fail("K-704", `Key "${k}" is not declared`, loc, `Declare it at the top level: key ${k} = "kpub..."`);
  }

  /** Applies the lines of a soul (base or added by a circle). */
  addSoul(ast: SoulAST, layer: Layer): void {
    if (this.souls.has(ast.id)) {
      const first = this.souls.get(ast.id)!;
      fail("K-401", `Soul "${ast.id}" is already declared at ${locStr(first.loc)}`, ast.loc);
    }
    const soul: SoulState = { id: ast.id, cov: ast.cov, loc: ast.loc, zone: layer.zone, layer: layer.layer, root: new Map(), invokes: [] };
    this.souls.set(ast.id, soul);
    this.order.push(ast.id);

    const windows: { w: Extract<BodyLine, { t: "window" }>; prefix: string[]; bound?: Loc; range: [number | undefined, number | undefined] }[] = [];
    const walk = (lines: BodyLine[], prefix: string[], bound: Loc | undefined, sealedTo: string[] | undefined, win?: { label: string }) => {
      for (const l of lines) {
        switch (l.t) {
          case "set": case "link": {
            const value: Value = l.t === "set" ? l.value : l.list ? { k: "list", items: l.ids.map((id) => ({ k: "link", id })) } : l.ids.length ? { k: "link", id: l.ids[0] } : VOID;
            if (win && l.bound) fail("K-105", "`bound` cannot be used inside a time window", l.loc);
            this.write(soul, [...prefix, l.field], value, this.origin(l, layer, l.t, value, win?.label), {
              override: !!win, bound: l.bound ? l.loc : bound, sealedTo, layer, window: win?.label,
            });
            break;
          }
          case "group": {
            if (win && l.bound) fail("K-105", "`bound` cannot be used inside a time window", l.loc);
            const segs = [...prefix, l.field];
            if (!win) {
              let map = soul.root;
              for (const s of prefix) map = map.get(s)!.children!;
              if (map.has(l.field)) fail("K-103", `Field "${segs.join(".")}" is set twice in soul ${soul.id}`, l.loc);
              map.set(l.field, { children: new Map(), bound: l.bound ? l.loc : bound, history: [this.origin(l, layer, "set", undefined, undefined)] });
            }
            walk(l.body, segs, l.bound ? l.loc : bound, sealedTo, win);
            break;
          }
          case "sealed":
            this.checkKeys(l.to, l.loc);
            walk(l.body, prefix, bound, l.to, win);
            break;
          case "invoke":
            if (win) fail("K-105", "Computed fields cannot sit inside a time window", l.loc);
            soul.invokes.push({ field: l.field, type: l.type, expr: l.expr, loc: l.loc, prefix: prefix.join(".") });
            break;
          case "window":
            if (win) fail("K-105", "Time windows cannot be nested", l.loc);
            windows.push({ w: l, prefix, bound, range: this.windowRange(l, layer.zone) });
            break;
          default:
            fail("K-105", "This line is only allowed inside a circle", (l as { loc: Loc }).loc);
        }
      }
    };
    walk(ast.body, [], undefined, undefined);

    // Windows override the plain lines of the same soul.
    const overlapList = windows.map(({ w, prefix, range }) => ({ range, loc: w.loc, paths: fieldPaths(w.body, prefix) }));
    this.checkOverlaps(overlapList);
    for (const { w, prefix, bound, range } of windows) {
      const label = windowLabel(w.from, w.until);
      this.windows.push({
        soul: soul.id, scope: layer.layer === 0 ? "base" : `circle ${layer.layer} ${layer.name}`, from: w.from, until: w.until,
        fromMs: range[0], untilMs: range[1], fields: describeFields(w.body, prefix), loc: w.loc,
      });
      if (this.active(range)) walk(w.body, prefix, bound, undefined, { label });
    }
  }

  /** Applies one circle's lines on top of the souls built so far. */
  applyCircle(c: CircleAST, layer: Layer): void {
    const windows: { w: Extract<BodyLine, { t: "window" }>; range: [number | undefined, number | undefined] }[] = [];
    const run = (lines: BodyLine[], win?: string) => {
      for (const l of lines) {
        switch (l.t) {
          case "soul":
            if (win) fail("K-105", "Souls cannot be declared inside a time window", l.soul.loc);
            this.addSoul(l.soul, layer);
            break;
          case "window":
            if (win) fail("K-105", "Time windows cannot be nested", l.loc);
            windows.push({ w: l, range: this.windowRange(l, layer.zone) });
            break;
          case "cset": case "clink": case "append": case "banish": {
            const soul = this.souls.get(l.path[0]);
            if (!soul) fail("K-402", `Circle ${c.name} changes unknown soul "${l.path[0]}"`, l.loc);
            const value: Value | undefined =
              l.t === "cset" || l.t === "append" ? l.value
              : l.t === "clink" ? (l.list ? { k: "list", items: l.ids.map((id) => ({ k: "link", id })) } : l.ids.length ? { k: "link", id: l.ids[0] } : VOID)
              : undefined;
            const op: Origin["op"] = l.t === "cset" ? "set" : l.t === "clink" ? "link" : l.t;
            this.write(soul, l.path.slice(1), value, this.origin(l, layer, op, value, win), { override: true, layer, window: win, append: l.t === "append" });
            break;
          }
          default:
            fail("K-105", "This line is not allowed inside a circle", (l as { loc: Loc }).loc);
        }
      }
    };
    run(c.body);
    this.checkOverlaps(windows.map(({ w, range }) => ({ range, loc: w.loc, paths: fieldPaths(w.body, []) })));
    for (const { w, range } of windows) {
      const bySoul = new Map<string, { path: string; value: string }[]>();
      for (const f of describeFields(w.body, [])) {
        const [soul, ...rest] = f.path.split(".");
        if (!bySoul.has(soul)) bySoul.set(soul, []);
        bySoul.get(soul)!.push({ path: rest.join("."), value: f.value });
      }
      for (const [soul, fields] of bySoul) {
        this.windows.push({ soul, scope: `circle ${layer.layer} ${layer.name}`, from: w.from, until: w.until, fromMs: range[0], untilMs: range[1], fields, loc: w.loc });
      }
      if (this.active(range)) run(w.body, windowLabel(w.from, w.until));
    }
  }
}

/** Full field paths a block of lines would set (used for overlap and conflict checks). */
function fieldPaths(lines: BodyLine[], prefix: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    switch (l.t) {
      case "set": case "link": out.push([...prefix, l.field].join(".")); break;
      case "group": out.push(...fieldPaths(l.body, [...prefix, l.field])); break;
      case "sealed": case "window": out.push(...fieldPaths(l.body, prefix)); break;
      case "cset": case "clink": case "append": case "banish": out.push(l.path.join(".")); break;
      case "soul": out.push(l.soul.id); break;
    }
  }
  return out;
}

function describeFields(lines: BodyLine[], prefix: string[]): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  for (const l of lines) {
    switch (l.t) {
      case "set": out.push({ path: [...prefix, l.field].join("."), value: toKitml(l.value) }); break;
      case "link": out.push({ path: [...prefix, l.field].join("."), value: l.list ? `-> [${l.ids.join(", ")}]` : `-> ${l.ids[0] ?? "void"}` }); break;
      case "group": out.push(...describeFields(l.body, [...prefix, l.field])); break;
      case "cset": out.push({ path: l.path.join("."), value: toKitml(l.value) }); break;
      case "clink": out.push({ path: l.path.join("."), value: l.list ? `-> [${l.ids.join(", ")}]` : `-> ${l.ids[0] ?? "void"}` }); break;
      case "append": out.push({ path: l.path.join("."), value: `+= ${toKitml(l.value)}` }); break;
      case "banish": out.push({ path: l.path.join("."), value: "banished" }); break;
    }
  }
  return out;
}

export function layer(files: FileAST[], requested: string[], at: number, entryZone: string): Layered {
  const keys = new Set(files.flatMap((f) => f.keys.map((k) => k.name)));
  const L = new Layering(at, keys);

  for (const f of files) for (const s of f.souls) L.addSoul(s, { layer: 0, name: "base", zone: f.zone ?? entryZone });

  // Circles: merge same-named circles across files, then pick the active ones.
  const circles = new Map<string, { num: number; parts: { c: CircleAST; zone: string }[]; always: boolean }>();
  for (const f of files) {
    for (const c of f.circles) {
      const known = circles.get(c.name);
      if (known && known.num !== c.num) fail("K-105", `Circle "${c.name}" is declared as circle ${known.num} and circle ${c.num}`, c.loc);
      if (known) { known.parts.push({ c, zone: f.zone ?? entryZone }); known.always ||= c.always; }
      else circles.set(c.name, { num: c.num, parts: [{ c, zone: f.zone ?? entryZone }], always: c.always });
    }
  }
  for (const name of requested) {
    if (!circles.has(name)) {
      const names = [...circles.keys()];
      fail("K-602", `There is no circle named "${name}"`, undefined, names.length ? `Circles in this realm: ${names.join(", ")}.` : "This realm has no circles.");
    }
  }
  const active = [...circles].filter(([name, c]) => c.always || requested.includes(name)).sort((a, b) => a[1].num - b[1].num);

  // Circle conflicts: same-number circles may not touch the same path.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const [an, a] = active[i], [bn, b] = active[j];
      if (a.num !== b.num) continue;
      const ap = a.parts.flatMap((p) => fieldPaths(p.c.body, []));
      const bp = b.parts.flatMap((p) => fieldPaths(p.c.body, []));
      const shared = ap.find((p) => bp.some((q) => p === q || p.startsWith(q + ".") || q.startsWith(p + ".")));
      if (shared) fail("K-601", `Circles "${an}" and "${bn}" are both circle ${a.num} and both change "${shared}"`, b.parts[0].c.loc);
    }
  }
  for (const [name, c] of active) for (const p of c.parts) L.applyCircle(p.c, { layer: c.num, name, zone: p.zone });

  return { souls: L.souls, order: L.order, windows: L.windows, activeCircles: active.map(([n]) => n) };
}

// ------------------------------------------------------------------ materialize

export interface SoulData {
  id: string;
  cov: string;
  loc: Loc;
  zone: string;
  data: GroupV;
  origins: Map<string, Origin[]>;
  bound: Map<string, Loc>;
  sealed: Map<string, string[]>;
  invokes: SoulInvoke[];
}

export function materialize(s: SoulState): SoulData {
  const origins = new Map<string, Origin[]>();
  const bound = new Map<string, Loc>();
  const sealed = new Map<string, string[]>();
  const toGroup = (map: Map<string, Entry>, prefix: string): GroupV => {
    const g: GroupV = { k: "group", fields: new Map() };
    for (const [k, e] of map) {
      const p = prefix ? `${prefix}.${k}` : k;
      origins.set(p, e.history);
      if (e.bound) bound.set(p, e.bound);
      if (e.sealedTo && !e.children) sealed.set(p, e.sealedTo);
      g.fields.set(k, e.children ? toGroup(e.children, p) : e.value!);
    }
    return g;
  };
  return { id: s.id, cov: s.cov, loc: s.loc, zone: s.zone, data: toGroup(s.root, ""), origins, bound, sealed, invokes: s.invokes };
}

export function todayFor(at: number, zone: string): string {
  return dateIn(at, zone);
}
