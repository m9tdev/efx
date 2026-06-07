# `verrex/language` — Volar language plugin for `.vx`

The single source of truth describing `.vx` files to Volar:
how to identify them, how to produce the virtual TypeScript that
tsc/Volar see, and how to translate offsets between source and
generated code.

Shared by two consumers:

- **`@verrex/ts-plugin`** — wraps it for tsserver (editor integration).
- **`verrex/check`** — wraps it for `@volar/kit` (standalone CLI).

If you reach for the LanguagePlugin from a third place, you almost
certainly want to depend on this package rather than copy it.

## Files

| File | Purpose |
|---|---|
| `src/language-plugin.ts` | `createVerrexLanguagePlugin<T>(asFileName)` factory. Builds the Volar `LanguagePlugin` with `getLanguageId`, `createVirtualCode`, and `typescript: { extraFileExtensions, getServiceScript }`. Returns each per-`.vx` `VerrexVirtualCode` to Volar, which owns and indexes it. Returns `LanguagePlugin<T, VerrexVirtualCode>` so consumers can rely on the concrete class type at the boundary. |
| `src/source-map.ts` | `convertSourceMap` — thin translator from `verrex/compiler`'s `CompilerMapping[]` to Volar's `Mapping<CodeInformation>[]`. Maps the compiler's `"user"` / `"h-call"` / `"punctuation"` kinds to Volar profiles. ~15 LOC of actual logic + the three profile objects. |
| `src/virtual-code.ts` | `VerrexVirtualCode` class — implements Volar's `VirtualCode` interface so Volar and downstream consumers share one object per `.vx` file. Holds `source` / `compiled` / `mappings` / `jsxRanges` alongside Volar's `id` / `languageId` / `snapshot` / `embeddedCodes`. Volar owns the instance; consumers read it back via `language.scripts.get(id).generated.root`. |
| `src/source-map.test.ts` | Vitest suite pinning `convertSourceMap`'s span-length passthrough and the user/h-call/punctuation profile assignments. |
| `src/index.ts` | Re-exports. |

## Why a factory over a fixed plugin

Different Volar hosts identify scripts differently:

- tsserver passes string filenames (`"/path/to/Counter.vx"`).
- `@volar/kit` passes `URI` objects (`URI.file("/path/to/Counter.vx")`).

`createVerrexLanguagePlugin<T>(asFileName: (id: T) => string)`
lets each consumer collapse its native id type to a file-path string at
the boundary. `asFileName` is the plugin's only axis of variation.
Internally the plugin always works in path strings:

- `transformVerrex` is called with file path (it's used as the source
  map filename).
- `getLanguageId` decides language by `.vx` suffix on the path.

This means consumers can write:

```ts
// tsserver (@verrex/ts-plugin)
createVerrexLanguagePlugin<string>((s) => s)

// kit (verrex/check)
createVerrexLanguagePlugin<URI>((uri) => uri.fsPath)
```

## The `extraFileExtensions` shape is load-bearing

`typescript.extraFileExtensions[0]` is:

```ts
{ extension: "verrex", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }
```

Two things matter here, both copied from the Vue/Astro pattern:

- **`isMixedContent: true`** tells tsc this is a host-described file
  format. `parseJsonSourceFileConfigFileContent`'s glob expander
  only picks up `.vx` files in the `include` glob when this flag is
  on. With `isMixedContent: false`, tsc silently ignores `.vx`
  paths during file enumeration — kit checker shows 0 `.vx` files
  in the project.

- **`scriptKind: Deferred` (7)** signals that the actual script
  content/kind is described by the LanguagePlugin via
  `getServiceScript`, not inferable from the extension. Earlier
  versions used `ScriptKind.TS` (3) here; that "works" for the
  tsserver path because Volar's `createLanguageServicePlugin`
  injects files via `getExternalFiles` rather than relying on
  config-file globs, but it breaks kit's standalone enumeration.
  Use `Deferred` to make both code paths work.

