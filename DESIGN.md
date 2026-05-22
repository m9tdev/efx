# DESIGN — efx

Architecture reference for the framework as it stands. For an entry point
and quick start, see [README.md](./README.md).

---

## 0. Thesis

A component produces a value of type `Effect<View, E, R>`. When components
compose into a tree, the parent's effect row is the **union of children's
`E`s** and the **union of children's `R`s** (Effect represents requirements
as a union type). At the root, a `Layer` must satisfy the entire `R` of the
program. **Forgetting to provide a service, or to handle a tagged error,
becomes a compile-time error that names the missing thing.**

Every layer of the tree participates in Effect's algebra. There is no
`JSX.Element`-shaped barrier anywhere.

## 1. Why JSX is fundamentally out

TypeScript's type checker hardcodes JSX semantics:

- For `<Foo />`, the expression's type is `JSX.Element` from the global
  `JSX` namespace — **regardless** of what `Foo` returns.
- The component's actual return type is only checked for assignability to
  `JSX.Element`; it does not propagate to the expression's type.
- `jsxFactory`/`jsxFragmentFactory` only affect *emit*. `JSX.Element` cannot
  be parameterized over the component, and TS's type-checker treats every
  JSX expression as having that single type.

So as long as TypeScript sees angle brackets, channels collapse. Two
consequences:

1. The runtime's public API is plain function calls — `h(tag, props, …children)`.
   Standard generic inference on `h`'s signature is what makes channels
   fold.
2. Angle-bracket aesthetics are recovered via a custom `.efx` file extension
   compiled by Babel to plain TypeScript **before tsc ever sees the
   source**. Babel rewrites every `JSXElement` / `JSXFragment` into a
   `CallExpression` against `h`. No JSX nodes survive the compile.

---

## 2. Packages

```
packages/
  runtime/      View IR, h() factory, mount(), reactivity bindings
  compiler/     .efx → .ts source transformer + CLI
  vite-plugin/  Vite integration
apps/
  demo/         Counter, UserPage, LiveUser, Todos
refs/           Cloned reference repos (effect-smol, solid, vite-plugin-svelte) — gitignored
```

The framework's *build* surface is ~900 LOC across runtime + compiler +
plugin. Everything that's not view-tree mechanics is consumed from
`effect@4.0.0-beta.70` (effect-smol).

---

## 3. The view layer

### 3.1 View IR

A discriminated union of what a component can produce, declared as a
`Data.TaggedEnum` so we get constructors, refinements, and `Match`
integration for free:

```ts
type View = Data.TaggedEnum<{
  Text:     { readonly value: string }
  Element:  { readonly tag: string; readonly props: Props; readonly children: ReadonlyArray<View> }
  Fragment: { readonly children: ReadonlyArray<View> }
  Reactive: { readonly source: Atom.Atom<unknown> | AtomRef.ReadonlyRef<unknown> }
  List:     { readonly source: AtomRef.Collection<unknown>; readonly render: (item, index) => unknown }
  Empty:    {}
}>
```

`Reactive` and `List` are the two "live" variants — `mount` subscribes to
their sources and patches the DOM in place on changes.

### 3.2 `h()` — the view factory

Public signature:

```ts
type HFn = <
  T extends string | ((props: any) => Effect.Effect<View, any, any>),
  Cs extends readonly unknown[],
>(
  tag: T,
  props: TagProps<T>,
  ...children: Cs
) => Effect.Effect<View, FoldE<Cs> | TagE<T>, FoldR<Cs> | TagR<T>>
```

Three conditional types do the work:

- `TagE<T>` / `TagR<T>` — when `T` is a component function `(props) => Effect<View, E, R>`,
  these extract its `E` and `R` so `h(Component, props)` contributes them
  to the surrounding expression's type. For string tags they evaluate to
  `never`.
- `TagProps<T>` — when `T` is a component function, this is the component's
  expected props type (with `children` stripped). For string tags it's the
  loose `Readonly<Record<string, unknown>>`. This is what makes
  `<UserPage userId="42" />` type-check the prop name and value type, and
  `<UserPage userid="42" />` (typo) fail.
