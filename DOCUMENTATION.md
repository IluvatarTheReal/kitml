# Kitml Language Reference

Oct 22, 2026 · @FieryImp

## Introduction

Kitml is a data language whose records have identity, types, layers, lifetimes and secrets built in. Where YAML and JSON describe a tree of values, Kitml describes a **realm**: a set of typed records (souls) that link to each other, can be layered for different environments, can expire, and can hide fields from unauthorised readers.

The keywords come from infernal lore (a deal is binding, a true name grants power, the underworld has circles), and each one names a real rule the loader enforces. Files use the `.kitml` extension and the media type `application/kitml`, and are always UTF-8. This is version 1 of the specification.

### Six core ideas

1. **Covenants (types).** Every record declares its type. Fields have types, ranges and units, and the loader rejects anything that breaks them.
2. **Souls (identity and links).** Every record has a unique ID. Other records link to it with `->`, and the loader verifies the link exists and has the right type.
3. **Bound values (immutability).** A `bound` field is fixed for good. Any layer that tries to change it is an error.
4. **Circles (layers).** Overrides live in numbered layers such as `dev`, `prod` or `night-shoot`. You choose which to apply when loading, and the loader reports where every value came from.
5. **Time windows (lifetimes).** `from` and `until` make values start or expire on a date, without application code.
6. **Sealed fields (secrets).** `sealed to` encrypts fields so only readers holding the right key can see them. The rest of the file stays shareable.

Units (`35 mm`, `30 s`, `4 GB`, `19.99 USD`) are part of the value, and computed fields and multi-file realms round it out.

### Keywords

| Keyword | What it does |
| --- | --- |
| `summon` | First line of every file: `summon kitml 1` |
| `covenant` … `seal` | Declares a type |
| `soul` … `is` … `seal` | Declares a record with an ID and a type |
| `->` | Links to another soul by ID |
| `bound` | Makes a value permanent |
| `circle` | Opens a layer of overrides |
| `from` / `until` | Opens a time window |
| `sealed to` | Opens a block of encrypted fields for a named key |
| `invoke` | Declares a computed field |
| `possess` | Pulls another file into the realm |
| `banish` | Removes a value inside a circle |

### Kitml beside YAML and JSON

| Capability | JSON | YAML | Kitml |
| --- | --- | --- | --- |
| Comments | No | Yes | Yes |
| Types in the file | No | Tags only | Covenants, checked on load |
| Units | No | No | Built in, converted and checked |
| References | No | Anchors (copies) | Typed links between records, verified |
| Environment overrides | No | No | Circles, with value provenance |
| Immutable fields | No | No | `bound` |
| Expiring values | No | No | `from` / `until` |
| Encrypted fields | No | No | `sealed to` |
| Computed values | No | No | `invoke` |
| Plain text needs quotes | Yes | No | Yes, so `no` and `3.10` never change meaning |

## Quick start

A Kitml file declares its types, then its records. Save this as `library.kitml`:

```kitml
summon kitml 1

-- Types
covenant Author
  name    : text
  born    : date optional
seal

covenant Book
  bound isbn : text matching "^97[89][0-9]{10}$"
  title      : text
  author     : -> Author
  pages      : number between 1 and 5000
  weight     : number g
  genres     : list of text
seal

-- Records
soul le-guin is Author
  name = "Ursula K. Le Guin"
  born = 1929-10-21
seal

soul earthsea is Book
  bound isbn = "9780547773742"
  title      = "A Wizard of Earthsea"
  author    -> le-guin
  pages      = 183
  weight     = 0.25 kg       -- converted to 250 g
  genres     = ["fantasy", "coming of age"]
seal
```

Check and read it:

```text
kitml check library.kitml          # validates types, links and units
kitml show library.kitml earthsea  # prints one soul, links resolved
kitml to json library.kitml        # exports plain JSON
```

The JSON export, with links written as IDs and quantities in the covenant's unit:

```json
{
  "le-guin": { "$is": "Author", "name": "Ursula K. Le Guin", "born": "1929-10-21" },
  "earthsea": {
    "$is": "Book",
    "isbn": "9780547773742",
    "title": "A Wizard of Earthsea",
    "author": { "$link": "le-guin" },
    "pages": 183,
    "weight": { "value": 250, "unit": "g" },
    "genres": ["fantasy", "coming of age"]
  }
}
```

In code, links are followed like ordinary fields:

```python
import kitml

realm = kitml.load("library.kitml")
book = realm["earthsea"]
print(book.author.name)       # Ursula K. Le Guin
print(book.weight.to("oz"))   # 8.82 oz
realm.links_to("le-guin")     # [earthsea]
```

If `pages` were `0`, `author` pointed to a missing soul, or `weight` were `250 ml`, `kitml check` would stop with an error naming the line.

## Syntax basics

