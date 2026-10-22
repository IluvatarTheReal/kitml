import { getPath } from "./checker";
import { Covenant, Origin, SoulData, WindowInfo } from "./resolver";
import { UnitRegistry } from "./units";
import { fmtNum, fmtQuantity, GroupV, toJSONValue, toKitml, Value } from "./values";

/** A number with a unit, as returned by Realm.get(). */
export class Quantity {
  constructor(
    readonly value: number,
    readonly unit: string | undefined,
    private readonly units: UnitRegistry,
    readonly fraction?: [number, number],
  ) {}
  /** Converts to another unit of the same kind, e.g. weight.to("oz"). */
  to(unit: string): Quantity {
    if (!this.unit) throw new Error("A plain number has no unit to convert");
    return new Quantity(this.units.convert(this.value, this.unit, unit), unit, this.units);
  }
  valueOf(): number { return this.value; }
  toString(): string { return fmtQuantity({ k: "num", v: this.value, unit: this.unit, frac: this.fraction }); }
  toJSON(): unknown { return toJSONValue({ k: "num", v: this.value, unit: this.unit, frac: this.fraction }); }
}

/** An encrypted value the engine cannot read. */
export class Sealed {
  constructor(readonly to: string[]) {}
  toString(): string { return "<sealed>"; }
  toJSON(): unknown { return { $sealed: this.to }; }
}

/** A soul as a plain object: fields by name, links followed to the linked soul. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Soul = { [field: string]: any };

export interface OriginInfo {
  /** 0 = base data, 1-9 = circle, -1 = default or computed. */
  layer: number;
  source: string;
  file: string;
  line: number;
  value: string;
  window?: string;
  wins: boolean;
}

export interface LinkRef { from: string; to: string }

export interface TimelineEvent {
  date: string;
  change: "starts" | "ends";
  scope: string;
  fields: { path: string; value: string }[];
  past: boolean;
}

export interface RealmParts {
  souls: Map<string, SoulData>;
  order: string[];
  covenants: Map<string, Covenant>;
  units: UnitRegistry;
  windows: WindowInfo[];
  activeCircles: string[];
  at: number;
  zone: string;
  files: string[];
}

/** A loaded, checked set of souls. */
export class Realm {
  /** Moment the realm was evaluated at (epoch ms). */
  readonly at: number;
  readonly circles: readonly string[];
  readonly files: readonly string[];
  private views = new Map<string, Soul>();

  constructor(private parts: RealmParts) {
    this.at = parts.at;
    this.circles = parts.activeCircles;
    this.files = parts.files;
  }

  /** IDs of every soul, in declaration order. */
  ids(): string[] { return [...this.parts.order]; }
  has(id: string): boolean { return this.parts.souls.has(id); }
  covenantOf(id: string): string | undefined { return this.parts.souls.get(id)?.cov; }
  covenants(): string[] { return [...this.parts.covenants.keys()]; }

  /** Raw value at a dotted path such as "api-1.network.ip", following links. */
  value(path: string): Value | undefined {
    const [id, ...rest] = path.split(".");
    let soul = this.parts.souls.get(id);
    if (!soul) return undefined;
    let cur: Value = soul.data;
    for (let i = 0; i < rest.length; i++) {
      if (cur.k === "link") {
        soul = this.parts.souls.get(cur.id);
        if (!soul) return undefined;
        cur = soul.data;
      }
      if (cur.k !== "group") return undefined;
      const next = cur.fields.get(rest[i]);
      if (next === undefined) return undefined;
      cur = next;
    }
    return cur;
  }

  /** True when the field was written inside a `sealed to` block. */
  isSealed(path: string): boolean {
    const [id, ...rest] = path.split(".");
    const s = this.parts.souls.get(id);
    if (!s) return false;
    const p = rest.join(".");
    return [...s.sealed.keys()].some((k) => k === p || k.startsWith(p + "."));
  }

  /** A soul as a plain object. Links become the linked soul's object. */
  get(id: string): Soul | undefined {
    const cached = this.views.get(id);
    if (cached) return cached;
    const s = this.parts.souls.get(id);
    if (!s) return undefined;
    const obj: Soul = {};
    Object.defineProperty(obj, "$id", { value: id, enumerable: false });
    Object.defineProperty(obj, "$is", { value: s.cov, enumerable: false });
    this.views.set(id, obj);
    this.fill(obj, s.data);
    return obj;
  }

  private fill(obj: Record<string, unknown>, g: GroupV): void {
    for (const [k, v] of g.fields) {
      if (v.k === "link") Object.defineProperty(obj, k, { get: () => this.get(v.id), enumerable: true });
      else obj[k] = this.view(v);
    }
  }