- `FoldE<Cs>` / `FoldR<Cs>` — distribute over the children tuple, peel
  every supported container layer (`Effect`, `Option`, `Result`, `Chunk`,
  `Stream`, `Atom`, `AtomRef`, `ReadonlyArray`, plus `false`/`null`/
  `undefined`-branch unions for `cond && …` / `cond ? a : b`), and union
  every extracted `E`/`R`.

The fold's correctness is locked in by
[`packages/runtime/src/types/Fold.test-d.ts`](packages/runtime/src/types/Fold.test-d.ts)
(positive cases for each container) and
[`apps/demo/src/channels.test-d.ts`](apps/demo/src/channels.test-d.ts)
(end-to-end propagation through real components + `@ts-expect-error`
negative cases for typed props).

### 3.3 Compiler-driven fine-grained reactivity: `h.track` / `h.read` / `h.peek`

The compiler wraps every JSX expression in `h.track(() => …)` and rewrites
two patterns inside:

- `x.value` (read) → `h.read(x)`
- bare identifier `x` in a *test position* (`x ? … : …`, `x && …`, `!x`)
  → `h.peek(x)`

Runtime behavior:

| Helper      | If arg is `AtomRef`             | If arg is anything else            |
|-------------|---------------------------------|------------------------------------|
| `h.track`   | (wraps thunk; see below)        | (wraps thunk; see below)           |
| `h.read`    | unwrap value, **track** it      | identity to `.value` access        |
| `h.peek`    | unwrap value, **track** it      | identity (return arg unchanged)    |

`h.track(thunk)` runs `thunk` in a module-level tracking scope. If no
`AtomRef` reads happened (`h.read`/`h.peek` saw no refs), the static
result is returned directly. If any reads happened, `h.track` returns a
derived `AtomRef` whose subscribers re-run the thunk on every dep change
— deps are re-collected fresh on each run, so a ternary's "other branch"
reading different refs Just Works.

Type-wise, `h.read` is overloaded to preserve the receiver's `.value`
type:

```ts
function read<T>(obj: AtomRef.ReadonlyRef<T>): T
function read<T extends { readonly value: any }>(obj: T): T["value"]
```

So `s.value.bio` (where `s` is `AsyncResult.Success`) compiles to
`h.read(s).bio` and TS still sees `bio` correctly typed against the
Success payload.

The user-facing payoff: this works.

```tsx
const loading = AtomRef.make(false)

<div>
  {loading ? <Spinner /> : <Content />}      {/* bare ref in test pos */}
  <p class={loading ? "muted" : ""}>…</p>    {/* same in attr pos */}
  <span>{count.value}</span>                  {/* explicit .value */}
</div>
```

### 3.4 `mount()`

```ts
declare function mount<E, R>(
  app: Effect.Effect<View, E, R>,
  el: HTMLElement,
): Effect.Effect<void, E, R | AtomRegistry | Scope>
```

Runs the app's Effect inside a `Scope`, walks the resulting `View` tree
synchronously to build DOM, and wires subscriptions for the reactive
variants:

- **`View.Reactive`** — subscribes via `AtomRef.subscribe(cb)` or
  `AtomRegistry.subscribe(atom, cb)`. The render callback rebuilds the
  subtree for the new value and replaces the previous DOM node.
- **`View.List`** — reconciles by `AtomRef` identity. Maintains a
  `Map<AtomRef, Rendered>` keyed by ref; on collection change, drops
  rows whose ref is gone, builds rows for new refs, repositions
  existing rows in their new order. Per-item value changes are picked
  up by the rows' own `Reactive` bindings, not by re-rendering the row.

DOM event listeners and subscriptions are torn down via the surrounding
`Scope`. Mounting in production looks like:

```ts
const program = Effect.gen(function* () {
  yield* mount(<App />, rootEl)
  yield* Effect.never        // keep scope alive for the page's lifetime
}).pipe(
  Effect.scoped,
  Effect.catchCause(cause => Effect.sync(() => console.error(Cause.pretty(cause)))),
  Effect.provide(Layer.mergeAll(EfxLive, HttpLive, ThemeLive, …)),
)
Effect.runFork(program)
```

---

## 4. The reactivity layer

We consume — we don't build — `effect/unstable/reactivity`. The framework's
runtime knows how to **recognize** these types in child/attribute positions
and **subscribe** appropriately. The dependency-tracking, equality, and
invalidation logic is Effect's.

| Primitive               | What it is                                                                                | Where it appears                            |
|-------------------------|-------------------------------------------------------------------------------------------|---------------------------------------------|
| `AtomRef<T>`            | Sync mutable signal. `.value`, `.subscribe(cb)`, `.set`, `.update`, `.map`, `.prop`        | Component-local state                       |
| `AtomRef.ReadonlyRef<T>`| Read-only view (`.map(f)` returns this)                                                   | Derived values                              |
| `AtomRef.Collection<T>` | Reactive collection of `AtomRef<T>` items                                                 | Keyed reactive lists via `list(coll, …)`    |
| `Atom<T>`               | Declarative reactive value with automatic dep tracking via `AtomRegistry`                 | Atom-runtime-backed queries                 |
| `AtomRegistry`          | `Context.Service` holding the atoms' dep graph and cache                                  | Provided at root via `EfxLive` layer       |
| `AsyncResult<A, E>`     | `Initial` / `Success` / `Failure` + `waiting` overlay; idiomatic shape for async UI state | Returned by `Atom`s wrapping `Effect`s      |

The framework's reactive paths are minimal glue:

- `h()`'s `normalizeChild` sees an `Atom`/`AtomRef`/`Collection` in child
  position and emits the corresponding IR node.
- `mount`'s `applyProp` sees a `ReadonlyRef` in attribute position and
  subscribes; updates re-run `applyProp` recursively with the new value.
- `valueToView` auto-`runSyncExit`s any `Effect<View, never, never>`
  encountered as a reactive source value, so `Atom.map(AsyncResult.match({…}))`
  can return JSX (which compiles to `Effect<View>`) directly.

---

## 5. The compiler

### 5.1 Pipeline per `.efx` file

```
.efx source
  ↓ @babel/parser  (tsx + typescript plugins)
AST
  ↓ traverse + rewrites
AST (plain TS, no JSX)
  ↓ @babel/generator + sourcemaps
.ts code + source map
```

Babel is used **as a parser only**. We do *not* use `@babel/preset-react`
or any built-in JSX-to-`React.createElement` transform — we own the
rewrites.

### 5.2 Rewrites

| Source                              | Output                                                          |
|-------------------------------------|-----------------------------------------------------------------|
| `<tag attr="x">…</tag>`             | `h("tag", { attr: "x" }, …)`                                    |
| `<Component prop={v} />`            | `h(Component, { prop: h.track(() => v) })`                      |
| `<>…</>`                            | `h(Fragment, {}, …)`                                            |
| `{expr}` (JSX expression child)     | `h.track(() => exprRewritten)`                                  |
| `{expr}` (JSX attribute value)      | `h.track(() => exprRewritten)`                                  |
| `x.value` (inside a tracked expr)   | `h.read(x)`                                                     |
| bare `x` in test pos of `?:`/`&&`/`!` | `h.peek(x)`                                                   |
| `data-foo="x"`                      | `{ ["data-foo"]: "x" }`                                         |

The `.value` and identifier rewrites are limited to expressions inside
`JSXExpressionContainer` nodes — code in arrow bodies, statements, or
module top-level is untouched.

### 5.3 CLI: `efx-compile`

Walks a directory, compiles every `.efx` file to a sibling `.ts` file
with a `// @generated` banner. The demo's `pnpm typecheck` runs
`efx-compile src` and then `tsc --noEmit` over the result.

### 5.4 Vite plugin

A `transform` hook intercepts `.efx` files in dev:

```ts
export function efx(): Plugin {
  return {
    name: "vite-plugin-efx",
    enforce: "pre",
    config() {
      return { esbuild: { include: [/\.efx$/, /\.tsx?$/], loader: "ts" } }
    },
    async transform(code, id) {
      if (!EFX_RE.test(id)) return null
      const { code: out, map } = transformEfx(code, id)
      return { code: out, map: map as never }
    },
  }
}
```

`esbuild.include` is widened to make Vite's built-in TS-stripping pipeline
run over `.efx` files too — the compiler's output is plain TypeScript, and
esbuild strips types the same way it does for any `.ts` file.

`resolve.extensions: [".efx", ".ts", …]` in the demo's `vite.config.ts`
makes Vite prefer `.efx` over the auto-generated `.ts` siblings when
resolving extensionless imports. tsc, which doesn't know about `.efx`,
naturally resolves the same imports to the `.ts` files. Both toolchains
see the same code; only the source-of-truth differs.

---

## 6. What's verified

The acceptance criteria the POC sets out to deliver, each tied to a
test or probe:

| Claim                                                                       | Evidence                                                          |
|-----------------------------------------------------------------------------|-------------------------------------------------------------------|
| Channel fold over containers (Effect, Option, Result, Chunk, Stream, Atom, AtomRef, arrays, `false`-branch unions, ternary unions) | `packages/runtime/src/types/Fold.test-d.ts`                       |
| End-to-end propagation through composed components + conditional + list     | `apps/demo/src/channels.test-d.ts`                                |
| Typed props at JSX call sites (missing, typo, wrong type, excess)           | `apps/demo/src/channels.test-d.ts` (`@ts-expect-error` cases)     |
| Removing a `Layer` from the root surfaces as TS error naming the service    | Manual probe: `Type 'Http' is not assignable to type 'never'`     |
| Browser renders identical output from `.efx` sources                        | `scripts/probe.mjs`, `scripts/probe-liveuser.mjs`, `scripts/probe-todos.mjs` |
| `AtomRef` updates patch only affected DOM (no full rebuild)                 | `scripts/probe-todos.mjs` tags row 1's DOM node and verifies survival across row 2 toggle |
| `Atom`+`AsyncResult` cycles `Initial`/`Success`/`Failure` states correctly  | `scripts/probe-liveuser.mjs`                                      |
| Keyed list adds/removes rows without rebuilding siblings                    | `scripts/probe-todos.mjs`                                         |
| Vite HMR on `.efx` edits                                                    | `scripts/probe-hmr.mjs`                                           |
| Zero JSX-related TS diagnostics                                             | `pnpm -r typecheck` — clean across workspace                      |

---

## 7. Known limits

### 7.1 No IDE diagnostics on `.efx` source

VS Code / tsserver don't know about `.efx`. Errors only surface via
`pnpm typecheck` (which compiles to `.ts` first). A real product would
ship a tsserver language-service plugin that runs the compiler in-memory
and feeds the transformed source to tsserver. That's a 1–2 day project
and was out of POC scope.

### 7.2 Sourcemap fidelity

Babel emits sourcemaps that Vite consumes — runtime errors in the browser
devtools map back to `.efx` lines. But `tsc` runs on the emitted `.ts`
without composing source maps, so type errors point at `.ts` line numbers
rather than `.efx`. Acceptable for POC.

### 7.3 Generic components don't survive JSX call sites

A component declared as `<T>(props: {item: T}) => …` loses its `T` when
called as `<MyComp item={x} />` — this is the same higher-rank
polymorphism limit React/Solid hit. The workaround is what `list(coll, render)`
does: keep generics on a regular function whose call site preserves `T`,
and accept a function child instead of a JSX `<List<T>>` tag.

### 7.4 `.value` rewrite is universal inside JSX expressions

