# `@efx/language` — Volar language plugin for `.efx`

The single source of truth describing `.efx` files to Volar:
how to identify them, how to produce the virtual TypeScript that
tsc/Volar see, and how to translate offsets between source and
generated code.

Shared by two consumers:

- **`@efx/ts-plugin`** — wraps it for tsserver (editor integration).
- **`@efx/check`** — wraps it for `@volar/kit` (standalone CLI).

If you reach for the LanguagePlugin from a third place, you almost
certainly want to depend on this package rather than copy it.

## Files

| File | Purpose |
|---|---|
| `src/language-plugin.ts` | `createEfxLanguagePlugin<T>(asFileName)` factory. Builds the Volar `LanguagePlugin` with `getLanguageId`, `createVirtualCode`, and `typescript: { extraFileExtensions, getServiceScript }`. Returns `LanguagePlugin<T, EfxVirtualCode>` so consumers can rely on the concrete class type at the boundary. |
| `src/source-map.ts` | `convertSourceMap` (Babel map → Volar `Mapping<CodeInformation>[]`, three-profile region tagging via compiler-emitted JSX ranges). |
| `src/virtual-code.ts` | `EfxVirtualCode` class — implements Volar's `VirtualCode` interface so Volar and downstream consumers share one object per `.efx` file. Holds `source` / `compiled` / `mappings` / `jsxRanges` alongside Volar's `id` / `languageId` / `snapshot` / `embeddedCodes`. Carries `compiledToSourceOffset` / `sourceToCompiledOffset` instance methods. Module-level cache `Map<string, EfxVirtualCode>` with `getEfxVirtualCode` / `setEfxVirtualCode` accessors. |
| `src/index.ts` | Re-exports. |

## Why a factory over a fixed plugin

Different Volar hosts identify scripts differently:

- tsserver passes string filenames (`"/path/to/Counter.efx"`).
- `@volar/kit` passes `URI` objects (`URI.file("/path/to/Counter.efx")`).

`createEfxLanguagePlugin<T>(asFileName: (id: T) => string)` lets
each consumer collapse its native id type to a file-path string at
the boundary. Internally the plugin always works in path strings:

- The cache `Map<string, EfxVirtualCode>` is keyed by file path.
- `transformEfx` is called with file path (it's used as the source
  map filename).
- `getLanguageId` decides language by `.efx` suffix on the path.

This means consumers can write:

```ts
// tsserver (@efx/ts-plugin)
createEfxLanguagePlugin<string>((s) => s)

// kit (@efx/check)
createEfxLanguagePlugin<URI>((uri) => uri.fsPath)
```

## The `extraFileExtensions` shape is load-bearing

`typescript.extraFileExtensions[0]` is:

```ts
{ extension: "efx", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }
```

Two things matter here, both copied from the Vue/Astro pattern:

- **`isMixedContent: true`** tells tsc this is a host-described file
  format. `parseJsonSourceFileConfigFileContent`'s glob expander
  only picks up `.efx` files in the `include` glob when this flag is
  on. With `isMixedContent: false`, tsc silently ignores `.efx`
  paths during file enumeration — kit checker shows 0 `.efx` files
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

## The three `CodeInformation` profiles

`convertSourceMap` tags each source↔generated mapping with one of
three profiles, decided by the source character + position:

| Region | Profile | What's disabled | Why |
|---|---|---|---|
| Normal source code | `fullData` | nothing | Default. |
| Inside an `h(...)` call (JSX-compiled internals) | `noHighlightData` | `semantic.shouldHighlight: () => false` | Without this, cursor on a JSX tag name highlights every `h` identifier in the file. Hover/completions still work. |
| JSX punctuation `<` `>` `/` inside a tag span | `structuralOnlyData` | `semantic: false`, `completion: false`, `navigation: false` | Cursor on `<` shouldn't navigate to `h`'s definition or highlight every `<`. The `> b}` inside a JSX expression must NOT match — that's why this profile only applies when the punctuation falls inside an opening/closing tag span. |

The region classification uses `jsxRanges` from `@efx/compiler` (a
parallel array of node spans, not a regex scan of the output text).
That coupling is intentional: the compiler is the only thing that
authoritatively knows what's "h() machinery" vs. user code.

