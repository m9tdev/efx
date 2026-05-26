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
| `src/jsx-tags.ts` | `findJsxTagPair` — uses cached `jsxRanges` from the shared `EfxVirtualCode` (read via `getEfxVirtualCode` from `@efx/language`) to find tag-pair partners for document highlights. |
| `src/service-proxy.ts` | `pluginFactory` — instantiates the shared LanguagePlugin via `createEfxLanguagePlugin<string>(identity)`, builds Volar's `createLanguageServicePlugin`, then wraps the resulting `LanguageService` in a Proxy with seven method overrides (definition rewrites, document highlights, inlay hints, references). Offset conversion goes through `getEfxVirtualCode(path)?.compiledToSourceOffset(n)` / `sourceToCompiledOffset(n)` — methods on the class, not free functions. |
| `test/integration.mjs` | tsserver-subprocess harness. The acceptance-level check that the plugin really works end-to-end. |
| `build.mjs` | esbuild bundle producing `dist/index.cjs` (tsserver `require()`s the plugin as CJS). |

The LanguagePlugin itself (the Volar contract), `convertSourceMap`,
the `EfxVirtualCode` class + module-level cache, and the three
`CodeInformation` profiles live in
[`@efx/language`](../language/AGENTS.md). That package is shaped
to be host-agnostic, so a future non-tsserver Volar tool can
consume it too.

## How it fits together

```
.efx on disk ──┐
               │  Volar's LanguagePlugin
               │    getLanguageId()    — ".efx" → "efx"
               │    createVirtualCode() — transformEfx → compiled TS
               │    + Volar Mappings (from Babel source map)
               ▼
        VirtualCode ("efx-ts", typescript)
               │
               ▼  tsserver type-checks the virtual TS
               │
        LanguageService results  (positions are in compiled coords)
               │
               ▼  our Proxy wrapper
               │    rewriteDefinitionInfo()   — .ts→.efx, offset via source map
               │    getDocumentHighlights()    — JSX tag pair custom path
               │    provideInlayHints()        — filter _tag/_props/_children
               │    getReferencesAtPosition()  — dedupe + .efx redirect
               │    findReferences()           — dedupe across symbols
               ▼
        LanguageService results in .efx coords
```

## The Volar language plugin

The plugin itself — `getLanguageId`, `createVirtualCode`,
`typescript.extraFileExtensions`, `typescript.getServiceScript`,
source-map conversion, the per-`.efx` cache, the three
`CodeInformation` profiles for h-call vs. punctuation vs. normal
source — lives in [`@efx/language`](../language/AGENTS.md). Read
that node for the full picture; the short version is:

- `service-proxy.ts` calls `createEfxLanguagePlugin<string>((s) => s)`
  because tsserver identifies scripts by string filenames.
- The resulting LanguagePlugin gets handed to Volar's
  `createLanguageServicePlugin` quickstart helper, which is what
  hooks Volar into tsserver's plugin protocol.
- Everything in this package after that point is the *proxy
  wrapper* below — it doesn't touch the language plugin internals,
  only the LanguageService results it produces.

If a bug points at file enumeration, virtual-code content, the
`EfxVirtualCode` class, or the source-map mappings, the fix is in
`@efx/language`, not here. The proxy wrapper below is this
package's actual responsibility.