`getServiceScript` still returns `{ extension: ".ts", scriptKind:
ScriptKind.TS }` — that describes the *virtual code's* content,
which IS plain TypeScript. The two scriptKinds are not in conflict:
one describes the on-disk file (Deferred → ask me), the other
describes the buffer tsc will type-check (TS → no JSX inside).

If you change either flag, update both. They form a contract with
tsc that's easy to get wrong silently.

### `extraFileExtensions` does not bend the module resolver

Registering `.vx` here makes tsc willing to *consume* a file
named `Foo.vx`. It does NOT make `import "./Foo"` resolve to
`Foo.vx` — that's why user code carries the explicit `.vx`
extension (see root [AGENTS.md](../../../../AGENTS.md)). If you ever
make extensionless imports resolve, it'll be a change to this
package's plugin shape, not to the convention.

## The three `CodeInformation` profiles

`convertSourceMap` is a one-pass translator over the compiler's
`CompilerMapping[]`. Each mapping carries a `kind` tag classified
by the compiler; we map it to a Volar `CodeInformation` profile:

| Kind (from compiler) | Profile | What's disabled | Why |
|---|---|---|---|
| `"user"` | `fullData` | nothing | Default. Normal user code. |
| `"h-call"` | `noHighlightData` | `semantic.shouldHighlight: () => false` | Without this, cursor on a JSX tag name highlights every `h` identifier in the file. Hover/completions still work. |
| `"punctuation"` | `structuralOnlyData` | `semantic: false`, `completion: false`, `navigation: false` | Cursor on `<` shouldn't navigate to `h`'s definition or highlight every `<`. |