A file is a summoning line followed by top-level blocks: `covenant`, `unit`, `soul`, `circle` and `possess` lines. The `covenant`, `unit`, `soul` and `circle` blocks end with `seal`; everything nested inside a block is indented 2 spaces per level.

### Summoning line and comments

```kitml
summon kitml 1

-- A line comment runs to the end of the line
port = 8080   -- comments can follow a value

--[
  A block comment
  spans several lines.
]--
```

A file without the summoning line is error K-001. Tabs in indentation are error K-002.

### Fields

Inside a soul, each line sets one field: `name = value`, or `name -> id` for a link. Spaces around `=` and `->` are free, so columns can be aligned. Field names use letters, digits, `-` and `_`, start with a letter, and are case-sensitive.

### Values

| Kind | Examples | Notes |
| --- | --- | --- |
| Text | `"Hello"`, `"Line\nbreak"` | Always double-quoted. Escapes: `\n \t \" \\ \u{00E9}` |
| Long text | `"""` … `"""` | Keeps line breaks; common indentation is stripped |
| Number | `42`, `-7`, `3.14`, `1_000_000`, `0xFF` | Unquoted digits are always numbers |
| Quantity | `35 mm`, `4 GB`, `19.99 USD`, `5600 K` | A number, a space, a unit |
| Fraction | `1/125 s`, `3/4` | Kept exact, not rounded to a float |
| Boolean | `true`, `false` | Nothing else is a boolean |
| Empty | `void` | Null |
| Date | `2026-10-22` | ISO 8601 |
| Timestamp | `2026-10-22T14:30:00-04:00` | ISO 8601 with offset or `Z` |
| Symbol | `RF`, `prod`, `landscape` | A bare word; used for fixed choices (`one of`) |
| List | `["a", "b"]`, `[1, 2, 3]` | May span lines; trailing comma allowed |
| Group | `{ width: 36 mm, height: 24 mm }` | Inline record without its own identity |
| Link | `-> canon-r5`, `-> [lens-35, lens-85]` | Points to one soul or a list of souls |

Because text is always quoted, `no`, `on`, `3.10` and `0123` never change type by accident: unquoted they are a symbol, a symbol, a number and an error (K-104, leading zero).

### Nested groups

A field name alone on a line opens a nested group; its fields are indented below it.

```kitml
soul office-printer is Printer
  model = "LaserJet 400"
  network
    ip       = "10.0.4.21"
    hostname = "printer-3f"
    dhcp     = false
seal
```

This is equivalent to `network = { ip: "10.0.4.21", hostname: "printer-3f", dhcp: false }`. Nested fields are addressed with dots: `office-printer.network.ip`.

### Units

A quantity's unit must belong to the family its covenant expects, and the loader converts it to the covenant's unit.

| Family | Units |
| --- | --- |
| Length | `mm`, `cm`, `m`, `km`, `in`, `ft`, `mi` |
| Volume | ml, cl, l, m3, floz, gal |
| Mass | `mg`, `g`, `kg`, `oz`, `lb` |
| Time | `ms`, `s`, `min`, `h`, `d`, `w` |
| Data | `B`, `KB`, `MB`, `GB`, `TB` (powers of 1000) and `KiB`, `MiB`, `GiB`, `TiB` (powers of 1024) |
| Temperature | `C`, `F`, `K` |
| Frequency | `Hz`, `kHz`, `MHz`, `GHz` |
| Image | `px`, `MP` (megapixels) |
| Ratio | `%` |
| Money | Any ISO 4217 code: `USD`, `CAD`, `EUR`, `JPY` |

Money is never converted automatically, since exchange rates change: `19.99 USD` where `CAD` is expected is error K-302. A covenant field typed `number money` accepts any currency, and `currency(x)` returns a value's currency code. Projects can add units with `unit` declarations (see Covenants).

## Covenants (types)

A covenant lists the fields a soul of that type may have, each with a type and optional rules. Every soul names its covenant with `is`, and the loader checks it on every load, after all circles and time windows are applied.

```kitml
covenant Server
  bound hostname : text matching "^[a-z0-9-]+$"
  region         : one of [us-east, eu-west, ap-south]
  cpus           : number whole between 1 and 256
  memory         : number GB
  disk           : number GB default 50 GB
  timeout        : number s between 1 s and 5 min
  tags           : list of text optional
  owner          : -> Team
seal
```

### Field types

| Type | Accepts |
| --- | --- |
| `text` | Quoted text |
| `number` | A plain number |
| `number <unit>` | A quantity in that unit's family, converted to that unit |
| `fraction <unit>` | A fraction or number in that unit's family, kept exact |
| `bool` | `true` or `false` |
| `date` / `timestamp` | ISO 8601 dates and timestamps |
| `one of [a, b, c]` | One of the listed symbols |
| `list of <type>` | A list whose items all have that type |
| `-> <Covenant>` | A link to a soul of that covenant |
| `list of -> <Covenant>` | A list of links |
| `<Covenant>` | A nested group checked against that covenant |
| `{ field: type, … }` | An inline group shape |
| `any` | Anything (use sparingly) |