  private view(v: Value): unknown {
    switch (v.k) {
      case "text": case "date": case "ts": case "sym": return v.v;
      case "bool": return v.v;
      case "void": return null;
      case "num": return v.unit || v.frac ? new Quantity(v.v, v.unit, this.parts.units, v.frac) : v.v;
      case "list": return v.items.map((x) => (x.k === "link" ? this.get(x.id) : this.view(x)));
      case "group": { const o: Record<string, unknown> = {}; this.fill(o, v); return o; }
      case "link": return this.get(v.id);
      case "sealed": return new Sealed(v.to);
    }
  }

  /** Every soul of a covenant, including covenants that extend it. */
  all(covenant: string): Soul[] {
    return this.parts.order
      .filter((id) => this.parts.covenants.get(this.parts.souls.get(id)!.cov)?.chain.includes(covenant))
      .map((id) => this.get(id)!);
  }

  /** Every layer that set a value, newest first; the first one wins. */
  origin(path: string): OriginInfo[] {
    const [id, ...rest] = path.split(".");
    const s = this.parts.souls.get(id);
    if (!s) return [];
    const history: Origin[] = s.origins.get(rest.join(".")) ?? [];
    return [...history].reverse().map((o, i) => ({
      layer: o.layer,
      source: o.layer === 0 ? "base" : o.layer > 0 ? `circle ${o.layer} ${o.name}` : o.name,
      file: o.file,
      line: o.line,
      value: o.op === "banish" ? "banished" : o.value ? (o.op === "append" ? `+= ${toKitml(o.value)}` : toKitml(o.value)) : "(group)",
      window: o.window,
      wins: i === 0,
    }));
  }

  /** Every field, in any soul, that links to the given soul. */
  linksTo(id: string): LinkRef[] {
    const out: LinkRef[] = [];
    const walk = (v: Value, p: string) => {
      if (v.k === "link" && v.id === id) out.push({ from: p, to: id });
      else if (v.k === "list") v.items.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (v.k === "group") for (const [k, x] of v.fields) walk(x, p ? `${p}.${k}` : k);
    };
    for (const sid of this.parts.order) walk(this.parts.souls.get(sid)!.data, sid);
    return out;
  }

  /** Start and end of every time window that affects a soul, in date order. */
  timeline(id: string): TimelineEvent[] {
    const events: (TimelineEvent & { ms: number })[] = [];
    for (const w of this.parts.windows) {
      if (w.soul !== id) continue;
      if (w.from !== undefined) events.push({ date: w.from, ms: w.fromMs!, change: "starts", scope: w.scope, fields: w.fields, past: w.fromMs! <= this.at });
      if (w.until !== undefined) events.push({ date: w.until, ms: w.untilMs!, change: "ends", scope: w.scope, fields: w.fields, past: w.untilMs! <= this.at });
    }
    return events.sort((a, b) => a.ms - b.ms).map(({ ms, ...e }) => { void ms; return e; });
  }

  /** Plain JSON. Values in sealed blocks are hidden unless `reveal` is true. */
  toJSON(opts: { reveal?: boolean } = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const id of this.parts.order) {
      const s = this.parts.souls.get(id)!;
      const body = toJSONValue(s.data) as Record<string, unknown>;
      if (!opts.reveal) {
        for (const [p, to] of s.sealed) {
          const segs = p.split(".");
          let o: Record<string, unknown> = body;
          for (const seg of segs.slice(0, -1)) o = o[seg] as Record<string, unknown>;
          if (o && segs[segs.length - 1] in o) o[segs[segs.length - 1]] = { $sealed: to };
        }
      }
      out[id] = { $is: s.cov, ...body };
    }
    return out;
  }

  /** A field rendered as Kitml text, respecting seals. */
  render(path: string, reveal = false): string | undefined {
    const v = this.value(path);
    if (v === undefined) return undefined;
    if (!reveal && v.k !== "group" && this.isSealed(path)) return "<sealed>";
    return toKitml(v);
  }

  /** Window start and end moments after `at`, used to check every future state. */
  futureBoundaries(): number[] {
    const set = new Set<number>();
    for (const w of this.parts.windows) {
      if (w.fromMs !== undefined && w.fromMs > this.at) set.add(w.fromMs);
      if (w.untilMs !== undefined && w.untilMs > this.at) set.add(w.untilMs);
    }
    return [...set].sort((a, b) => a - b);
  }

  /** Internal access for tools. */
  soulData(id: string): SoulData | undefined { return this.parts.souls.get(id); }
  get windowCount(): number { return this.parts.windows.length; }
  get units(): UnitRegistry { return this.parts.units; }
  static fmt(n: number): string { return fmtNum(n); }
  /** Exposes getPath for tools. */
  static getPath = getPath;
}
