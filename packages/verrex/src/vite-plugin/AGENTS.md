# `verrex/vite` — Vite integration for `.vx`

Tiny plugin (~70 LOC). Responsible for getting `.vx` files through
Vite's dev pipeline as if they were `.ts` files.

Public surface: `export function verrex(): Plugin` (also `default`).
The user adds it to their `vite.config.ts` plugins array.

## What it does

The plugin **owns the full `.vx` → JavaScript transform** and hands
Vite finished JS. It does *not* lean on Vite's built-in transformer to
strip the TypeScript — see "Why we own the whole transform" below.

Three hooks, each load-bearing:

| Hook | Purpose |
|---|---|
| `enforce: "pre"` | Run before other plugins' transforms so our hook is the one that turns a `.vx` id into a module. If you drop the flag and something breaks, ordering is the first thing to check. |
| `configureServer(server)` middleware | Rewrites every `.vx` request URL to add `?import` (if not already present). |
| `transform(code, id)` | Two steps: (1) `transformVerrex(code, id, { errorRecovery: false })` turns JSX into `h()` calls (still TypeScript); (2) Vite's `transformWithOxc(ts, id, { lang: "ts" }, babelMap)` strips the types → JS and chains the Babel map. Returns `{ code, map, moduleType: "js" }`. |
| `load(id)` | Reads the raw file from disk for `?import`-suffixed requests. Belt-and-suspenders — the middleware ensures every `.vx` request hits this path. |

## Why we own the whole transform (Vite 8 / Oxc)

Earlier versions did **not** strip types themselves. They set
`config().esbuild.include = [/\.vx$/, …]` so `.vx` rode Vite's
built-in esbuild TS-stripping step. That coupled the plugin to Vite's
internal transformer — and broke in Vite 8, which swapped esbuild+Rollup
for **Rolldown+Oxc**: the `esbuild` config option is deprecated, and
Rolldown's `builtin:vite-transform` errors with *"Failed to detect the
lang of …/main.vx"* because it infers a module's language from its
extension and `.vx` is unknown.

The fix is to do the type-strip *in the plugin* and return plain JS:

- `transformWithOxc(tsCode, id, { lang: "ts" }, babelMap)` — Vite 8's
  exported Oxc transform. `lang: "ts"` tells Oxc the post-Babel code is
  TypeScript (it can't infer that from the `.vx` id); the 4th arg
  `inMap` chains the Babel `.vx` → TS map so the returned map resolves
  to the original `.vx`.
- `moduleType: "js"` on the result tells Rolldown the output is plain
  JavaScript, so it never runs lang-detection on the `.vx` id.

This keeps the plugin **bundler-agnostic** — it no longer depends on
whatever transformer Vite ships, which is exactly the coupling that
snapped across the esbuild → Oxc swap. The same `transform` runs in dev
and build, so both paths fixed at once.

### Build vs. editor error policy

`transformVerrex`'s default `errorRecovery: true` lets the editor tolerate
mid-edit unparseable source (see [`verrex/compiler`](../compiler/AGENTS.md)).
The build path passes **`errorRecovery: false`** so a genuine syntax
error throws here — a Vite error overlay in dev, a failed build in CI —
instead of the compiler silently recovering and us shipping a broken
module. Vite (not tsc) is the only checker on the build path, so this
plugin is where "fail loudly on bad syntax" has to live.

## Why the URL-rewrite middleware exists

Without the `?import` middleware, a direct browser GET for
`/src/Counter.vx` hits Vite's **static-asset middleware**, which
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
   modules with a `?t=<ts>` query (`Counter.vx?t=1700000000`).
   The HTML rewrite only touched initial `<script src>` URLs, so
   re-fetches landed on the static-asset middleware again with
   empty Content-Type and broke HMR.
2. **ES-module subgraph fetches.** When an already-loaded module
   does `import "./Counter.vx"`, the browser fetches that URL
   directly — never goes through HTML. HTML rewriting can't help.

The middleware solves both at once: every `.vx` URL gets `?import`
appended (preserving any existing query), so every request — first
load, HMR re-fetch, subgraph fetch — goes through the module path.

If you find yourself "fixing" this by removing the middleware,
test HMR after an edit AND test from a non-localhost origin before
declaring it unnecessary.

## Regex notes

The plugin defines three nearly-identical regexes:

- `VERREX_RE` — for the `transform` hook (`/\.vx(?:\?[^.]*)?$/`):
  matches the path with optional query, used to gate transforms.
- `VERREX_PATH_RE` — for the `load` hook (`/\.vx$/`): matches the
  path *after* `id.split("?")[0]`, so no query handling needed.
- `VERREX_URL_RE` — for the URL middleware (`/\.vx(\?.*)?$/`):
  matches the URL with optional query for rewriting.
- `HAS_IMPORT_RE` — checks for an existing `?import` / `&import`
  so we don't double-add.

They look duplicative but serve different positions (request URL
vs Vite id vs path-only). Don't unify naively.

## What this plugin does NOT do

- No HMR logic of its own — Vite's built-in HMR works because the
  output of `transform` is JavaScript modules.
- No *manual* source-map composition. The two-stage map (Babel
  `.vx`→TS, then Oxc TS→JS) is chained by `transformWithOxc`'s
  `inMap` argument — we pass the Babel map in and get the composed
  `.vx`→JS map back. No remapping library, no hand-rolled merge.
- No caching. `transformVerrex` is called on every request. The
  compiler is fast enough that this hasn't been a problem; if it
  becomes one, cache by file mtime.
- No production-build divergence. The same `transform` runs at
  build time. The type-check path (where Vite isn't in the loop)
  goes through [`verrex/check`](../check/AGENTS.md), which calls
  the compiler directly via the shared language plugin.

## Anti-patterns

- Don't switch to HTML rewriting for the `?import` problem. Two
  things break: HMR cache-bust re-fetches (which bypass HTML) and
  ES-module subgraph fetches (which never touch HTML).
- Don't drop `enforce: "pre"` without testing the full HMR cycle.
  Ordering is the most likely cause of any breakage.
- Don't add `optimizeDeps` entries for `.vx` files. They're not
  modules to pre-bundle; they're source files compiled on the fly.

## Related context

- [`verrex/compiler`](../compiler/AGENTS.md) — the `transformVerrex`
  function this plugin wraps
- Root [`AGENTS.md`](../../../../AGENTS.md) — why JSX must never reach
  the downstream TS-aware tools (esbuild's type-stripping step is
  one such tool)