### Field rules

Rules follow the type, in any order.

| Rule | Meaning |
| --- | --- |
| `optional` | The field may be absent (fields are required by default) |
| `default <value>` | Value used when the field is absent; implies optional |
| `between <a> and <b>` | Inclusive range; units allowed and converted |
| `whole` | The number must be an integer |
| `matching "<regex>"` | Text must match the regular expression |
| `length between <a> and <b>` | Length bounds for text or lists |
| `unique` | No two souls of this covenant may share the value |
| `bound` (as a prefix) | Every soul must bind this field (see Bound values) |
| `sealed` (as a prefix) | Every soul must keep this field inside a `sealed to` block |

A soul with a field its covenant does not list is error K-206, so typos like `memroy` are caught. Add `open` after the covenant name (`covenant Server open`) to allow extra fields.

### Inheritance

A covenant can extend another; it gets every parent field and may add or tighten rules, but not loosen them.

```kitml
covenant Device
  bound serial : text unique
  model        : text
  purchased    : date
seal

covenant Laptop extends Device
  screen  : number in between 11 in and 18 in
  memory  : number GB
  battery : number h
seal
```

A link typed `-> Device` accepts any `Laptop` soul too.

### Custom units

```kitml
unit frame-rate family rate
  fps = 1
seal

unit storage family data
  floppy = 1.44 MB
seal
```

A `unit` block either starts a new family (`frame-rate`) or adds a unit to an existing one (`data`), defined in terms of that family's base unit.

### Cross-field rules

A `require` line states a condition that must hold for every soul of the covenant, using the same expressions as invocations. Its text is the error message.

```kitml
covenant Booking
  check-in  : date
  check-out : date
  guests    : number whole between 1 and 8
  room      : -> Room
  require check-out > check-in      "Check-out must be after check-in"
  require guests <= room.capacity   "Too many guests for this room"
seal
```

A failed `require` is K-207 and prints the message with the soul's ID.

## Souls and links

A soul is a record with a unique ID and a covenant. Other souls point to it with `->`, and the loader guarantees every link lands on an existing soul of the right type.

```kitml
soul platform-team is Team
  name  = "Platform"
  email = "platform@example.com"
seal

soul api-1 is Server
  bound hostname = "api-1"
  region   = us-east
  cpus     = 8
  memory   = 32 GB
  timeout  = 30 s
  owner   -> platform-team
seal
```

### IDs

- Soul IDs use lowercase letters, digits and `-`, and start with a letter: `api-1`, `canon-r5`.
- IDs are unique across the whole realm, including possessed files. A repeated ID is K-401 (Twin Souls).
- An ID is not a field and never changes when a soul moves to another file, so links survive refactoring.

### Links

| Form | Meaning |
| --- | --- |
| `owner -> platform-team` | Link to one soul |
| `replicas -> [api-2, api-3]` | List of links |
| `owner = void` | No link (field must be `optional`) |

