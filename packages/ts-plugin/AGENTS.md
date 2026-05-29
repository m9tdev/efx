# `@efx/ts-plugin` — Volar-based language plugin for `.efx`

What this delivers in your editor: type errors, hover, completions,
inlay hints, go-to-definition, find-references, and JSX tag-pair
highlights, all on the `.efx` source. No virtual file is visible
to the user.

Built on **Volar** (`@volar/typescript`, `@volar/language-core`,
`@volar/source-map`) — we use its language-plugin framework for the
heavy lifting (file discovery, content transformation, position
mapping) and wrap the resulting LanguageService with a thin proxy
for the things Volar doesn't quite do out of the box.

After the `@efx/language` extraction this package contains only the
tsserver-facing pieces; esbuild bundles them into `dist/index.cjs`
for tsserver to `require()`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry. Re-exports `pluginFactory` via `export =`. |
| `src/jsx-tags.ts` | `findJsxTagPair` — takes a `JsxTagProvider` (the in-process seam) and uses its `jsxRanges` from the shared `EfxVirtualCode` to find tag-pair partners for document highlights. The service-proxy builds the provider by resolving the `EfxVirtualCode` from Volar's context. |
| `src/classify-references.ts` | `classifyRefs` — decorates each ref with `{ isDef, isImport }` in one pass, with a per-call file-content cache so each source file is read at most once. `findReferences` then sorts on the precomputed booleans instead of doing disk I/O inside the comparator. |
| `src/service-proxy.ts` | `pluginFactory` — instantiates the shared LanguagePlugin via `createEfxLanguagePlugin<string>(identity)`, builds Volar's `createLanguageServicePlugin` (capturing the session `Language` through its `setup(language)` hook), then wraps the resulting `LanguageService` in a Proxy with a few method overrides (filter `@efx/runtime`'s `h.ts` from definition results, JSX tag-pair document highlights, `_tag`/`_props`/`_children` inlay-hint filter, reference dedup + sort). Resolves the per-`.efx` `EfxVirtualCode` from `language.scripts` when it needs `jsxRanges` or `source`. |
| `src/classify-references.test.ts` | Unit tests for `classifyRefs` — injects a fake `readFile` to assert classification rules and per-call caching without touching disk. |
| `src/plugin.test.mjs` | Manual smoke test loading the built bundle (`dist/index.cjs`) and asserting plugin shape. Not run by `pnpm test` (vitest config only picks up `*.test.ts`); invoke directly with `node` after building. |
| `vitest.config.ts` | Picks up `src/**/*.test.ts`. The package's `test` script runs vitest first, then builds and runs the integration harness. |
| `test/integration.mjs` | tsserver-subprocess harness. The acceptance-level check that the plugin really works end-to-end. |
| `build.mjs` | esbuild bundle producing `dist/index.cjs` (tsserver `require()`s the plugin as CJS). |

The LanguagePlugin itself (the Volar contract), `convertSourceMap`,
the `EfxVirtualCode` class, and the three `CodeInformation` profiles
live in [`@efx/language`](../language/AGENTS.md) — shared with
`@efx/check`.

## How it fits together

```
.efx on disk ──┐
               │  Volar's LanguagePlugin (in @efx/language)
               │    getLanguageId()    — ".efx" → "efx"
               │    createVirtualCode() — transformEfx → compiled TS
               │    + Volar Mappings (from Babel source map)
               ▼
        EfxVirtualCode (Volar VirtualCode)
               │
               ▼  tsserver type-checks the virtual TS, Volar maps
               │  results back to source .efx coordinates
        LanguageService results in .efx coords
               │
               ▼  our Proxy wrapper
               │    filterRuntimeHit()        — drop hits in runtime/h.ts
               │    getDocumentHighlights()   — JSX tag pair custom path
               │    provideInlayHints()       — filter _tag/_props/_children
               │    get/findReferences()      — dedupe + sort
               ▼
        Final LanguageService results
```

## The Volar language plugin

The plugin itself — `getLanguageId`, `createVirtualCode`,
`typescript.extraFileExtensions`, `typescript.getServiceScript`,
source-map conversion, the three `CodeInformation` profiles for
h-call vs. punctuation vs. normal source — lives in
[`@efx/language`](../language/AGENTS.md). Read that node for the full
picture; the short version is:

- `service-proxy.ts` calls `createEfxLanguagePlugin<string>((s) => s)`
  — tsserver identifies scripts by string filenames.
