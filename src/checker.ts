import { fail, Loc } from "./errors";
import { evaluate, EvalContext, EV, Node, parseExpr, parseRequire, toValue } from "./expr";
import { Covenant, SoulData, SoulInvoke } from "./resolver";
import { instant } from "./time";
import { describeType, Rules, TypeExpr } from "./types";
import { UnitRegistry } from "./units";
import { clone, fmtNum, GroupV, NumV, toKitml, typeName, Value, VOID } from "./values";

export interface CheckInput {
  souls: Map<string, SoulData>;
  order: string[];
  covenants: Map<string, Covenant>;
  units: UnitRegistry;
  today: string;
  zone: string;
  strict: boolean;
}

interface Scope {
  soul: SoulData;
  prefix: string;
  group: GroupV;
  cov?: Covenant;
}

interface Pending {
  scope: Scope;
  field: string;
  type?: TypeExpr;
  expr: string;
  loc: Loc;
}

const NO_RULES: Rules = { optional: true, whole: false, unique: false };
const join = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);

export class Checker {
  private scopes: Scope[] = [];
  private pending = new Map<string, Pending>();
  private done = new Set<string>();
  private stack: string[] = [];
  private parsed = new Map<string, Node>();
  private roots = new Map<string, Scope>();

  constructor(private input: CheckInput) {}

  run(): void {
    const { souls, order } = this.input;
    for (const id of order) this.checkSoul(souls.get(id)!);
    this.checkUnique();
    this.registerInvokes();
    for (const key of this.pending.keys()) this.compute(key);
    for (const scope of this.scopes) this.checkRequires(scope);
    if (this.input.strict) this.checkExposed();
  }

  // ------------------------------------------------------------ helpers

  private locOf(s: SoulData, path: string): Loc {
    const h = s.origins.get(path);
    if (h && h.length) {
      const o = h[h.length - 1];
      return { file: o.file, line: o.line, col: o.col };
    }
    return s.loc;
  }

  private cov(name: string, loc: Loc): Covenant {
    return this.input.covenants.get(name) ?? fail("K-201", `Unknown covenant "${name}"`, loc);
  }

  // ------------------------------------------------------------ structure and types

  private checkSoul(s: SoulData): void {
    const cov = this.cov(s.cov, s.loc);
    const walk = (v: Value, p: string) => {
      if (v.k === "num" && v.unit) this.input.units.parse(v.unit, this.locOf(s, p));
      else if (v.k === "list") v.items.forEach((x) => walk(x, p));
      else if (v.k === "group") for (const [k, x] of v.fields) walk(x, join(p, k));
    };
    walk(s.data, "");
    this.checkGroup(s, cov, s.data, "");
  }

  private checkGroup(s: SoulData, cov: Covenant, g: GroupV, prefix: string): void {
    const scope: Scope = { soul: s, prefix, group: g, cov };
    this.scopes.push(scope);
    if (prefix === "") this.roots.set(s.id, scope);
    const computed = new Set([...cov.invokes.map((i) => i.field), ...s.invokes.filter((i) => i.prefix === prefix).map((i) => i.field)]);
    for (const name of g.fields.keys()) {
      const p = join(prefix, name);
      if (cov.invokes.some((i) => i.field === name)) fail("K-103", `${s.id}.${p} is computed by covenant ${cov.name} and cannot be set`, this.locOf(s, p));
      if (!cov.terms.has(name) && !computed.has(name) && !cov.open) {
        fail("K-206", `${s.id}.${p} is not a field of covenant ${cov.name}`, this.locOf(s, p));
      }
    }
    for (const term of cov.terms.values()) {
      const p = join(prefix, term.field);
      const v = g.fields.get(term.field);
      if (v === undefined || v.k === "void") {
        if (computed.has(term.field)) continue;
        if (v === undefined && term.rules.default) {
          const d = this.checkValue(clone(term.rules.default), term.type, term.rules, s, p, term.loc);
          g.fields.set(term.field, d);
          s.origins.set(p, [{ layer: -1, name: `default (${cov.name})`, op: "default", file: term.loc.file, line: term.loc.line, col: term.loc.col, value: d }]);
          continue;
        }
        if (term.rules.optional) continue;
        fail("K-202", v === undefined ? `${s.id} is missing the required field "${p}" (covenant ${cov.name})` : `${s.id}.${p} is void, but the field is required`, v === undefined ? s.loc : this.locOf(s, p));
      }
      if (v.k !== "sealed") g.fields.set(term.field, this.checkValue(v, term.type, term.rules, s, p));
      if (term.bound && !s.bound.has(p)) fail("K-502", `${s.id}.${p} must be written as \`bound ${term.field} = ...\` (covenant ${cov.name})`, this.locOf(s, p));
      if (term.sealed && !s.sealed.has(p)) fail("K-703", `${s.id}.${p} must sit inside a \`sealed to\` block (covenant ${cov.name})`, this.locOf(s, p));
    }
  }