A link to a missing ID is K-402 (Dangling Link). A link to a soul of the wrong covenant is K-403. Links may form cycles (two people can be each other's emergency contact); the loader handles them.

### Following links

Paths follow links with dots, both in tools and in invocations: `api-1.owner.email` is `"platform@example.com"`. In code, a link loads as the target soul itself:

```python
realm["api-1"].owner.email     # "platform@example.com"
```

### Back-links

The loader indexes every link in both directions, so you can ask what points at a soul without scanning:

```text
$ kitml links-to fleet.kitml platform-team
api-1.owner      -> platform-team
api-2.owner      -> platform-team
db-main.owner    -> platform-team
```

In code: `realm.links_to("platform-team")`. Before deleting a soul, this shows exactly what would break.

## Bound values

A field written with `bound` can never be changed by a circle, a time window, a possessed file or a computed field. Use it for identifiers and invariants: serial numbers, account IDs, the production database name.

```kitml
soul payments-db is Database
  bound name    = "payments"
  bound engine  = postgres
  version       = "16.4"
  max-connections = 200
seal

circle 3 staging
  payments-db.max-connections = 20      -- fine
  payments-db.name = "payments-test"    -- error K-501
seal
```

```text
K-501 Broken Bond  at fleet.kitml:12:3
  payments-db.name is bound at fleet.kitml:2:3 and cannot be changed by circle 3 (staging).
```

### Rules

- `bound` applies to the field and everything nested under it. Binding a group binds all its fields.
- `banish` on a bound field is also K-501.
- A covenant can require binding: `bound serial : text` in the covenant means every soul must write `bound serial = …`, or K-502 (Missing Bond).
- A bound link (`bound owner -> platform-team`) fixes which soul is linked; the linked soul's own fields can still change unless they are bound too.

## Circles (layers)

A circle is a named, numbered layer of changes applied on top of the base data. You pick which circles are active when you load, so one file can describe development, staging and production, or a camera's daytime and night presets, without copying anything. The loader remembers which circle set every value.

```kitml
soul web is Service
  replicas  = 1
  log-level = debug
  memory    = 512 MB
  domain    = "localhost"
seal

circle 1 staging
  web.replicas  = 2
  web.domain    = "staging.example.com"
seal

circle 1 production
  web.replicas  = 6
  web.log-level = warn
  web.memory    = 2 GB
  web.domain    = "example.com"
seal

circle 2 black-friday
  web.replicas  = 20
seal
```

Loading with `--circle production --circle black-friday` gives 20 replicas, `warn` logging, 2 GB of memory and `example.com`.

### How circles apply

1. The base data (everything outside circles) is circle 0.
2. Active circles apply in ascending number: 1, then 2, up to 9. A higher circle wins.
3. Two active circles with the same number may not change the same field: that is K-601 (Circle Conflict). Same-number circles are meant to be alternatives, like `staging` and `production`.
4. A circle marked `always` (`circle 1 defaults always`) applies on every load.
5. Covenants are checked after all active circles apply, so a circle cannot leave a soul invalid.
6. Asking for a circle that does not exist is K-602, so a typo like `prodution` fails loudly.

### What a circle can contain

| Line | Effect |
| --- | --- |
| `web.replicas = 6` | Set a field (by path) |
| `web.cache -> redis-prod` | Change a link |
| `web.tags += ["canary"]` | Append to a list |
| `banish web.debug-port` | Remove an optional field |
| `soul ... seal` | Add a soul that exists only while this circle is active |

### Provenance

Every loaded value knows where it came from.

```text
$ kitml origin service.kitml web.replicas --circle production --circle black-friday
web.replicas = 20
  circle 2 black-friday   service.kitml:22   20   (active, wins)
  circle 1 production     service.kitml:14   6    (overridden)
  circle 0 base           service.kitml:2    1    (overridden)
```

In code: `realm.origin("web.replicas")`. This answers "why is this value what it is?" without reading every file.

## Time windows

A `from` or `until` block makes its fields apply only during a period. Sale prices, promotions, certificates, scheduled role changes and temporary feature flags switch on and off by themselves, and nobody has to remember to edit the file.

```kitml
soul headphones is Product
  name  = "Studio Headphones"
  price = 149.99 USD
  from 2026-11-27 until 2026-12-01
    price = 99.99 USD
    badge = "Black Friday"
  until 2027-03-31
    free-shipping = true
seal
```

Loaded on 2026-11-28, the price is 99.99 USD with the badge and free shipping. On 2026-12-15 it is 149.99 USD with free shipping. From 2027-03-31 on, `free-shipping` is gone.

### Rules

- `from` is inclusive and `until` is exclusive. A date means midnight in the file's time zone (`summon kitml 1 zone America/Toronto`, default UTC); a timestamp is exact.
- Inside its window, a field overrides the same field outside it. Outside its window, the outer value applies, or the field is absent if there is none.
- Two windows that overlap and set the same field are K-603 (Overlapping Windows).
- Circles can hold windows, but windows cannot hold circles. A window inside `circle 1 production` only applies when that circle is active.
- Windows cannot change `bound` fields (K-501).

### Choosing the moment

The loader evaluates windows at the current time unless told otherwise, so you can preview the future or replay the past:

```text
kitml show store.kitml headphones --at 2026-11-28
```

```python
realm = kitml.load("store.kitml", at="2026-11-28")
```

### Checking every future

A soul can be valid today and invalid next month, for example when a required field only exists inside a window that expires. `kitml check` therefore checks every soul at every window boundary, not only at the current time:

```text
K-202 Missing Field  at hr.kitml:9:3
  employee-42.badge-id is required but disappears on 2027-01-01 (until window ends).
```

`kitml timeline store.kitml headphones` lists every upcoming change for a soul in date order.

## Sealed fields

A `sealed to` block encrypts its fields for one or more named keys. The file can live in a public repository or be emailed around: anyone can read the open fields, and only holders of the right private key can read the sealed ones.

### Declaring keys

Keys are declared at the top level with their public half. The private half never goes in the file.

```kitml
key ops     = "kpub1q8f3x9...n2d"
key finance = "kpub1z7k2m4...p0a"
```

### Writing sealed fields

Write sealed values in plain text while editing, then run `kitml seal` to encrypt them in place.

```kitml
soul payments-db is Database
  bound name = "payments"
  host       = "db.internal"
  port       = 5432
  sealed to ops
    user     = "svc_payments"
    password = "correct-horse-battery"
  sealed to [ops, finance]
    monthly-cost = 1840 USD
seal
```

After `kitml seal fleet.kitml`:

```kitml
  sealed to ops
    user     = sealed "kv1:9c2e7a...41f"
    password = sealed "kv1:b03d18...7e2"
  sealed to [ops, finance]
    monthly-cost = sealed "kv1:5e88c0...a19"
```

Field names stay visible, so diffs and reviews still show what changed; only the values are hidden. Types are checked before encryption and again after decryption.

### Reading sealed fields

```python
realm = kitml.load("fleet.kitml", keys={"ops": "~/.kitml/ops.key"})
realm["payments-db"].password      # "correct-horse-battery"

realm = kitml.load("fleet.kitml")     # no keys
realm["payments-db"].password      # Sealed(to=["ops"])
realm["payments-db"].port          # 5432, open fields still work
```

Without the key, a sealed field loads as a `Sealed` marker rather than failing, and JSON export writes `{"$sealed": ["ops"]}`. Tools never print decrypted values unless run with `--reveal`.

### Safety checks

- `kitml check --strict` fails with K-701 (Exposed Secret) if any `sealed to` block still holds plain text. Run it in CI or a pre-commit hook.
- A modified or corrupted ciphertext is K-702 (Tampered Seal).
- A covenant field marked `sealed` (for example `sealed password : text`) must sit inside a `sealed to` block in every soul, or K-703.
- `kitml reseal fleet.kitml --add-key auditor` re-encrypts blocks for a new key; removing a key requires rotating the secrets themselves.

## Invocations and possession

Invocations are computed fields; possession splits a realm across files. Both keep data in one place: a value is stated once and derived or shared everywhere else.

### Invocations (computed fields)

`invoke name = expression` defines a field computed from other fields. It is evaluated when read, after circles and time windows, so it always reflects the active layers and the current date.

```kitml
soul api-1 is Server
  bound hostname = "api-1"
  region   = us-east
  cpus     = 8
  memory   = 32 GB
  invoke memory-per-cpu = memory / cpus             -- 4 GB
  invoke fqdn = "{hostname}.{region}.example.com"    -- "api-1.us-east.example.com"
seal

soul fleet-summary is Report
  invoke total-memory = sum(all(Server).memory)
  invoke big-servers  = count(all(Server) where cpus >= 16)
seal
```

A covenant can declare an invocation once for every soul of its type:

```kitml
covenant Rectangle
  width  : number cm
  height : number cm
  invoke area : number cm2 = width * height
seal
```

**What expressions can use**

| Kind | Available |
| --- | --- |
| References | Fields of the same soul by name, other souls by path (`api-1.memory`), links (`owner.email`) |
| Arithmetic | `+ - * /` with unit math: `32 GB / 8` is `4 GB`; `100 km / 2 h` is `50 km/h` |
| Comparison and logic | `== != < <= > >=`, `and`, `or`, `not` |
| Choice | `if cpus > 16 then large else small` |
| Text | `"{field}"` interpolation, `upper()`, `lower()`, `length()` |
| Collections | `all(Covenant)`, `where`, `sum()`, `count()`, `min()`, `max()`, `avg()` |
| Numbers and time | `round(x, places)`, `days(date-a, date-b)`, `today` |
| Unit conversion | `memory in MiB` |

Expressions are pure: no file, network or clock access other than `today` (which honours `--at`). Interpolation `{…}` only works inside `invoke`; ordinary text is always literal. Invocations that depend on each other in a loop are K-801 (Invocation Cycle). Adding units that don't match (`4 GB + 3 s`) is K-302.

### Possession (multiple files)

`possess` adds another file's covenants, souls, circles and keys to the realm.

```kitml
summon kitml 1

possess "types.kitml"
possess "teams.kitml"
possess "servers/*.kitml"          -- every matching file, in name order
possess "circles/production.kitml"
```

- Paths are relative to the possessing file. Each possessed file has its own summoning line.
- Everything shares one namespace: a soul in `servers/api.kitml` can link to a team in `teams.kitml` by ID alone.
- Possessing a file twice has no extra effect. A loop of files possessing each other is K-802; a missing file is K-803.
- Paths outside the starting folder are refused unless the loader is given `--allow-outside`.

## Full examples

Three realistic files, each combining several features: a camera rig, a web service across environments, and a store catalog with regional pricing and sales.

### Example 1: Camera rig with shooting presets (`camera.kitml`)

Shows covenants with units, linked lenses, a cross-field rule, a bound serial, circles as presets, an expiring warranty, sealed owner data and a computed label.

```kitml
summon kitml 1 zone America/Toronto

key owner = "kpub1q8f3x9...n2d"

covenant Lens
  bound serial : text unique
  focal-length : number mm between 8 mm and 800 mm
  max-aperture : number between 0.95 and 32
  mount        : one of [RF, EF, E, Z]
seal

covenant Settings
  iso           : number whole between 100 and 51200
  shutter       : fraction s between 1/8000 s and 30 s
  aperture      : number
  white-balance : number K between 2500 K and 10000 K
seal

covenant Camera
  bound serial : text unique
  model        : text
  sensor       : { width: number mm, height: number mm, resolution: number MP }
  mount        : one of [RF, EF, E, Z]
  lens         : -> Lens
  settings     : Settings
  warranty     : text optional
  sealed owner-name : text
  sealed home-gps   : text
  require lens.mount == mount                "Lens does not fit this camera"
  require settings.aperture >= lens.max-aperture  "Aperture wider than the lens allows"
  invoke exposure : text = "{settings.shutter} at f/{settings.aperture}, ISO {settings.iso}"
seal

soul lens-35 is Lens
  bound serial = "L35-20931"
  focal-length = 35 mm
  max-aperture = 1.8
  mount        = RF
seal

soul lens-85 is Lens
  bound serial = "L85-77310"
  focal-length = 85 mm
  max-aperture = 1.2
  mount        = RF
seal

soul main-camera is Camera
  bound serial = "R5-0042-1187"
  model        = "Mirrorless R5"
  sensor       = { width: 36 mm, height: 24 mm, resolution: 45 MP }
  mount        = RF
  lens        -> lens-35
  settings
    iso           = 100
    shutter       = 1/250 s
    aperture      = 5.6
    white-balance = 5600 K
  until 2027-10-22
    warranty = "Manufacturer, 1 year"
  sealed to owner
    owner-name = "Jordan Lee"
    home-gps   = "46.05, -71.96"
seal

circle 1 portrait
  main-camera.lens             -> lens-85
  main-camera.settings.aperture = 1.8
seal

circle 1 night
  main-camera.settings.iso           = 6400
  main-camera.settings.shutter       = 1/30 s
  main-camera.settings.aperture      = 1.8
  main-camera.settings.white-balance = 3200 K
seal
```

```text
$ kitml show camera.kitml main-camera.exposure --circle night
"1/30 s at f/1.8, ISO 6400"

$ kitml show camera.kitml main-camera.exposure --circle portrait
"1/250 s at f/1.8, ISO 100"
```

`portrait` and `night` share number 1, so they are alternatives; activating both fails with K-601 because both set `aperture`. Changing the serial in a circle fails with K-501, and pointing `lens` at an EF lens fails the `require` rule.

### Example 2: Web service across environments

A project split over several files. Shows possession, links across files, bound names, sealed credentials, environment circles, a scheduled certificate change and computed URLs.

```text
config/
├── main.kitml
├── types.kitml
├── teams.kitml
└── circles/
    ├── staging.kitml
    └── production.kitml
```

`types.kitml`:

```kitml
summon kitml 1

covenant Team
  name  : text
  email : text matching "^[^@]+@[^@]+$"
seal

covenant Database
  bound name      : text
  host            : text
  port            : number whole default 5432
  max-connections : number whole between 1 and 1000
  sealed user     : text
  sealed password : text
seal

covenant Service
  bound name : text
  replicas   : number whole between 1 and 100
  memory     : number MB
  timeout    : number s default 30 s
  log-level  : one of [debug, info, warn, error]
  domain     : text
  database   : -> Database
  owner      : -> Team
  cert       : text
  invoke url : text = "https://{domain}"
  require memory >= 256 MB "Each replica needs at least 256 MB"
seal
```

`main.kitml`:

```kitml
summon kitml 1

possess "types.kitml"
possess "teams.kitml"
possess "circles/*.kitml"

key ops = "kpub1z7k2m4...p0a"

soul orders-db is Database
  bound name      = "orders"
  host            = "localhost"
  max-connections = 20
  sealed to ops
    user     = sealed "kv1:7aa1f0...c33"
    password = sealed "kv1:e4c912...0b8"
seal

soul orders-api is Service
  bound name = "orders-api"
  replicas   = 1
  memory     = 512 MB
  log-level  = debug
  domain     = "localhost:8080"
  database  -> orders-db
  owner     -> platform-team       -- defined in teams.kitml
  cert       = "certs/2026.pem"
  from 2026-12-15
    cert     = "certs/2027.pem"    -- new certificate takes over automatically
seal
```

`circles/production.kitml`:

```kitml
summon kitml 1

circle 1 production
  orders-api.replicas  = 6
  orders-api.memory    = 2 GB
  orders-api.log-level = warn
  orders-api.domain    = "orders.example.com"
  orders-db.host       = "orders-db.prod.internal"
  orders-db.max-connections = 400
seal
```

The application loads it once at startup:

```python
realm = kitml.load("config/main.kitml",
                   circles=[os.environ["APP_ENV"]],
                   keys={"ops": "/run/secrets/ops.key"})
api = realm["orders-api"]
connect(api.database.host, api.database.user, api.database.password)
serve(api.url, replicas=api.replicas, cert=api.cert)
```

With `APP_ENV=production` this connects to `orders-db.prod.internal` and serves `https://orders.example.com`; from 2026-12-15 it picks up the new certificate with no deploy.

### Example 3: Store catalog with regional prices and sales (`store.kitml`)

Shows money units, links to categories and suppliers, sale windows, a regional circle, sealed supplier costs and computed discounts and margins.

```kitml
summon kitml 1 zone America/Toronto

key finance = "kpub1m5t8w2...x7c"

covenant Category
  name : text
seal

covenant Supplier
  name    : text
  country : text length between 2 and 2
seal

covenant Product
  bound sku    : text unique matching "^[A-Z]{3}-[0-9]{4}$"
  name         : text
  category     : -> Category
  supplier     : -> Supplier
  list-price   : number money
  price        : number money
  stock        : number whole default 0
  weight       : number kg
  sealed cost  : number money
  require currency(price) == currency(list-price)  "Prices must share a currency"
  require price <= list-price         "Price above list price"
  invoke discount  : number % = round((list-price - price) / list-price * 100, 0)
  invoke in-stock  : bool = stock > 0
  invoke heavy     : bool = weight > 1 kg
seal

soul audio is Category
  name = "Audio"
seal

soul acme-audio is Supplier
  name    = "Acme Audio Ltd."
  country = "CA"
seal

soul studio-headphones is Product
  bound sku   = "AUD-0142"
  name        = "Studio Headphones"
  category   -> audio
  supplier   -> acme-audio
  list-price  = 149.99 USD
  price       = 149.99 USD
  stock       = 320
  weight      = 280 g
  from 2026-11-27 until 2026-12-01
    price     = 99.99 USD
  sealed to finance
    cost      = sealed "kv1:2b9f44...d10"
seal

circle 1 canada
  studio-headphones.list-price = 199.99 CAD
  studio-headphones.price      = 199.99 CAD
  from 2026-11-27 until 2026-12-01
    studio-headphones.price    = 134.99 CAD
seal
```

```text
$ kitml show store.kitml studio-headphones --at 2026-11-28 --fields price,discount,in-stock
price     = 99.99 USD
discount  = 33 %
in-stock  = true
```

The `canada` circle switches the product to CAD prices with its own sale window. `number money` accepts any currency, but the `require` rule stops one product from mixing USD and CAD, and money is never converted silently. `cost` is readable only by holders of the finance key; everyone else gets `Sealed`.

## Tooling, API, errors and grammar

### The `kitml` command

| Command | Does |
| --- | --- |
| `kitml check main.kitml` | Validates syntax, types, units, links, bonds and every time-window boundary |
| `kitml check main.kitml --strict` | Also fails on unsealed secrets (K-701); use in CI |
| `kitml show main.kitml <path>` | Prints a soul or field with links resolved |
| `kitml origin main.kitml <path>` | Shows which circle, file and line set a value |
| `kitml links-to main.kitml <id>` | Lists every link pointing at a soul |
| `kitml timeline main.kitml <id>` | Lists upcoming time-window changes in date order |
| `kitml seal` / `kitml reseal` | Encrypts sealed blocks / re-encrypts for a changed key list |
| `kitml to json` / `kitml to yaml` | Exports the loaded realm |
| `kitml fmt main.kitml` | Rewrites with aligned columns and standard spacing |

Common flags: `--circle <name>` (repeatable), `--at <date>`, `--key <name>=<file>`, `--reveal`.

### Loading API

The same options exist in every reader. Python:

```python
import kitml

realm = kitml.load(
    "config/main.kitml",
    circles=["production"],          # layers to apply
    at="2026-11-28",                 # moment for time windows (default: now)
    keys={"ops": "/run/secrets/ops.key"},
)

realm["orders-api"].replicas        # 6
realm.origin("orders-api.replicas")  # circle 1 production, circles/production.kitml:4
realm.links_to("orders-db")          # [orders-api]
realm.all("Service")                 # every soul of that covenant
realm.to_json()
```

JavaScript: `kitml.load(path, { circles, at, keys })`, same methods in camelCase.

### Errors

The loader stops at the first error and reports the code, name, file, line and a hint.

| Code | Name | Cause |
| --- | --- | --- |
| K-001 | Missing Summoning | First line is not `summon kitml 1` |
| K-002 | Tabs Are Heresy | Tab character in indentation |
| K-003 | Crooked Indentation | Indent is not a multiple of 2, or skips a level |
| K-101 | Unsealed Block | A `covenant`, `soul`, `circle` or `unit` block has no `seal` |
| K-102 | Unclosed Text | A quote is never closed |
| K-103 | Duplicate Field | The same field is set twice at one level |
| K-104 | Leading Zero | A number like `0123`; quote it if it is text |
| K-105 | Unreadable Line | A line that matches no Kitml statement, such as unquoted text |
| K-201 | Unknown Covenant | `is` names a covenant that doesn't exist |
| K-202 | Missing Field | A required field is absent (now or at a future window boundary) |
| K-203 | Type Mismatch | A value has the wrong type |
| K-204 | Out of Range | A value breaks `between`, `whole` or `length` |
| K-205 | Pattern Mismatch | Text fails its `matching` rule |
| K-206 | Unknown Field | A field the covenant doesn't list (covenant is not `open`) |
| K-207 | Requirement Failed | A `require` rule is false |
| K-208 | Twin Covenants | Two covenants share a name |
| K-301 | Unknown Unit | The unit is not defined |
| K-302 | Unit Mismatch | Wrong unit family, mixed currencies, or adding unlike units |
| K-401 | Twin Souls | Two souls share an ID |
| K-402 | Dangling Link | A link points to a missing soul |
| K-403 | Wrong Link Type | A link points to a soul of the wrong covenant |
| K-404 | Not Unique | Two souls share a `unique` value |
| K-501 | Broken Bond | Something tries to change a `bound` value |
| K-502 | Missing Bond | A field the covenant marks `bound` is not bound |
| K-601 | Circle Conflict | Two active same-number circles set the same field |
| K-602 | Unknown Circle | A requested circle doesn't exist |
| K-603 | Overlapping Windows | Overlapping windows set the same field |
| K-701 | Exposed Secret | A `sealed to` block holds plain text (`--strict`) |
| K-702 | Tampered Seal | Ciphertext fails verification |
| K-703 | Unsealed Field | A covenant field marked `sealed` is outside a sealed block |
| K-704 | Unknown Key | A sealed to block names a key that was never declared |
| K-801 | Invocation Cycle | Computed fields depend on each other in a loop |
| K-802 | Possession Loop | Files possess each other in a loop |
| K-803 | Lost File | A possessed path doesn't exist or is outside the folder |

### Grammar

Simplified EBNF. `IND` and `DED` mark a 2-space step in and out; `NL` is a line end, optionally after a comment.

```text
file       = summon , NL , { top } ;
summon     = "summon kitml " , version , [ " zone " , tz ] ;
top        = covenant | unit | soul | circle | possess | key ;
covenant   = "covenant " , Name , [ " extends " , Name ] , [ " open" ] , NL ,
             IND , { term | require | invoke } , DED , "seal" , NL ;
term       = [ "bound " | "sealed " ] , field , " : " , type , { rule } , NL ;
require    = "require " , expr , [ text ] , NL ;
soul       = "soul " , id , " is " , Name , NL , IND , { line } , DED , "seal" , NL ;
line       = set | link | group | window | sealed | invoke ;
set        = [ "bound " ] , field , "=" , value , NL ;
link       = [ "bound " ] , field , "->" , ( id | "[" , id , { "," , id } , "]" ) , NL ;
group      = field , NL , IND , { line } , DED ;
window     = ( "from " , moment , [ " until " , moment ] | "until " , moment ) , NL ,
             IND , { line } , DED ;
sealed     = "sealed to " , ( keyname | "[" , keyname , { "," , keyname } , "]" ) , NL ,
             IND , { set } , DED ;
invoke     = "invoke " , field , [ " : " , type ] , " = " , expr , NL ;
circle     = "circle " , digit , " " , name , [ " always" ] , NL ,
             IND , { override | soul | window } , DED , "seal" , NL ;
override   = path , ( "=" , value | "->" , id | "+=" , list ) , NL | "banish " , path , NL ;
possess    = "possess " , text , NL ;
key        = "key " , keyname , " = " , text , NL ;
value      = text | number , [ " " , unit ] | fraction , [ " " , unit ] | "true" | "false"
           | "void" | date | timestamp | symbol | list | inline-group | "sealed " , text ;
```

### Cheat sheet

```kitml
summon kitml 1                          -- required first line
-- comment

covenant Thing                          -- a type
  bound id-code : text unique           -- permanent, unique
  size          : number cm between 1 cm and 2 m
  kind          : one of [small, large]
  parent        : -> Thing optional     -- link type
  require size < 1 m "Too big"          -- cross-field rule
  invoke label : text = "{id-code} ({kind})"
seal

key team = "kpub1..."                   -- public key for sealing

soul box-1 is Thing                     -- a record with an ID
  bound id-code = "BX-1"
  size          = 40 cm                 -- quantity with unit
  kind          = small                 -- symbol
  parent       -> box-0                 -- verified link
  dimensions                            -- nested group
    depth = 20 cm
  from 2027-01-01                       -- time window
    kind = large
  sealed to team                        -- encrypted fields
    notes = "Fragile"
seal

circle 1 warehouse                      -- layer, chosen at load time
  box-1.size = 45 cm
  banish box-1.notes
seal

possess "more-things.kitml"               -- add another file to the realm
```
