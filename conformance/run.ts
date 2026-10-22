/**
 * Runs the Kitml conformance suite against this engine.
 * Usage: node dist/conformance/run.js [filter]
 */
import * as fs from "fs";
import * as path from "path";
import { check, KitError, load, LoadOptions } from "../src/index";

const ROOT = path.resolve(__dirname, "..", "..", "conformance");
const DEFAULT_AT = "2026-10-22T12:00:00Z";

interface CaseOptions extends LoadOptions {
  mode?: "load" | "check";
  entry?: string;
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function options(dir: string): CaseOptions {
  const f = path.join(dir, "options.json");
  const o: CaseOptions = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  return { at: DEFAULT_AT, ...o };
}

function runCase(dir: string): Record<string, unknown> {
  const o = options(dir);
  const entry = path.join(dir, o.entry ?? "input.kit");
  return o.mode === "check" ? check(entry, o).realm.toJSON() : load(entry, o).toJSON();
}

function cases(kind: string, filter?: string): string[] {
  const base = path.join(ROOT, kind);
  return fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).filter((d) => !filter || d.includes(filter)).sort().map((d) => path.join(base, d));
}

const filter = process.argv[2];
const failures: string[] = [];
let passed = 0;

for (const dir of cases("valid", filter)) {
  const name = `valid/${path.basename(dir)}`;
  try {
    const actual = canon(runCase(dir));
    const expected = canon(JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8")));
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
    else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  } catch (e) {
    failures.push(`${name}\n    unexpected error: ${e instanceof KitError ? e.format().replace(/\n/g, "\n    ") : (e as Error).stack}`);
  }
}

for (const dir of cases("invalid", filter)) {
  const name = `invalid/${path.basename(dir)}`;
  const spec = fs.readFileSync(path.join(dir, "expected-error"), "utf8").trim().split("\n");
  const code = spec[0].trim();
  const line = spec.find((l) => l.startsWith("line:"))?.slice(5).trim();
  try {
    runCase(dir);
    failures.push(`${name}\n    expected ${code}, but the realm loaded without errors`);
  } catch (e) {
    if (!(e instanceof KitError)) { failures.push(`${name}\n    expected ${code}, got a crash: ${(e as Error).stack}`); continue; }
    if (e.code !== code) failures.push(`${name}\n    expected ${code}, got ${e.code}: ${e.message}`);
    else if (line && String(e.loc?.line) !== line) failures.push(`${name}\n    expected ${code} on line ${line}, got line ${e.loc?.line}`);
    else passed++;
  }
}

if (failures.length) {
  console.log(failures.map((f) => `✘ ${f}`).join("\n"));
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✔ All ${passed} conformance cases passed`);
