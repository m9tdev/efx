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
| `src/language-plugin.ts` | `createEfxLanguagePlugin<T>(asFileName, registry)` factory. Builds the Volar `LanguagePlugin` with `getLanguageId`, `createVirtualCode`, and `typescript: { extraFileExtensions, getServiceScript }`. Writes per-`.efx` `EfxVirtualCode` into the supplied `VirtualCodeRegistry`. Returns `LanguagePlugin<T, EfxVirtualCode>` so consumers can rely on the concrete class type at the boundary. |
| `src/source-map.ts` | `convertSourceMap` — thin translator from `@efx/compiler`'s `CompilerMapping[]` to Volar's `Mapping<CodeInformation>[]`. Maps the compiler's `"user"` / `"h-call"` / `"punctuation"` kinds to Volar profiles. ~15 LOC of actual logic + the three profile objects. |
| `src/virtual-code.ts` | `EfxVirtualCode` class — implements Volar's `VirtualCode` interface so Volar and downstream consumers share one object per `.efx` file. Holds `source` / `compiled` / `mappings` / `jsxRanges` alongside Volar's `id` / `languageId` / `snapshot` / `embeddedCodes`. Plus `VirtualCodeRegistry` — the per-consumer `Map<string, EfxVirtualCode>` cache (one per tsserver session, one per `runCheck`). |
| `src/index.ts` | Re-exports. |

## Why a factory over a fixed plugin

Different Volar hosts identify scripts differently:

- tsserver passes string filenames (`"/path/to/Counter.efx"`).
- `@volar/kit` passes `URI` objects (`URI.file("/path/to/Counter.efx")`).

`createEfxLanguagePlugin<T>(asFileName: (id: T) => string, registry: VirtualCodeRegistry)`
lets each consumer collapse its native id type to a file-path string at
the boundary. Internally the plugin always works in path strings:

- The `VirtualCodeRegistry` keyed by file path is the cache.
- `transformEfx` is called with file path (it's used as the source
  map filename).
- `getLanguageId` decides language by `.efx` suffix on the path.

This means consumers can write:

```ts
// tsserver (@efx/ts-plugin) — one registry per session
const registry = new VirtualCodeRegistry()
createEfxLanguagePlugin<string>((s) => s, registry)

// kit (@efx/check) — one registry per runCheck call
const registry = new VirtualCodeRegistry()
createEfxLanguagePlugin<URI>((uri) => uri.fsPath, registry)
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

### Cross-file imports require the explicit `.efx` extension

`extraFileExtensions` makes tsc willing to consume a file named
`Foo.efx` — but it does NOT make `import { x } from "./Foo"`
resolve to `Foo.efx`. TS's module resolver only tries custom
extensions against import specifiers that already carry the
matching suffix. User code has to write:

```ts
import { Counter } from "./Counter.efx"
```

This is the Vue/Astro convention (Vue requires `.vue` in
imports, Astro requires `.astro`). It's the reason the demo
project has no sibling `.ts` files: with explicit extensions in
import paths, no auxiliary on-disk shim is needed for tsc to
find one `.efx` file from another.

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
[`@efx/compiler` AGENTS.md → "Source-map mappings"](../compiler/AGENTS.md#source-map-mappings--typed-sourcegenerated-spans)
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
`( : numbern)`. Both `@efx/compiler` and `@efx/ts-plugin` have
tests pinning this exact case.

`convertSourceMap` just copies the lengths through — the compiler
produces them.

## The registry is per-consumer state

`virtual-code.ts` exports `VirtualCodeRegistry` — a class holding a
`Map<string, EfxVirtualCode>`. The host that constructs the plugin
also constructs the registry and passes it to `createEfxLanguagePlugin`:
`@efx/ts-plugin` creates one at module scope (tsserver loads the
plugin once per session), `@efx/check` creates one inside each
`runCheck` call.

The plugin writes into the registry from `createVirtualCode`;
ts-plugin's `jsx-tags.ts` reads from it to fetch `jsxRanges` for
tag-pair document highlights. The instance Volar holds (as the
return value of `createVirtualCode`) is the same instance the
registry holds — no duplication, no synchronization needed. Volar
consumes the `mappings` array directly via its own `SourceMap`
indexing, so source ↔ generated offset translation never goes
through this cache.

In tsserver, the registry lives for the editor session. In
`efx-check`'s CLI, each `runCheck` call owns its own — repeated
in-process invocations don't see each other's virtual codes.
There's no cross-process sharing — Map state is per-Node-process.

If `createVirtualCode` is called twice for the same `.efx` (rapid
edits), the entry is overwritten with a fresh `EfxVirtualCode`.
Stale entries for files that have been deleted persist until the
registry is dropped; that's fine in practice.

### Why a per-consumer registry, not a module-level singleton

Earlier versions kept the cache as a module-level `Map`. That tied
the cache lifetime to module-load (i.e. process lifetime), so two
`runCheck` calls in one Node process would share entries — including
stale ones from a previous run. Threading a `VirtualCodeRegistry`
through the factory makes the lifetime explicit and matches what each
consumer actually wants. The registry deliberately exposes only
`get` and `set` — `clear` was considered and dropped because no
caller needs it (consumers throw the whole registry away).

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
  `CompilerMapping[]` the compiler produces (it has both source
  and generated lengths plus a kind tag, ready for translation to
  Volar shape). `jsxRanges` is also consumed but only for
  `EfxVirtualCode.jsxRanges` (used by `@efx/ts-plugin/jsx-tags.ts`
  for opening↔closing tag-pair document highlights), not for
  position translation.
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
- Don't reintroduce a module-level singleton cache. The registry
  is per-consumer on purpose: in one Node process, multiple
  `runCheck` calls (and theoretically multiple tsserver-plugin
  setups) must not share virtual-code state. If you add a new
  consumer, give it its own `VirtualCodeRegistry`.
- Don't add a `clear` (or `delete`) method to `VirtualCodeRegistry`
  without a real caller. Consumers throw the whole registry away;
  growing the surface invites resurrection of stale-state bugs.
- Don't switch `EfxVirtualCode`'s constructor to parameter
  properties (`constructor(readonly source: string, ...)`). They
  desugar into field assignments and break Node's
  `--experimental-strip-types` mode — see the "Parameter properties
  are deliberately avoided" note above.
- Don't import this package from `@efx/runtime` or `@efx/compiler`.
  The dependency direction is one-way: `language` consumes
  `compiler`. Reversing it would create a cycle.

## Tests

In-package vitests:

- `src/source-map.test.ts` — pins the bidirectional source/generated
  position-mapping contract through `convertSourceMap`.
- `src/virtual-code-registry.test.ts` — pins the per-consumer
  isolation of `VirtualCodeRegistry` (two plugins, two registries,
  no cross-pollination).

Broader behavior is covered by:

- `@efx/ts-plugin/test/integration.mjs` — exercises the LanguagePlugin
  through a real tsserver subprocess.
- `@efx/check/test/integration.mjs` — exercises it through
  `@volar/kit`.

If you need more fine-grained tests, follow the existing pattern
(`src/*.test.ts` + the shared `vitest.config.ts`).

## Related context

- Root [`AGENTS.md`](../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing.
- [`@efx/compiler`](../compiler/AGENTS.md) — source location
  preservation and `JsxRange` emission this package depends on.
- [`@efx/ts-plugin`](../ts-plugin/AGENTS.md) — tsserver consumer.
- [`@efx/check`](../check/AGENTS.md) — kit consumer.