- The resulting LanguagePlugin gets handed to Volar's
  `createLanguageServicePlugin` quickstart helper, which is what
  hooks Volar into tsserver's plugin protocol. We pass a
  `setup(language)` callback to that helper; it fires synchronously
  inside `create(info)`, and we stash the session's `Language` so the
  proxy can resolve compiled `.efx` files from it.
- Everything in this package after that point is the *proxy
  wrapper* below — it doesn't touch the language plugin internals,
  only the LanguageService results it produces.

If a bug points at file enumeration, virtual-code content, the
`EfxVirtualCode` class, or the source-map mappings, the fix is in
`@efx/language`, not here. The proxy wrapper below is this
package's actual responsibility.

`getEfxVirtualCode(fileName)` resolves
`language.scripts.get(fileName).generated.root` and narrows it with
`instanceof EfxVirtualCode` — the exact instance Volar received from
`createVirtualCode`, read back from Volar's own context with no
side-channel cache (matches Vue's `VueVirtualCode` pattern). The
proxy wrapper below doesn't translate offsets itself: Volar's own
`SourceMap` indexes `mappings` and maps virtual-code coordinates back
to `.efx` source before results reach us. We resolve the
`EfxVirtualCode` only for `jsxRanges` (via the `JsxTagProvider` handed
to `jsx-tags.ts`) and `source` (whitespace-at-cursor suppression).

## The proxy wrapper

Volar produces a working LanguageService. We then wrap it in a
`Proxy` (in the outer `pluginFactory`) and override four groups of
methods. Six of the seven overrides route through a local
`wrapMethod(name, transform)` helper — it calls the underlying
LanguageService method eagerly and hands the result plus the
original args to `transform`. `getDocumentHighlights` is the
exception: its `.efx` path early-returns (whitespace skip,
JSX-pair match) before the underlying call would fire, which the
eager-call shape of `wrapMethod` can't express, so it stays
hand-rolled.

- **`getDefinitionAtPosition` / `getDefinitionAndBoundSpan` /
  `getTypeDefinitionAtPosition`** — call Volar, then filter each
  result through `filterRuntimeHit`: drop any hit whose path
  contains `/runtime/` and ends in `/h.ts` (the JSX factory
  itself — go-to-def on `<div>` should NOT land you in `h.ts`).
  The predicate is intentionally loose so a workspace-relative
  path, an absolute path, or a vendored copy all match. Volar
  has already mapped results back to `.efx` source coordinates
  via its own `SourceMap`, and TS's resolver finds `.efx` files
  directly via `extraFileExtensions` — no path rewriting, no
  offset re-mapping, no header-offset subtraction needed.

- **`getDocumentHighlights`** — `.efx`-only custom path. If the
  cursor is on a JSX tag (anywhere on the brackets or name, but
  not on attributes), `findJsxTagPair` walks the
  `EfxVirtualCode.jsxRanges` resolved from Volar's context and
  returns the matching opening↔closing name spans. Highlights just
  the names. Babel paired the tags during parse; we don't depth-
  count or regex-scan. Self-closing (`<Foo />`) and fragments
  (`<>...</>`) return no pair. Falls back to Volar's default
  outside JSX tags.

- **`provideInlayHints`** — `.efx`-only filter. Volar gives us all
  hints including the h() parameter labels (`_tag`, `_props`,
  `_children`). We drop any hint whose text matches
  `/^_?(tag|props|children):?$/i`. Reads `hint.text` AND
  `hint.displayParts` (newer TS uses the latter).

- **`getReferencesAtPosition` / `findReferences`** — dedupe + sort:
  - Filter out hits in `@efx/runtime`'s `h.ts` (same reason as the
    definition overrides).
  - Deduplicate by `${fileName}:${textSpan.start}`. `findReferences`
    in particular dedupes **across symbols** (its result is an
    array of symbols, each with references), because TS often
    returns the same logical reference under both the renamed
    component name and the `h(...)` call symbol.
  - Sort: definition first, then non-imports (usages), then
    imports. The "is this an import line?" decision needs to read
    the source file — `classifyRefs` does that **once** per
    distinct file before the sort runs, so the comparator only
    looks at precomputed booleans. Previously the comparator
    called `ts.sys.readFile` inline, paying O(N log N) reads of
    the same handful of files.

## Cross-file resolution