  private toUnit(v: NumV, unit: string | undefined, s: SoulData, p: string, loc: Loc): NumV {
    const { units } = this.input;
    if (v.unit) units.parse(v.unit, loc);
    if (!unit) {
      if (v.unit) fail("K-302", `${s.id}.${p} should be a plain number, not a quantity in ${v.unit}`, loc);
      return v;
    }
    if (unit === "money") {
      if (!units.isMoney(v.unit)) fail("K-302", `${s.id}.${p} should be an amount of money, e.g. ${fmtNum(v.v)} USD`, loc);
      return v;
    }
    if (!v.unit) fail("K-302", `${s.id}.${p} needs a unit: write it as a quantity in ${unit}, e.g. ${v.frac ? v.frac.join("/") : fmtNum(v.v)} ${unit}`, loc);
    if (!units.sameDims(v.unit, unit)) {
      const what = units.isMoney(unit) || units.isMoney(v.unit) ? `${v.unit} cannot be used where ${unit} is expected` : `${v.unit} is not the same kind of unit as ${unit}`;
      fail("K-302", `${s.id}.${p}: ${what}`, loc, units.isMoney(unit) || units.isMoney(v.unit) ? "Money is never converted automatically, since exchange rates change." : undefined);
    }
    if (v.unit === unit) return v;
    return { k: "num", v: units.convert(v.v, v.unit, unit, loc), unit };
  }

  checkValue(v: Value, type: TypeExpr, rules: Rules, s: SoulData, p: string, at?: Loc): Value {
    const loc = at ?? this.locOf(s, p);
    const bad = (hint?: string): never => fail("K-203", `${s.id}.${p} should be ${describeType(type)}, but is ${typeName(v)}`, loc, hint);
    if (v.k === "sealed") return v;
    if (v.k === "void") {
      if (!rules.optional) fail("K-202", `${s.id}.${p} is void, but the field is required`, loc);
      return v;
    }
    let out: Value = v;
    switch (type.t) {
      case "any": break;
      case "text": if (v.k !== "text") bad(v.k === "sym" ? "Text must be written in double quotes." : undefined); break;
      case "bool": if (v.k !== "bool") bad("Use true or false."); break;
      case "date": if (v.k !== "date") bad(); break;
      case "timestamp": if (v.k !== "ts") bad(); break;
      case "number": case "fraction":
        if (v.k !== "num") bad(v.k === "text" ? "Numbers are written without quotes." : undefined);
        out = this.toUnit(v as NumV, type.unit, s, p, loc);
        if (type.t === "number" && (out as NumV).frac && type.unit === undefined) out = { k: "num", v: (out as NumV).v };
        break;
      case "oneof":
        if (v.k !== "sym" || !type.options.includes(v.v)) {
          if (v.k === "text" && type.options.includes(v.v)) bad(`Write ${v.v} without quotes; choices are symbols.`);
          fail("K-203", `${s.id}.${p} must be one of [${type.options.join(", ")}], not ${toKitml(v)}`, loc);
        }
        break;
      case "list":
        if (v.k !== "list") bad();
        out = { k: "list", items: (v as Extract<Value, { k: "list" }>).items.map((x, i) => this.checkValue(x, type.of, NO_RULES, s, `${p}[${i}]`, loc)) };
        break;
      case "link": {
        if (v.k !== "link") bad(v.k === "sym" ? `Links are written with ->, e.g. ${p.split(".").pop()} -> ${v.v}` : undefined);
        const id = (v as Extract<Value, { k: "link" }>).id;
        const target = this.input.souls.get(id);
        if (!target) fail("K-402", `${s.id}.${p} links to "${id}", but no soul has that ID`, loc);
        const tc = this.cov(target.cov, target.loc);
        if (!tc.chain.includes(type.cov)) fail("K-403", `${s.id}.${p} must link to a ${type.cov}, but "${id}" is a ${target.cov}`, loc);
        break;
      }
      case "cov":
        if (v.k !== "group") bad();
        this.checkGroup(s, this.cov(type.name, loc), v as GroupV, p);
        break;
      case "shape": {
        if (v.k !== "group") bad();
        const g = v as GroupV;
        for (const k of g.fields.keys()) if (!type.fields.has(k)) fail("K-206", `${s.id}.${p}.${k} is not part of ${describeType(type)}`, loc);
        for (const [k, ft] of type.fields) {
          const x = g.fields.get(k);
          if (x === undefined) fail("K-202", `${s.id}.${p} is missing "${k}"`, loc);
          g.fields.set(k, this.checkValue(x, ft, { ...NO_RULES, optional: false }, s, `${p}.${k}`, loc));
        }
        break;
      }
    }
    this.checkRules(out, type, rules, s, p, loc);
    return out;
  }