The compiler decides `kind` while building the mappings — it
already knows what each emitted byte represents. This package's
job is the Volar-shape translation only. See
[`verrex/compiler` AGENTS.md → "Source-map mappings"](../compiler/AGENTS.md#source-map-mappings--typed-sourcegenerated-spans)
for the algorithm.

### Source and generated lengths come from the compiler

Each mapping carries both `lengths` (source span) and
`generatedLengths` (generated span). They can differ — Babel's
output often shrinks regions: `(n) =>` compiles to `n =>` (parens
dropped for single-param arrows), so a source mapping covering
`((` (2 chars) lines up with generated `(` (1 char).

If only source lengths were tracked, Volar would assume the
generated span has the same length and over-claim generated
territory for that mapping — swallowing positions that belong to
the next mapping. Inlay-hint positions get this wrong most
visibly: a `: number` parameter-type hint that should render
after `n` lands at the `n`'s position instead, displaying as
`( : numbern)`. Both `verrex/compiler` and `@verrex/ts-plugin` have
tests pinning this exact case.

`convertSourceMap` just copies the lengths through — the compiler
produces them.

## Volar owns the `VerrexVirtualCode` instance

`createVirtualCode` returns each per-`.vx` `VerrexVirtualCode` to
Volar. Volar holds it and indexes it on the source script —
reachable at `language.scripts.get(scriptId).generated.root`. There
is **no side-channel cache** in this package; Volar's own context is
the single source of truth.

Downstream consumers read the instance back from Volar rather than a
parallel index. `@verrex/ts-plugin` captures the session's `Language`
via the `setup(language)` hook of Volar's `createLanguageServicePlugin`,
then resolves the compiled file with an `instanceof VerrexVirtualCode`
narrow when it needs `jsxRanges` (tag-pair document highlights) or
`source` (whitespace-at-cursor suppression). The instance it gets is
the exact one `createVirtualCode` returned — no duplication, no
synchronization. Volar consumes the `mappings` array directly via its
own `SourceMap` indexing, so source ↔ generated offset translation
never goes through this package either.

Lifetime is Volar's concern: each tsserver session and each
`@volar/kit` `createTypeScriptChecker` call has its own `Language`,
so two in-process `runCheck` calls never see each other's virtual
codes. Re-compilation on edits, eviction of deleted files, and
staleness are all handled by Volar's script lifecycle — this package
holds no state that could drift.

### Why read from Volar's context, not a threaded cache

Earlier versions threaded a `VirtualCodeRegistry` (a
`Map<string, VerrexVirtualCode>`) through the factory so consumers could
look compiled files back up. But that registry was a *second index of
the very objects Volar already owns* — `verrex/check` constructed one
and never read it (pure write-only ceremony), and picking the wrong
instance silently yielded stale `jsxRanges` with no compile-time
guard. Resolving through `language.scripts.get(id).generated.root`
(the idiom Vue's `typescript-plugin` uses) deletes the second index,
the per-consumer lifetime question, and the stale-instance bug class
in one move — and shrinks the factory to a transform from host
identity + source to a Volar plugin, with `asFileName` as its only
parameter.

### Parameter properties are deliberately avoided

`VerrexVirtualCode`'s constructor does NOT use TypeScript parameter
properties (the `constructor(readonly x: T)` form). Fields are
declared and assigned manually instead, because Node's
`--experimental-strip-types` mode — used by `verrex/check`'s CLI
and its integration test, both of which load the package's `.ts`
sources directly — rejects parameter properties as non-type
syntax. The class still uses readonly field declarations, just
not the shorthand. Don't "tidy" this back to parameter properties
without arranging for a build step.

## Coupling to other packages

- **`verrex/compiler`** — required at runtime. `createVirtualCode`
  calls `transformVerrex`; `convertSourceMap` consumes the
  `CompilerMapping[]` the compiler produces (it has both source
  and generated lengths plus a kind tag, ready for translation to
  Volar shape). `jsxRanges` is also consumed but only for
  `VerrexVirtualCode.jsxRanges` (used by `@verrex/ts-plugin/jsx-tags.ts`
  for opening↔closing tag-pair document highlights), not for
  position translation.
- **`@volar/language-core`** and **`@volar/source-map`** — types only.
  The `Mapping<CodeInformation>` shape is Volar's public contract.

## Anti-patterns

- Don't change `isMixedContent` back to `false` without also
  ensuring kit-style consumers still enumerate `.vx` files. They
  won't; you'll get a silent 0-files-checked instead of an error.
- Don't add a fourth `CodeInformation` profile without studying
  how Vue's docs describe the interactions between
  `verification` / `completion` / `semantic` / `navigation` /
  `structure` / `format`. Subtle combinations matter — for
  instance, removing `navigation: true` on the h-call profile
  would break go-to-definition through JSX expressions.
- Don't reintroduce a side-channel cache (a `Map`, a registry, a
  module-level singleton) for compiled `.vx` files. Volar already
  owns each `VerrexVirtualCode` and indexes it on the source script —
  resolve it through `language.scripts.get(id).generated.root`
  (`instanceof VerrexVirtualCode` to narrow) instead of building a
  second index that can fall out of sync. A new consumer captures
  the `Language` from its host (the `setup(language)` hook for
  tsserver; the kit checker for `verrex/check`) and reads from it.
- Don't switch `VerrexVirtualCode`'s constructor to parameter
  properties (`constructor(readonly source: string, ...)`). They
  desugar into field assignments and break Node's
  `--experimental-strip-types` mode — see the "Parameter properties
  are deliberately avoided" note above.
- Don't import this package from `verrex` or `verrex/compiler`.
  The dependency direction is one-way: `language` consumes
  `compiler`. Reversing it would create a cycle.

## Tests

In-package vitests:

- `src/source-map.test.ts` — pins the bidirectional source/generated
  position-mapping contract through `convertSourceMap`.

Broader behavior is covered by:

- `@verrex/ts-plugin/test/integration.mjs` — exercises the LanguagePlugin
  through a real tsserver subprocess.
- `verrex/check/test/integration.mjs` — exercises it through
  `@volar/kit`.

If you need more fine-grained tests, follow the existing pattern
(`src/*.test.ts` + the shared `vitest.config.ts`).

## Related context

- Root [`AGENTS.md`](../../../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing.
- [`verrex/compiler`](../compiler/AGENTS.md) — source location
  preservation and `JsxRange` emission this package depends on.
- [`@verrex/ts-plugin`](../../../ts-plugin/AGENTS.md) — tsserver consumer.
- [`verrex/check`](../check/AGENTS.md) — kit consumer.
