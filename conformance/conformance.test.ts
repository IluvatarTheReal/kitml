/**
 * Runs the Kitml conformance suite against this engine.
 * Usage: npx vitest run conformance [-t filter]
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import { check, KitmlError, load, LoadOptions } from "../src/index";

const ROOT = __dirname;
const DEFAULT_AT = "2026-10-22T12:00:00Z";

interface CaseOptions extends LoadOptions {
  mode?: "load" | "check";
  entry?: string;
}

function options(dir: string): CaseOptions {
  const f = path.join(dir, "options.json");
  const o: CaseOptions = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  return { at: DEFAULT_AT, ...o };
}

function runCase(dir: string): Record<string, unknown> {
  const o = options(dir);
  const entry = path.join(dir, o.entry ?? "input.kitml");
  return o.mode === "check" ? check(entry, o).realm.toJSON() : load(entry, o).toJSON();
}

function cases(kind: string): [string, string][] {
  const base = path.join(ROOT, kind);
  return fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort().map((d) => [d, path.join(base, d)]);
}

function describeError(e: unknown): string {
  return e instanceof KitmlError ? e.format() : String((e as Error).stack ?? e);
}

describe("valid", () => {
  test.each(cases("valid"))("%s", (_, dir) => {
    let actual: Record<string, unknown>;
    try {
      actual = runCase(dir);
    } catch (e) {
      throw new Error(`unexpected error: ${describeError(e)}`);
    }
    const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
    expect(actual).toEqual(expected);
  });
});

describe("invalid", () => {
  test.each(cases("invalid"))("%s", (_, dir) => {
    const spec = fs.readFileSync(path.join(dir, "expected-error"), "utf8").trim().split("\n");
    const code = spec[0].trim();
    const line = spec.find((l) => l.startsWith("line:"))?.slice(5).trim();
    let error: unknown;
    try {
      runCase(dir);
    } catch (e) {
      error = e;
    }
    if (error === undefined) throw new Error(`expected ${code}, but the realm loaded without errors`);
    if (!(error instanceof KitmlError)) throw new Error(`expected ${code}, got a crash: ${describeError(error)}`);
    expect(error.code, error.message).toBe(code);
    if (line) expect(String(error.loc?.line), `line of ${code}`).toBe(line);
  });
});
