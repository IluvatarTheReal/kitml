#!/usr/bin/env node
import * as path from "path";
import { check, ERROR_NAMES, KitmlError, load, LoadOptions, Realm, VERSION } from "../src/index";
import { toKitml, Value } from "../src/values";

const HELP = `kitml ${VERSION} — reference engine for Kitml

Usage:
  kitml check <file>               Validate types, units, links, bonds, circles and every future time window
  kitml show <file> [path]         Print a soul, a field, or (with no path) every soul
  kitml origin <file> <path>       Show which layer, file and line set a value
  kitml links-to <file> <id>       List every field that links to a soul
  kitml timeline <file> <id>       List upcoming time-window changes for a soul
  kitml to json <file>             Export the loaded realm as JSON
  kitml errors                     List every error code

Options:
  --circle <name>      Apply a circle (repeatable, or comma-separated)
  --at <date>          Evaluate at a date or timestamp instead of now
  --strict             Fail on plain-text values in sealed blocks (K-701)
  --reveal             Show values from sealed blocks
  --fields <a,b>       With show: print only these fields of the soul
  --all                With timeline: include past changes
  --allow-outside      Let possess reach files outside the entry folder
  --indent <n>         With to json: indentation (default 2)
  -h, --help           Show this help
  -v, --version        Show the engine version

Not in engine 0.1: kitml seal, kitml reseal (encryption), kitml fmt, kitml to yaml.`;

interface Args {
  positional: string[];
  circles: string[];
  at?: string;
  strict: boolean;
  reveal: boolean;
  all: boolean;
  allowOutside: boolean;
  fields?: string[];
  indent: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], circles: [], strict: false, reveal: false, all: false, allowOutside: false, indent: 2 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${x} needs a value`);
      return v;
    };
    if (x === "--circle" || x === "-c") a.circles.push(...val().split(",").map((s) => s.trim()).filter(Boolean));
    else if (x.startsWith("--circle=")) a.circles.push(...x.slice(9).split(",").filter(Boolean));
    else if (x === "--at") a.at = val();
    else if (x.startsWith("--at=")) a.at = x.slice(5);
    else if (x === "--strict") a.strict = true;
    else if (x === "--reveal") a.reveal = true;
    else if (x === "--all") a.all = true;
    else if (x === "--allow-outside") a.allowOutside = true;
    else if (x === "--fields") a.fields = val().split(",").map((s) => s.trim());
    else if (x === "--indent") a.indent = Number(val());
    else if (x === "-h" || x === "--help") { console.log(HELP); process.exit(0); }
    else if (x === "-v" || x === "--version") { console.log(VERSION); process.exit(0); }
    else if (x.startsWith("-")) usage(`Unknown option ${x}`);
    else a.positional.push(x);
  }
  return a;
}

function usage(msg: string): never {
  console.error(`kitml: ${msg}\nRun \`kitml --help\` for usage.`);
  process.exit(2);
}

const rel = (f: string) => path.relative(process.cwd(), f) || f;

// ------------------------------------------------------------- rendering

function annotate(realm: Realm, id: string, p: string): string {
  const s = realm.soulData(id)!;
  const notes: string[] = [];
  if (s.bound.has(p)) notes.push("bound");
  if ([...s.sealed.keys()].includes(p)) notes.push(`sealed to ${s.sealed.get(p)!.join(", ")}`);
  const h = s.origins.get(p);
  const last = h?.[h.length - 1];
  if (last) {
    if (last.op === "computed") notes.push("computed");
    else if (last.op === "default") notes.push("default");
    else if (last.layer > 0) notes.push(`circle ${last.layer} ${last.name}`);
    if (last.window) notes.push(last.window);
  }
  return notes.length ? `   -- ${notes.join(", ")}` : "";
}

function fieldLine(realm: Realm, id: string, p: string, name: string, v: Value, width: number, reveal: boolean): string {
  const pad = name.padEnd(width);
  const shown = !reveal && v.k !== "group" && realm.isSealed(`${id}.${p}`) ? "<sealed>" : null;
  if (v.k === "link") return `${pad} -> ${v.id}`;
  if (v.k === "list" && v.items.length && v.items.every((x) => x.k === "link")) return `${pad} -> [${v.items.map((x) => (x as { id: string }).id).join(", ")}]`;
  return `${pad} = ${shown ?? toKitml(v)}`;
}

function groupRows(realm: Realm, id: string, g: Extract<Value, { k: "group" }>, prefix: string, indent: string, reveal: boolean, only?: string[]): [string, string][] {
  const out: [string, string][] = [];
  const entries = [...g.fields].filter(([k]) => !only || only.includes(k));
  const width = Math.max(0, ...entries.filter(([, v]) => v.k !== "group").map(([k]) => k.length));
  for (const [k, v] of entries) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v.k === "group") {
      out.push([`${indent}${k}`, annotate(realm, id, p)]);
      out.push(...groupRows(realm, id, v, p, indent + "  ", reveal));
    } else {
      out.push([`${indent}${fieldLine(realm, id, p, k, v, width, reveal)}`, annotate(realm, id, p)]);
    }
  }
  return out;
}

/** Lines of a group, with `-- notes` lined up in one column. */
function renderGroup(realm: Realm, id: string, g: Extract<Value, { k: "group" }>, prefix: string, indent: string, reveal: boolean, only?: string[]): string[] {
  const rows = groupRows(realm, id, g, prefix, indent, reveal, only);
  const col = Math.min(48, Math.max(0, ...rows.filter(([, n]) => n).map(([t]) => t.length)));
  return rows.map(([t, n]) => (n ? `${t.padEnd(col)}${n}` : t));
}

