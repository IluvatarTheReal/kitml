import { fail } from "./errors";

/** One logical line: comments removed, multi-line lists and long text joined. */
export interface LLine {
  indent: number;
  text: string;
  line: number;
  col: number;
  file: string;
}

interface Scan {
  code: string;
  balance: number;
  openString: boolean;
}

/** Removes a trailing `--` comment and measures bracket balance, ignoring text inside quotes. */
function scan(s: string): Scan {
  let inStr = false;
  let balance = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "-" && s[i + 1] === "-") return { code: s.slice(0, i).trimEnd(), balance, openString: false };
    else if (c === "[" || c === "{" || c === "(") balance++;
    else if (c === "]" || c === "}" || c === ")") balance--;
  }
  return { code: s.trimEnd(), balance, openString: inStr };
}

export function quoteText(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

function dedent(lines: string[]): string {
  const widths = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const cut = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

export function toLines(src: string, file: string): LLine[] {
  const raw = src.replace(/\r\n?/g, "\n").split("\n");
  if (raw.length && raw[0].charCodeAt(0) === 0xfeff) raw[0] = raw[0].slice(1);
  const out: LLine[] = [];
  let i = 0;
  while (i < raw.length) {
    const lineNo = i + 1;
    const r = raw[i];
    const ws = /^[ \t]*/.exec(r)![0];
    if (ws.includes("\t")) fail("K-002", "Tab character in indentation", { file, line: lineNo, col: ws.indexOf("\t") + 1 });
    const trimmed = r.slice(ws.length);

    // Block comments: --[ ... ]--
    if (trimmed.startsWith("--[")) {
      if (!trimmed.slice(3).includes("]--")) {
        i++;
        while (i < raw.length && !raw[i].includes("]--")) i++;
        if (i >= raw.length) fail("K-105", "Block comment `--[` is never closed with `]--`", { file, line: lineNo, col: ws.length + 1 });
      }
      i++;
      continue;
    }

    let { code, balance, openString } = scan(trimmed);

    // Long text: a value that opens with """ and closes on a later line.
    const tq = code.indexOf('"""');
    if (tq >= 0) {
      const rest = code.slice(tq + 3);
      const close = rest.indexOf('"""');
      if (close >= 0) {
        code = code.slice(0, tq) + quoteText(rest.slice(0, close)) + rest.slice(close + 3);
      } else {
        if (rest.trim()) fail("K-105", 'Long text must start on the line after `"""`', { file, line: lineNo, col: ws.length + tq + 1 });
        const body: string[] = [];
        i++;
        while (i < raw.length && !raw[i].trim().startsWith('"""')) body.push(raw[i++]);
        if (i >= raw.length) fail("K-102", 'Long text opened with """ is never closed', { file, line: lineNo, col: ws.length + tq + 1 });
        code = code.slice(0, tq) + quoteText(dedent(body));
      }
      openString = false;
      balance = scan(code).balance;
    }

    if (openString) fail("K-102", "Text is missing its closing quote", { file, line: lineNo, col: ws.length + 1 });

    // Lists and groups may span several lines until their brackets balance.
    while (balance > 0) {
      i++;
      if (i >= raw.length) fail("K-105", "Bracket opened here is never closed", { file, line: lineNo, col: ws.length + 1 });
      const more = scan(raw[i].trim());
      if (more.openString) fail("K-102", "Text is missing its closing quote", { file, line: i + 1, col: 1 });
      code += (code.endsWith("[") || code.endsWith("{") || more.code.startsWith("]") || more.code.startsWith("}") ? "" : " ") + more.code;
      balance += more.balance;
    }

    if (code.length > 0) {
      if (ws.length % 2 !== 0) fail("K-003", `Indentation of ${ws.length} spaces is not a multiple of 2`, { file, line: lineNo, col: 1 });
      out.push({ indent: ws.length, text: code, line: lineNo, col: ws.length + 1, file });
    }
    i++;
  }
  return out;
}