Find-references and go-to-definition cross `.efx` files natively
because user code writes `import { X } from "./Foo.efx"` (the
root invariant) — TS's resolver picks up `.efx` via the
`extraFileExtensions` registered by [`@efx/language`](../language/AGENTS.md),
the file lands in the program as virtual code, and TS's reference
index sees usages across files. No sibling `.ts` shim is involved.

## Coupling to other packages

- **`@efx/runtime` `h.ts`** — the `HFn` signature uses parameter
  names `_tag`/`_props`/`_children` (with underscore prefix).
  This is **coupled to the inlay-hint filter regex above**. If you
  rename them in `h.ts`, update the regex in `provideInlayHints`.
  The `_?` in the regex makes it tolerate both the prefixed and
  unprefixed variants.

- **`@efx/compiler` `copyLoc`** — the compiler preserves source
  locations on emitted nodes. Without that, Babel's source map
  collapses everything to the start of the JSX expression, and
  go-to-definition lands on the wrong token.

- **`@efx/compiler` `jsxRanges`** — `TransformResult.jsxRanges` is
  load-bearing for two features: classifying source positions as
  "inside h()" or "JSX punctuation" during source-map conversion
  (in `@efx/language`), and finding tag-pair partners for document
  highlights (`jsx-tags.ts` here). If the compiler ever stops
  emitting it (e.g. swc swap), both features break silently. The
  array is stored on `EfxVirtualCode` next to `mappings` so neither
  consumer re-runs the compiler.

- **Volar script-key shape** — we resolve the `EfxVirtualCode` via
  `language.scripts.get(fileName)`, keyed by the `.efx` file-path
  string tsserver hands us — the same string `createEfxLanguagePlugin`
  is configured with (`asFileName` is identity here). If that key
  convention changes in `@efx/language`, the lookup here breaks with
  it.

## Anti-patterns

- Don't try to wrap LanguageService methods via Volar's `setup`
  hook or by mutating `info.languageService` from inside the
  language plugin. `createLanguageServicePlugin` returns its own
  proxy that intercepts methods before any setup-time wrap can
  apply — the wrap silently does nothing. Wrap externally with
  `new Proxy(volarService, ...)` *after* `volarModule.create(info)`
  returns (which is what `pluginFactory` at the bottom of
  `index.ts` does). Using `setup(language)` to *capture* the
  `Language` for read-only lookups (`language.scripts.get(...)`) is
  fine and expected — it's *wrapping methods* there that doesn't
  work. The capture is a synchronous handoff: `setup` fires inside
  `volarModule.create(info)`, so read the stashed `Language` into a
  per-`create` const immediately after that call returns, before any
  service method can run.
- Don't change `noHighlightData` / `structuralOnlyData` /
  `fullData` to be position-dependent at *runtime*. They're
  decided at `createVirtualCode` time per range; that's how Volar
  caches mappings.
- Don't add a fourth CodeInformation profile without checking
  Vue's docs and Volar source — the four flags
  (`verification`/`completion`/`semantic`/`navigation`/`structure`/`format`)
  interact in non-obvious ways.
- Don't switch `extraFileExtensions.scriptKind` /
  `extraFileExtensions.isMixedContent` /
  `getServiceScript.scriptKind` independently. They form a
  contract with tsc that's load-bearing across both this plugin's
  tsserver path and `@efx/check`'s kit path. The current
  combination (Deferred + isMixedContent: true + TS for the
  virtual code) is documented in
  [`@efx/language` AGENTS.md](../language/AGENTS.md#the-extrafileextensions-shape-is-load-bearing).
  Change all three together or not at all.

## Test loop

```
pnpm --filter @efx/ts-plugin test
```

Three phases: vitest runs the `*.test.ts` unit suites
(currently `src/classify-references.test.ts`), the package builds
its CJS bundle, and `node test/integration.mjs` spawns a real
tsserver subprocess and exercises the LSP protocol against it.
The integration harness is the acceptance-level definition of "the
plugin works." `src/plugin.test.mjs` is a manual smoke test outside
this loop — run it separately if you want a quick post-build
shape check.

## Related context

- Root [`AGENTS.md`](../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing this plugin enforces
- [`@efx/runtime`](../runtime/AGENTS.md) — the `_tag/_props/_children`
  parameter naming
- [`@efx/compiler`](../compiler/AGENTS.md) — the source-location
  preservation that the source map depends on
- [`@efx/language`](../language/AGENTS.md) — the shared Volar
  language plugin that does the heavy lifting