## The cache is process-local module state

`virtual-code.ts` exports a module-level
`Map<string, EfxVirtualCode>`. Both `@efx/ts-plugin` and
`@efx/check` populate it from their `createVirtualCode` calls;
ts-plugin's service-proxy reads from it to do offset conversion in
definition/reference results.

The instance Volar holds (as the return value of `createVirtualCode`)
is the same instance the cache holds — no duplication, no
synchronization needed. Offset conversion is therefore a method on
the instance (`vc.compiledToSourceOffset(n)`), not a free function
that looks up the cache. Callers that already have the instance
(e.g. ones that just called `getEfxVirtualCode` once) skip the
extra lookup.

In tsserver, the cache lives for the editor session. In
`efx-check`'s CLI, the cache lives for the duration of the run.
There's no cross-process sharing — Map state is per-Node-process.

If `createVirtualCode` is called twice for the same `.efx` (rapid
edits), the cache entry is overwritten with a fresh
`EfxVirtualCode`. Stale entries for files that have been deleted
persist until process exit; that's fine in practice.

### Parameter properties are deliberately avoided

`EfxVirtualCode`'s constructor does NOT use TypeScript parameter
properties (the `constructor(readonly x: T)` form). Fields are
declared and assigned manually instead, because Node's
`--experimental-strip-types` mode — used by `@efx/check`'s CLI
and its integration test, both of which load the package's `.ts`
sources directly — rejects parameter properties as non-type
syntax. The class still uses readonly field declarations, just
not the shorthand. Don't "tidy" this back to parameter properties
without arranging for a build step.

## Coupling to other packages

- **`@efx/compiler`** — required at runtime. `createVirtualCode`
  calls `transformEfx`; `convertSourceMap` consumes the
  `JsxRange[]` the compiler emits alongside its source map.
- **`@volar/language-core`** and **`@volar/source-map`** — types only.
  The `Mapping<CodeInformation>` shape is Volar's public contract.

## Anti-patterns

- Don't change `isMixedContent` back to `false` without also
  ensuring kit-style consumers still enumerate `.efx` files. They
  won't; you'll get a silent 0-files-checked instead of an error.
- Don't add a fourth `CodeInformation` profile without studying
  how Vue's docs describe the interactions between
  `verification` / `completion` / `semantic` / `navigation` /
  `structure` / `format`. Subtle combinations matter — for
  instance, removing `navigation: true` on the h-call profile
  would break go-to-definition through JSX expressions.
- Don't move the module-level cache `Map` to a class with
  per-instance state. Both consumers expect the module-level
  singleton; instance state would mean Volar-host-specific caches
  that don't share between the plugin and the checker even when
  they happen to run together. (`EfxVirtualCode` itself IS a class,
  but the cache holding instances of it is intentionally a
  module-level singleton.)
- Don't switch `EfxVirtualCode`'s constructor to parameter
  properties (`constructor(readonly source: string, ...)`). They
  desugar into field assignments and break Node's
  `--experimental-strip-types` mode — see the "Parameter properties
  are deliberately avoided" note above.
- Don't import this package from `@efx/runtime` or `@efx/compiler`.
  The dependency direction is one-way: `language` consumes
  `compiler`. Reversing it would create a cycle.

## Tests

This package has no tests of its own. Its behavior is covered by:

- `@efx/ts-plugin/test/integration.mjs` — exercises the LanguagePlugin
  through a real tsserver subprocess.
- `@efx/check/test/integration.mjs` — exercises it through
  `@volar/kit`.

If you find yourself needing finer-grained tests (e.g., for
`convertSourceMap` edge cases), add a `src/source-map.test.ts`
using vitest — both `compiler` and `runtime` are configured that
way and you can copy their scripts.

## Related context

- Root [`AGENTS.md`](../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing.
- [`@efx/compiler`](../compiler/AGENTS.md) — source location
  preservation and `JsxRange` emission this package depends on.
- [`@efx/ts-plugin`](../ts-plugin/AGENTS.md) — tsserver consumer.
- [`@efx/check`](../check/AGENTS.md) — kit consumer.
