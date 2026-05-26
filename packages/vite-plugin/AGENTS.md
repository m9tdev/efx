# `@efx/vite-plugin` — Vite integration for `.efx`

Tiny plugin (~70 LOC). Responsible for getting `.efx` files through
Vite's dev pipeline as if they were `.ts` files.

Public surface: `export function efx(): Plugin` (also `default`).
The user adds it to their `vite.config.ts` plugins array.

## What it does

Four hooks, each load-bearing:

| Hook | Purpose |
|---|---|
| `enforce: "pre"` | Run before Vite's built-in transforms, so esbuild's TS-stripping step sees the compiled output rather than the raw `.efx` source. The specific failure mode without it isn't documented from a real incident — if you drop the flag and something breaks, ordering is the first thing to check. |
| `config()` | Extend esbuild's `include` glob to match `.efx` (alongside `.ts`/`.tsx`) with `loader: "ts"`. This makes Vite's type-stripping step accept `.efx` extensions. |
| `configureServer(server)` middleware | Rewrites every `.efx` request URL to add `?import` (if not already present). |
| `transform(code, id)` | Calls `transformEfx(code, id)` — turns JSX into `h()` calls, emits source map. |
| `load(id)` | Reads the raw file from disk for `?import`-suffixed requests. Belt-and-suspenders — the middleware ensures every `.efx` request hits this path. |

## Why the URL-rewrite middleware exists

Without the `?import` middleware, a direct browser GET for
`/src/Counter.efx` hits Vite's **static-asset middleware**, which
returns the file with empty `Content-Type`. Localhost is lenient
about that; real browsers under strict-MIME (including any
non-localhost origin like LAN) reject it.

Adding `?import` routes the same URL through Vite's **module
pipeline** where the `transform` hook fires, the result is
JavaScript, and `Content-Type: text/javascript` is set
correctly. Strict-MIME accepts that.

The middleware replaced an earlier HTML-rewrite approach, which
broke for two distinct reasons that both surfaced in practice:

1. **HMR cache-bust re-fetches.** After an edit, Vite re-fetches
   modules with a `?t=<ts>` query (`Counter.efx?t=1700000000`).
   The HTML rewrite only touched initial `<script src>` URLs, so
   re-fetches landed on the static-asset middleware again with
   empty Content-Type and broke HMR.
2. **ES-module subgraph fetches.** When an already-loaded module
   does `import "./Counter.efx"`, the browser fetches that URL
   directly — never goes through HTML. HTML rewriting can't help.

The middleware solves both at once: every `.efx` URL gets `?import`
appended (preserving any existing query), so every request — first
load, HMR re-fetch, subgraph fetch — goes through the module path.

If you find yourself "fixing" this by removing the middleware,
test HMR after an edit AND test from a non-localhost origin before
declaring it unnecessary.

## Regex notes

The plugin defines three nearly-identical regexes:

- `EFX_RE` — for the `transform` hook (`/\.efx(?:\?[^.]*)?$/`):
  matches the path with optional query, used to gate transforms.
- `EFX_PATH_RE` — for the `load` hook (`/\.efx$/`): matches the
  path *after* `id.split("?")[0]`, so no query handling needed.
- `EFX_URL_RE` — for the URL middleware (`/\.efx(\?.*)?$/`):
  matches the URL with optional query for rewriting.
- `HAS_IMPORT_RE` — checks for an existing `?import` / `&import`
  so we don't double-add.

They look duplicative but serve different positions (request URL
vs Vite id vs path-only). Don't unify naively.

## What this plugin does NOT do

- No HMR logic of its own — Vite's built-in HMR works because the
  output of `transform` is JavaScript modules.
- No source map combining — Babel's source map is passed straight
  through to Vite (the `as never` cast bypasses Vite's strict
  `RawSourceMap` type, which Babel's loose-but-compatible map
  trips on at type-check time).
- No caching. `transformEfx` is called on every request. The
  compiler is fast enough that this hasn't been a problem; if it
  becomes one, cache by file mtime.
- No production-build divergence. The same `transform` runs at
  build time. The type-check path (where Vite isn't in the loop)
  goes through [`@efx/check`](../check/AGENTS.md), which calls
  the compiler directly via the shared language plugin.

## Anti-patterns

- Don't switch to HTML rewriting for the `?import` problem. Two
  things break: HMR cache-bust re-fetches (which bypass HTML) and
  ES-module subgraph fetches (which never touch HTML).
- Don't drop `enforce: "pre"` without testing the full HMR cycle.
  Ordering is the most likely cause of any breakage.
- Don't add `optimizeDeps` entries for `.efx` files. They're not
  modules to pre-bundle; they're source files compiled on the fly.

## Related context

- [`@efx/compiler`](../compiler/AGENTS.md) — the `transformEfx`
  function this plugin wraps
- Root [`AGENTS.md`](../../AGENTS.md) — why JSX must never reach
  the downstream TS-aware tools (esbuild's type-stripping step is
  one such tool)