  private checkRules(v: Value, type: TypeExpr, rules: Rules, s: SoulData, p: string, loc: Loc): void {
    const where = `${s.id}.${p}`;
    if (rules.whole && (v.k !== "num" || !Number.isInteger(v.v))) fail("K-204", `${where} must be a whole number, not ${toKitml(v)}`, loc);
    if (rules.matching) {
      if (v.k !== "text") fail("K-203", `${where} must be text to use \`matching\``, loc);
      if (!rules.matching.re.test(v.v)) fail("K-205", `${where} = ${toKitml(v)} does not match "${rules.matching.source}"`, loc);
    }
    if (rules.length) {
      const n = v.k === "text" ? [...v.v].length : v.k === "list" ? v.items.length : undefined;
      if (n === undefined) fail("K-203", `${where}: \`length\` applies to text and lists`, loc);
      if (n < rules.length[0] || n > rules.length[1]) fail("K-204", `${where} has length ${n}, outside ${rules.length[0]} to ${rules.length[1]}`, loc);
    }
    if (rules.between) {
      const [lo, hi] = rules.between;
      let x: number, a: number, b: number;
      if (v.k === "num") {
        const unit = v.unit ?? (type.t === "number" || type.t === "fraction" ? type.unit : undefined);
        const conv = (bound: Value): number => {
          if (bound.k !== "num") fail("K-203", `The bounds of ${where} must be numbers`, loc);
          if (!bound.unit || !unit) return bound.v;
          if (!this.input.units.sameDims(bound.unit, unit)) fail("K-302", `The bounds of ${where} use ${bound.unit}, which does not match ${unit}`, loc);
          return this.input.units.convert(bound.v, bound.unit, unit, loc);
        };
        [x, a, b] = [v.v, conv(lo), conv(hi)];
      } else if ((v.k === "date" || v.k === "ts") && (lo.k === "date" || lo.k === "ts") && (hi.k === "date" || hi.k === "ts")) {
        const z = s.zone;
        [x, a, b] = [instant(v.v, z, loc), instant(lo.v, z, loc), instant(hi.v, z, loc)];
      } else fail("K-203", `\`between\` cannot compare ${typeName(v)}`, loc);
      const eps = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      if (x < a - eps || x > b + eps) fail("K-204", `${where} = ${toKitml(v)} is outside ${toKitml(lo)} to ${toKitml(hi)}`, loc);
    }
  }

  private checkUnique(): void {
    const seen = new Map<string, string>();
    for (const scope of this.scopes) {
      if (!scope.cov) continue;
      for (const term of scope.cov.terms.values()) {
        if (!term.rules.unique) continue;
        const v = scope.group.fields.get(term.field);
        if (v === undefined || v.k === "void") continue;
        const key = `${term.declaredIn}\u0000${scope.prefix}\u0000${term.field}\u0000${toKitml(v)}`;
        const p = join(scope.prefix, term.field);
        const first = seen.get(key);
        if (first) fail("K-404", `${scope.soul.id}.${p} = ${toKitml(v)}, but ${first} already has that value (unique in ${term.declaredIn})`, this.locOf(scope.soul, p));
        seen.set(key, `${scope.soul.id}.${p}`);
      }
    }
  }

  // ------------------------------------------------------------ invocations

  private key(soul: string, prefix: string, field: string): string {
    return `${soul}\u0000${prefix}\u0000${field}`;
  }

  private registerInvokes(): void {
    const covScopes = [...this.scopes];
    for (const scope of covScopes) {
      for (const inv of scope.cov!.invokes) this.pending.set(this.key(scope.soul.id, scope.prefix, inv.field), { scope, ...inv });
    }
    for (const id of this.input.order) {
      const s = this.input.souls.get(id)!;
      for (const inv of s.invokes) this.addSoulInvoke(s, inv, covScopes);
    }
  }

