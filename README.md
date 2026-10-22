# Kitml reference engine

TypeScript reference implementation of **Kitml 1**, a data language with typed
records, verified links, units, layered overrides, expiring values and sealed
fields. It contains a library (`load`, `check`), the `kit` command-line tool,
and the language-neutral conformance suite.

Engine version 0.1.0 · Node.js 18 or later · no runtime dependencies.

## Install and build

```
npm install
npm run build
npm test            # runs the conformance suite (81 cases)
```

Use the CLI with `node dist/bin/kit.js …`, or `npm link` to get a `kit` command.

## Command line

```
kit check camera.kit                         # types, units, links, bonds, every future window
kit show camera.kit main-camera --circle night
kit show camera.kit main-camera.exposure --circle night
kit origin camera.kit main-camera.settings.iso --circle night
kit links-to web-service/main.kit platform-team
kit timeline store.kit studio-headphones
kit to json store.kit --at 2026-11-28 --circle canada
kit errors                                   # list every error code
```

Options: `--circle <name>` (repeatable or comma-separated), `--at <date>`,
`--strict`, `--reveal`, `--fields a,b`, `--all`, `--allow-outside`.

Exit codes: `0` success, `1` a Kitml error (printed with code, file, line and a
hint), `2` a usage error.

## Library

```ts
import { load, check, KitError } from "kitml";

const realm = load("config/main.kit", {
  circles: ["production"],   // layers to apply
  at: "2026-11-28",          // moment for time windows (default: now)
});

const api = realm.get("orders-api")!;
api.replicas;                       // 6
api.database.host;                  // links are followed: "orders-db.prod.internal"
String(api.memory);                 // "2000 MB" (a Quantity)
api.memory.to("GiB").value;         // 1.86…

realm.origin("orders-api.replicas");  // which circle, file and line set it
realm.linksTo("orders-db");           // [{ from: "orders-api.database", to: "orders-db" }]
realm.timeline("orders-api");         // upcoming window starts and ends
realm.all("Service");                 // every soul of a covenant (or one extending it)
realm.toJSON();                       // plain JSON, sealed values hidden

check("config/main.kit");             // load() plus a re-check at every future window boundary
```

`loadText(text, { filename })` loads from a string. Errors are thrown as
`KitError` with `code`, `title`, `message`, `loc` and `hint`; `err.format()`
gives the same report as the CLI.

## How it works

| Stage | File | Job |
| --- | --- | --- |
| Lexer | `src/lexer.ts` | Logical lines: comments removed, multi-line lists and `"""` text joined, tabs and odd indents rejected |
| Parser | `src/parser.ts`, `src/literal.ts`, `src/types.ts` | Covenants, souls, circles, units, keys, possession, values and type rules |
| Resolver | `src/resolver.ts` | Loads possessed files, applies time windows and circles in order, enforces bonds, records provenance |
| Checker | `src/checker.ts` | Covenant types and rules, unit conversion, links, uniqueness, computed fields, `require` rules |
| Expressions | `src/expr.ts` | The language of `invoke` and `require`: unit math, links, `all()`, `where`, aggregates |
| Units | `src/units.ts` | Unit families, conversion, currencies, custom units |
| Realm | `src/realm.ts` | The loaded result and its API |
| CLI | `bin/kit.ts` | The `kit` command |

## What engine 0.1 does not do yet

- **Encryption.** `sealed to` blocks are parsed, key names are checked, and
  ciphertext (`sealed "kv1:..."`) loads as a `Sealed` marker. Plain values in
  sealed blocks load normally, are hidden in CLI and JSON output unless
  `--reveal`, and fail `--strict`. `kit seal` and `kit reseal` are not available,
  and K-702 (Tampered Seal) is never raised.
- `kit fmt` and `kit to yaml`.

## Additions to the specification

Writing the engine surfaced a few gaps in the language document. The engine
uses these, and the spec should list them:

| Code | Name | When |
| --- | --- | --- |
| K-105 | Unreadable Line | A line that does not match any Kitml statement |
| K-208 | Twin Covenants | Two covenants with the same name |
| K-704 | Unknown Key | `sealed to` names a key that was never declared |

- A `volume` unit family: `ml`, `cl`, `l`, `m3`, `floz`, `gal`.
- An unresolved bare word in an expression is a symbol, so `if cpus > 16 then large else small` works without quotes.
- In a computed field, a plain number takes the declared unit: `invoke discount : number % = … * 100`.
- A covenant that extends another may not make a required field optional (K-203).
- Same-named circles in different files are merged when they share a number.