`getEfxVirtualCode(efxPath)` returns the same `EfxVirtualCode`
instance Volar received from `createVirtualCode` — no duplication
(matches Vue's `VueVirtualCode` pattern). Offset conversion is a
method on that instance (`vc.compiledToSourceOffset(n)` /
`vc.sourceToCompiledOffset(n)`), not a free function.

## The proxy wrapper

Volar produces a working LanguageService. We then wrap it in a
`Proxy` (in the outer `pluginFactory`) and override five methods:

- **`getDefinitionAtPosition` / `getDefinitionAndBoundSpan` /
  `getTypeDefinitionAtPosition`** — call Volar, then map each
  result through `rewriteDefinitionInfo`. This:
  - filters out hits in `packages/runtime/src/h.ts` (the JSX
    factory itself — go-to-def on `<div>` should NOT land you in
    `h.ts`)
  - rewrites `.ts` paths to `.efx` when a sibling source exists
  - subtracts the `// @generated` header offset (see "Dual-file
    setup" below) from `textSpan.start`
  - re-maps the (now header-adjusted) compiled offset back to a
    source offset via `compiledToSourceOffset`

- **`getDocumentHighlights`** — `.efx`-only custom path. If the
  cursor is on a JSX tag (anywhere on the brackets or name, but
  not on attributes), `findJsxTagPair` walks `cache.jsxRanges` and
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

- **`getReferencesAtPosition` / `findReferences`** — `.efx`-only
  redirect plus dedupe:
  - If the query starts in `.efx`, redirect it to the sibling
    `.ts` at the equivalent compiled offset (plus
    `// @generated` header offset). TypeScript's reference index
    operates on the resolved `.ts` files, not the virtual codes
    Volar produced, so going through the on-disk `.ts` is
    required for cross-file references.
  - Map every result back through `rewriteDefinitionInfo`.
  - Deduplicate by `${fileName}:${textSpan.start}`. `findReferences`
    in particular dedupes **across symbols** (its result is an
    array of symbols, each with references), because TS often
    returns the same logical reference under both the renamed
    component name and the `h(...)` call symbol.
  - Sort: definition first, then non-imports (usages), then
    imports.

## Dual-file setup (the part that's easy to miss)

On disk there are TWO files for every component: `Counter.efx`
(source) and `Counter.ts` (compiled output, generated by
`efx-compile` from `@efx/compiler`'s CLI). Both are needed:

- **`.ts` is what tsserver uses for module resolution.** When
  another file does `import { Counter } from "./Counter"`, TS
  resolves to `Counter.ts` — it's a real `.ts` on disk, and TS's
  resolver knows nothing about Volar's virtual codes.
- **`.efx` is what Volar virtual-codes for the actual type-check.**
  When the editor opens `Counter.efx`, the LanguagePlugin builds a
  virtual TS from the source. That's what receives diagnostics,
  hover, completions.

The `// @generated — do not edit. Source: Counter.efx` header at
the top of `Counter.ts` is **load-bearing** — `getGeneratedHeaderOffset`
detects it and subtracts its byte length when converting offsets
between the two files. Without that subtraction, every
go-to-def-from-a-`.ts` would land off by ~50 bytes.

Implication: **the demo's `apps/demo/.gitignore` lists every
sibling `.ts` explicitly.** It's brittle (you have to add a line
when you create a new `.efx`), but the alternative — globbing
`*.ts` — would also skip hand-written `.ts` files like
`services.ts` or `channels.test-d.ts`. Don't fix this by
deleting on-disk `.ts` files; module resolution depends on them.

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

- **`@efx/language` cache key shape** — `getEfxVirtualCode` is keyed
  by file-path string. The service-proxy's `.efx`/`.ts` path
  juggling assumes string keys; the cache uses the same convention.
  If `@efx/language` ever changes the key type, both packages
  break together.

## Anti-patterns

- Don't try to wrap LanguageService methods via Volar's `setup`
  hook or by mutating `info.languageService` from inside the
  language plugin. `createLanguageServicePlugin` returns its own
  proxy that intercepts methods before any setup-time wrap can
  apply — the wrap silently does nothing. Wrap externally with
  `new Proxy(volarService, ...)` *after* `volarModule.create(info)`
  returns (which is what `pluginFactory` at the bottom of
  `index.ts` does).
- Don't change `noHighlightData` / `structuralOnlyData` /
  `fullData` to be position-dependent at *runtime*. They're
  decided at `createVirtualCode` time per range; that's how Volar
  caches mappings.
- Don't add a fourth CodeInformation profile without checking
  Vue's docs and Volar source — the four flags
  (`verification`/`completion`/`semantic`/`navigation`/`structure`/`format`)
  interact in non-obvious ways.
- Don't delete the on-disk `.ts` siblings to "clean up." Module
  resolution breaks instantly.
- Don't switch `extraFileExtensions.scriptKind` /
  `extraFileExtensions.isMixedContent` /
  `getServiceScript.scriptKind` independently. They form a
  contract with tsc that this plugin AND any future non-tsserver
  Volar consumer of `@efx/language` both depend on. The current
  combination (Deferred + isMixedContent: true + TS for the
  virtual code) is documented in
  [`@efx/language` AGENTS.md](../language/AGENTS.md#the-extrafileextensions-shape-is-load-bearing).
  Change all three together or not at all.

## Test loop

```
pnpm --filter @efx/ts-plugin test
```

That builds the bundle and runs both the in-process unit checks
(`src/plugin.test.mjs`) and the integration harness
(`test/integration.mjs`), which spawns a real tsserver subprocess
and exercises the protocol. See `test/integration.mjs` for the
exact assertions — they're the operational definition of "the
plugin works."

## Related context

- Root [`AGENTS.md`](../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing this plugin enforces
- [`@efx/runtime`](../runtime/AGENTS.md) — the `_tag/_props/_children`
  parameter naming
- [`@efx/compiler`](../compiler/AGENTS.md) — the source-location
  preservation that the source map depends on
- [`docs/plans/ts-language-service.md`](../../docs/plans/ts-language-service.md)
  — design notes, including why Volar over hand-rolled virtuals