  private addSoulInvoke(s: SoulData, inv: SoulInvoke, covScopes: Scope[]): void {
    let scope = covScopes.find((x) => x.soul === s && x.prefix === inv.prefix);
    if (!scope) {
      let g: Value = s.data;
      for (const seg of inv.prefix ? inv.prefix.split(".") : []) g = g.k === "group" ? g.fields.get(seg) ?? VOID : VOID;
      if (g.k !== "group") fail("K-203", `Computed field ${s.id}.${join(inv.prefix, inv.field)} sits in something that is not a group`, inv.loc);
      scope = { soul: s, prefix: inv.prefix, group: g };
      this.scopes.push(scope);
    }
    const k = this.key(s.id, inv.prefix, inv.field);
    if (this.pending.has(k)) fail("K-103", `${s.id}.${join(inv.prefix, inv.field)} is computed twice`, inv.loc);
    if (scope.group.fields.has(inv.field)) fail("K-103", `${s.id}.${join(inv.prefix, inv.field)} is both set and computed`, inv.loc);
    this.pending.set(k, { scope, field: inv.field, type: inv.type, expr: inv.expr, loc: inv.loc });
  }

  private context(scope: Scope, loc: Loc): EvalContext {
    const { units, today, zone, souls, covenants } = this.input;
    return {
      units, today, zone, loc,
      lookup: (name) => this.lookup(scope, name),
      soulExists: (id) => souls.has(id),
      soulField: (id, name) => {
        const target = this.roots.get(id);
        return target ? this.lookup(target, name) : undefined;
      },
      covenantSouls: (name) => {
        if (!covenants.has(name)) return undefined;
        return this.input.order.filter((id) => covenants.get(souls.get(id)!.cov)?.chain.includes(name));
      },
    };
  }

  private lookup(scope: Scope, name: string): EV | undefined {
    const k = this.key(scope.soul.id, scope.prefix, name);
    if (this.pending.has(k)) return this.compute(k);
    const v = scope.group.fields.get(name);
    if (v !== undefined) return v;
    if (scope.cov?.terms.has(name)) return VOID;
    return undefined;
  }

  private compute(k: string): Value {
    const job = this.pending.get(k)!;
    const { scope, field } = job;
    if (this.done.has(k)) return scope.group.fields.get(field) ?? VOID;
    if (this.stack.includes(k)) {
      const names = [...this.stack.slice(this.stack.indexOf(k)), k].map((x) => { const j = this.pending.get(x)!; return `${j.scope.soul.id}.${join(j.scope.prefix, j.field)}`; });
      fail("K-801", `Computed fields depend on each other in a loop: ${names.join(" -> ")}`, job.loc);
    }
    this.stack.push(k);
    let node = this.parsed.get(k);
    if (!node) { node = parseExpr(job.expr, job.loc, this.input.units); this.parsed.set(k, node); }
    let result = toValue(evaluate(node, this.context(scope, job.loc)));
    this.stack.pop();

    const p = join(scope.prefix, field);
    const term = scope.cov?.terms.get(field);
    const type = job.type ?? term?.type;
    if (type && result.k === "num" && !result.unit && (type.t === "number" || type.t === "fraction") && type.unit && type.unit !== "money") {
      result = { ...result, unit: type.unit };
    }
    scope.group.fields.set(field, result);
    scope.soul.origins.set(p, [{ layer: -1, name: "computed", op: "computed", file: job.loc.file, line: job.loc.line, col: job.loc.col, value: result }]);
    if (type) result = this.checkValue(result, type, term?.rules ?? NO_RULES, scope.soul, p, job.loc);
    scope.group.fields.set(field, result);
    this.done.add(k);
    return result;
  }

  // ------------------------------------------------------------ requirements and secrets

  private checkRequires(scope: Scope): void {
    if (!scope.cov) return;
    for (const req of scope.cov.requires) {
      const { cond, message } = parseRequire(req.expr, req.loc, this.input.units);
      const v = evaluate(cond, this.context(scope, req.loc));
      if (v.k === "sealed") continue;
      if (v.k !== "bool") fail("K-203", `Requirement "${req.expr}" must be true or false, but gave ${v.k}`, req.loc);
      if (!v.v) {
        const who = scope.prefix ? `${scope.soul.id}.${scope.prefix}` : scope.soul.id;
        fail("K-207", `${who}: ${message ?? `requirement failed: ${req.expr}`}`, scope.soul.loc, `Rule declared in covenant ${scope.cov.name} at line ${req.loc.line}.`);
      }
    }
  }

  private checkExposed(): void {
    for (const id of this.input.order) {
      const s = this.input.souls.get(id)!;
      for (const [p] of s.sealed) {
        const v = getPath(s.data, p);
        if (v && v.k !== "sealed") fail("K-701", `${s.id}.${p} is in a sealed block but is not encrypted`, this.locOf(s, p));
      }
    }
  }
}

export function getPath(g: GroupV, p: string): Value | undefined {
  let cur: Value | undefined = g;
  for (const seg of p.split(".")) {
    if (!cur || cur.k !== "group") return undefined;
    cur = cur.fields.get(seg);
  }
  return cur;
}
