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

The whole file: `src/index.ts`. Read it with this map.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Everything — Volar language plugin, source-map conversion, JSX-tag-matching, proxy wrapper. ~750 LOC. |
| `src/plugin.test.mjs` | Unit-style smoke checks on internal helpers. |
| `test/integration.mjs` | tsserver-subprocess harness. The acceptance-level check that the plugin really works end-to-end. |
| `build.mjs` | esbuild bundle producing `dist/index.cjs` (tsserver `require()`s the plugin as CJS). |

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

## The Volar language plugin (`efxLanguagePlugin`)

The minimum Volar wants is: name the language, produce a
`VirtualCode`, declare TypeScript hooks. Ours does:

- **`getLanguageId(scriptId)`** → `"efx"` for `.efx` paths.
- **`createVirtualCode(scriptId, languageId, snapshot)`** —
  reads the `.efx` source, runs `transformEfx`, builds Volar
  `Mapping<CodeInformation>[]` from Babel's source map (see next
  section), returns a single virtual `efx-ts` chunk that tsserver
  type-checks.
- **`typescript.extraFileExtensions`** — registers `.efx` with
  tsserver as `ScriptKind.TS` (3). The compiler emits no-JSX
  TypeScript; the virtual code is plain `.ts`, so the kind
  matches the actual content. Earlier iterations used
  `ScriptKind.TSX`; it works either way for the test harness,
  but plain TS is what we ship — choose the kind that describes
  what's in the buffer.
- **`typescript.getServiceScript(root)`** — returns the root
  virtual code with extension `.ts` (matching the above).

A per-`.efx` `sourceMapCache` (module-level Map) keeps
`{ source, compiled, mappings }` so the proxy wrapper can convert
offsets in both directions without re-running the compiler.

## Source-map conversion — three `CodeInformation` profiles

Volar's `Mapping<CodeInformation>` records, per source↔generated
range, which language features apply. We model three regions
(mirroring Vue's tactics for `<template>` content):

| Region | Profile | What's disabled | Why |
|---|---|---|---|
| Normal source code | `fullData` | nothing | Default |
| Inside an `h(...)` call (the JSX-compiled internals) | `noHighlightData` | `semantic.shouldHighlight: () => false` | Without this, cursor on tag name highlights every `h` identifier in the file. Hover/completions still work. |
| JSX punctuation `<` `>` `/` | `structuralOnlyData` | `semantic: false`, `completion: false`, `navigation: false` | Cursor on `<` shouldn't navigate to `h`'s definition or highlight every `<` in the file. |

`findHCallPositions(code)` does a regex+paren-depth scan to find
every `h(...)` range. `jsxPunctuation` is a hard-coded set
`{"<", ">", "/"}` consulted by source character.

The mappings are also **deduplicated by source offset** (first
mapping wins) and **lengths extend to the next mapping's source
offset** rather than being point-to-point. This is what makes
ranged operations like find-references span the actual identifier
in the source, not collapse to a single character.

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
  cursor is on a JSX tag name (verified by `findJsxTagAtPosition`),
  we run `findMatchingJsxTag` to find the partner (`<Foo>` ↔
  `</Foo>`) and highlight just the names. Falls back to Volar's
  default for anything else. The custom-regex matcher accounts
  for nested same-name tags via a depth counter, and handles
  self-closing forms (`<Foo />`).

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
- Don't switch `extraFileExtensions.scriptKind` and the matching
  `getServiceScript.scriptKind` independently. They must agree
  with what `createVirtualCode` actually produces. Today both are
  `ScriptKind.TS` because the virtual code is no-JSX TypeScript;
  if you ever emit TSX from the compiler (e.g. preserving JSX for
  some reason), update both at once.

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