function renderSoul(realm: Realm, id: string, reveal: boolean, only?: string[]): string {
  const s = realm.soulData(id)!;
  if (only) {
    const missing = only.filter((f) => !s.data.fields.has(f));
    if (missing.length) usage(`${id} has no field ${missing.join(", ")}`);
    return renderGroup(realm, id, s.data, "", "", reveal, only).join("\n");
  }
  return [`soul ${id} is ${s.cov}`, ...renderGroup(realm, id, s.data, "", "  ", reveal), "seal"].join("\n");
}

function table(rows: string[][], gap = "   "): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join(gap).trimEnd()).join("\n");
}

// ------------------------------------------------------------- commands

function options(a: Args): LoadOptions {
  return { circles: a.circles, at: a.at, strict: a.strict, allowOutside: a.allowOutside };
}

function needFile(a: Args, n: number, what: string): string[] {
  if (a.positional.length < n) usage(`Missing ${what}`);
  return a.positional;
}

function run(argv: string[]): void {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a.positional;
  a.positional = rest;
  switch (cmd) {
    case undefined: console.log(HELP); return;
    case "check": {
      const [file] = needFile(a, 1, "file");
      const { realm, moments } = check(file, options(a));
      const souls = realm.ids().length;
      const circles = realm.circles.length ? `, circles ${realm.circles.join(" + ")}` : "";
      console.log(`✔ ${rel(file)} is sound: ${souls} soul${souls === 1 ? "" : "s"}, ${realm.covenants().length} covenant${realm.covenants().length === 1 ? "" : "s"}, ${realm.files.length} file${realm.files.length === 1 ? "" : "s"}${circles}; checked at ${moments} moment${moments === 1 ? "" : "s"}.`);
      return;
    }
    case "show": {
      const [file, p] = needFile(a, 1, "file");
      const realm = load(file, options(a));
      if (!p) { console.log(realm.ids().map((id) => renderSoul(realm, id, a.reveal)).join("\n\n")); return; }
      if (realm.has(p)) { console.log(renderSoul(realm, p, a.reveal, a.fields)); return; }
      const v = realm.value(p);
      if (v === undefined) usage(`Nothing at "${p}"`);
      const [id, ...segs] = p.split(".");
      if (v.k === "group") console.log(renderGroup(realm, id, v, segs.join("."), "", a.reveal).join("\n"));
      else console.log(realm.render(p, a.reveal));
      return;
    }
    case "origin": {
      const [file, p] = needFile(a, 2, "file and path");
      const realm = load(file, options(a));
      const hist = realm.origin(p);
      if (!hist.length) usage(`Nothing at "${p}"`);
      const now = realm.render(p, a.reveal) ?? "(not set)";
      console.log(now.startsWith("->") ? `${p} ${now}` : `${p} = ${now}`);
      console.log(table(hist.map((o) => [
        "  " + (o.layer === 0 ? "circle 0 base" : o.source),
        `${rel(o.file)}:${o.line}`,
        o.wins && !a.reveal && realm.isSealed(p) ? "<sealed>" : o.value,
        (o.window ? `${o.window}, ` : "") + (o.wins ? "wins" : "overridden"),
      ].map((c, i) => (i === 3 ? `(${c})` : c)))));
      return;
    }
    case "links-to": {
      const [file, id] = needFile(a, 2, "file and soul ID");
      const realm = load(file, options(a));
      if (!realm.has(id)) usage(`There is no soul "${id}"`);
      const links = realm.linksTo(id);
      if (!links.length) { console.log(`Nothing links to ${id}.`); return; }
      console.log(table(links.map((l) => [l.from, `-> ${l.to}`])));
      return;
    }
    case "timeline": {
      const [file, id] = needFile(a, 2, "file and soul ID");
      const realm = load(file, options(a));
      if (!realm.has(id)) usage(`There is no soul "${id}"`);
      const events = realm.timeline(id).filter((e) => a.all || !e.past);
      if (!events.length) { console.log(`No ${a.all ? "" : "upcoming "}time-window changes for ${id}.`); return; }
      console.log(table(events.map((e) => [
        e.date, e.change, e.scope,
        e.change === "starts" ? e.fields.map((f) => `${f.path} = ${f.value}`).join(", ") : e.fields.map((f) => f.path).join(", ") + " revert",
        e.past ? "(past)" : "",
      ])));
      return;
    }
    case "to": {
      const [format, file] = needFile(a, 2, "format and file");
      if (format !== "json") usage(format === "yaml" ? "`kitml to yaml` is not in engine 0.1; use `kitml to json`" : `Unknown format "${format}"`);
      const realm = load(file, options(a));
      console.log(JSON.stringify(realm.toJSON({ reveal: a.reveal }), null, a.indent));
      return;
    }
    case "errors":
      console.log(table(Object.entries(ERROR_NAMES).map(([c, n]) => [c, n])));
      return;
    case "seal": case "reseal": case "fmt":
      usage(`\`kitml ${cmd}\` is not available in engine 0.1`);
    default:
      usage(`Unknown command "${cmd}"`);
  }
}

try {
  run(process.argv.slice(2));
} catch (e) {
  if (e instanceof KitmlError) {
    console.error(e.format());
    process.exit(1);
  }
  console.error(`kitml: ${(e as Error).message}`);
  process.exit(2);
}
