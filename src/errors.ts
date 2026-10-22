import * as path from "path";

/** A position in a source file (1-based line and column). */
export interface Loc {
  file: string;
  line: number;
  col: number;
}

/** Every error code the engine can raise, with its spec name. */
export const ERROR_NAMES: Record<string, string> = {
  "K-001": "Missing Summoning",
  "K-002": "Tabs Are Heresy",
  "K-003": "Crooked Indentation",
  "K-101": "Unsealed Block",
  "K-102": "Unclosed Text",
  "K-103": "Duplicate Field",
  "K-104": "Leading Zero",
  "K-105": "Unreadable Line",
  "K-201": "Unknown Covenant",
  "K-202": "Missing Field",
  "K-203": "Type Mismatch",
  "K-204": "Out of Range",
  "K-205": "Pattern Mismatch",
  "K-206": "Unknown Field",
  "K-207": "Requirement Failed",
  "K-208": "Twin Covenants",
  "K-301": "Unknown Unit",
  "K-302": "Unit Mismatch",
  "K-401": "Twin Souls",
  "K-402": "Dangling Link",
  "K-403": "Wrong Link Type",
  "K-404": "Not Unique",
  "K-501": "Broken Bond",
  "K-502": "Missing Bond",
  "K-601": "Circle Conflict",
  "K-602": "Unknown Circle",
  "K-603": "Overlapping Windows",
  "K-701": "Exposed Secret",
  "K-702": "Tampered Seal",
  "K-703": "Unsealed Field",
  "K-704": "Unknown Key",
  "K-801": "Invocation Cycle",
  "K-802": "Possession Loop",
  "K-803": "Lost File",
};

const DEFAULT_HINTS: Record<string, string> = {
  "K-001": "The first line of every Kitml file must be: summon kitml 1",
  "K-002": "Indent with 2 spaces per level. Tabs are not allowed.",
  "K-003": "Indent with exactly 2 spaces per nesting level.",
  "K-101": "Close covenant, soul, circle and unit blocks with `seal` at the same indentation.",
  "K-104": "Numbers cannot start with 0. If this is text (a postcode, an ID), put it in double quotes.",
  "K-206": "Check the spelling, or add `open` after the covenant name to allow extra fields.",
  "K-501": "Bound values are permanent. Remove the override, or remove `bound` from the original.",
  "K-601": "Circles with the same number are alternatives. Activate only one, or give one a higher number.",
  "K-701": "Encrypt the block with `kit seal` before committing (encryption is not available in engine 0.1).",
};

export class KitError extends Error {
  readonly code: string;
  readonly loc?: Loc;
  readonly hint?: string;

  constructor(code: string, message: string, loc?: Loc, hint?: string) {
    super(message);
    this.name = "KitError";
    this.code = code;
    this.loc = loc;
    this.hint = hint ?? DEFAULT_HINTS[code];
  }

  /** The spec name of this error, e.g. "Broken Bond". */
  get title(): string {
    return ERROR_NAMES[this.code] ?? "Error";
  }

  /** Multi-line, human-readable report. */
  format(cwd: string = process.cwd()): string {
    let where = "";
    if (this.loc) {
      const rel = path.relative(cwd, this.loc.file) || this.loc.file;
      where = `  at ${rel}:${this.loc.line}:${this.loc.col}`;
    }
    const lines = [`${this.code} ${this.title}${where}`, `  ${this.message}`];
    if (this.hint) lines.push(`  Hint: ${this.hint}`);
    return lines.join("\n");
  }
}

export function fail(code: string, message: string, loc?: Loc, hint?: string): never {
  throw new KitError(code, message, loc, hint);
}