Every `x.value` access inside a `JSXExpressionContainer` is rewritten to
`h.read(x)`. For non-ref receivers `h.read` returns `x?.value` (same
semantics as plain `.value`), so it doesn't break — but destructuring
(`const {value} = ref`) is missed (it's not a MemberExpression). Document
the pattern; rely on `.value` reads as the idiom.

### 7.5 HMR doesn't preserve component state

Editing `Counter.efx` re-evaluates the module and resets `count` to `0`.
Real HMR-state-preservation needs `import.meta.hot.accept` plumbing in
the generated code, which we don't emit. Out of POC scope.

### 7.6 Intrinsic-element attributes are loose

`<div xyzzy="foo">` compiles fine — `TagProps<string>` is the loose
`Record<string, unknown>` rather than a typed HTML attribute map. The
symmetric improvement to typed component props would be threading
`JSX.IntrinsicElements`-style typing here. Real but not POC-critical.

### 7.7 `effect/unstable/reactivity` is unstable

Per effect-smol's migration notes, modules under `effect/unstable/*` can
receive breaking changes in minor releases. We pin a specific beta and
accept the maintenance cost.

---

## 8. Conventions

- **`.efx` files are the source of truth.** The sibling `.ts` files emitted
  by `efx-compile` are build artifacts (gitignored). Never edit a generated
  `.ts` by hand.
- **Imports between source files use extensionless paths.** `import { Foo } from "./Foo"`.
  Vite resolves to `.efx` (via `resolve.extensions`); tsc resolves to the
  generated `.ts`.
- **Components take a single props object.** Even if empty:
  `Effect.fn("Name")(function* (_props: {} = {}) { … })`. This is what
  makes `<Name />` JSX compile to `h(Name, {})` and have h's `tag-as-function`
  path call it correctly.
- **Effects use `Effect.fn("Name")(function* (props) { … })`**, not
  `(props) => Effect.gen(function* () { … })`. The former gives names and
  spans to the resulting Effect; the v4 docs recommend it.
- **Layers use `Context.Service`** (v4 syntax), errors use
  `Data.TaggedError` (or `Schema.TaggedError` when schema-aware).

---

## 9. Mapping to Effect v4 primitives — what we build vs consume

| Concept                              | Primitive                                                | Built | Consumed |
|--------------------------------------|----------------------------------------------------------|:-----:|:--------:|
| Component                            | `Effect.fn("Name")(function*(){})`                        |       |    ✓     |
| Component composition                | `Effect.gen` + `yield*`                                   |       |    ✓     |
| Service / requirement (R)            | `Context.Service<Self, Shape>()("id")`                    |       |    ✓     |
| Tagged error (E)                     | `Data.TaggedError` / `Schema.TaggedError`                 |       |    ✓     |
| Layer (root provisioning)            | `Layer.mergeAll`, `Effect.provide`                        |       |    ✓     |
| Local component state                | `AtomRef.make(initial)`                                   |       |    ✓     |
| Derived state                        | `ref.map(f)` / `ref.prop(key)` / `Atom.readable`          |       |    ✓     |
| Async data state                     | `Atom` wrapping an `Effect` → `AsyncResult<A, E>`         |       |    ✓     |
| Reactive dependency graph            | `AtomRegistry`                                            |       |    ✓     |
| Resource cleanup on unmount          | `Effect.acquireRelease` + `Scope`                         |       |    ✓     |
| Reactive collection                  | `AtomRef.collection`                                      |       |    ✓     |
| View IR                              | `Data.TaggedEnum`                                         |   ✓   |          |
| `h()` factory + channel fold types   | `FoldE` / `FoldR` / `TagE` / `TagR` / `TagProps`          |   ✓   |          |
| `h.track` / `h.read` / `h.peek`      | tracking scope + AtomRef-aware accessors                  |   ✓   |          |
| `mount()`                            | DOM walker + reactive subscriptions + list reconciler     |   ✓   |          |
| `.efx` source transformer            | Babel-AST rewrite (compiler package)                      |   ✓   |          |
| Vite integration                     | Plugin with `transform` hook                              |   ✓   |          |

The "Built" column is intentionally small. The POC's job is the
load-bearing type fold and a thin DOM/reactivity adapter, not a new
reactive system or a new effect runtime.
