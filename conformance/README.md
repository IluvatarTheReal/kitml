# Kitml conformance suite

These cases define what a correct Kitml engine does. Any implementation, in any
language, should pass all of them. The cases are plain files, so a runner in
another language only needs to read folders and compare JSON.

## Layout

```
conformance/
├── valid/<case>/
│   ├── input.kitml        entry file (other .kitml files may sit beside it)
│   ├── options.json       optional load options
│   └── expected.json      the realm exported as JSON
└── invalid/<case>/
    ├── input.kitml
    ├── options.json       optional
    └── expected-error     first line: the error code; optional "line: N"
```

## options.json

| Key | Meaning | Default |
| --- | --- | --- |
| `at` | Moment to evaluate time windows and `today` (Kitml date or timestamp) | `2026-10-22T12:00:00Z` |
| `circles` | Circles to activate, by name | `[]` |
| `strict` | Fail on plain text inside `sealed to` blocks (K-701) | `false` |
| `mode` | `"load"` checks at `at` only; `"check"` also checks every future time-window boundary | `"load"` |
| `entry` | Entry file name | `input.kitml` |

## expected.json

The realm as exported by `kitml to json` (sealed values hidden):

- Each soul is an object keyed by its ID, with `"$is"` naming its covenant.
- Plain numbers are JSON numbers; quantities are `{"value": 250, "unit": "g"}`;
  fractions add `"fraction": "1/250"`.
- Links are `{"$link": "id"}`; sealed fields are `{"$sealed": ["key", ...]}`.
- Dates, timestamps and symbols are strings; `void` is `null`.
- Numbers are rounded to 12 significant digits to remove floating-point noise.
- Key order does not matter; list order does.

## Running

```
npm test                      # run every case
npx vitest run -t k501        # only cases whose name contains "k501"
npm run test:watch            # re-run on every change
```
