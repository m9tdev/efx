# effx — Effect-native UI framework POC

A proof-of-concept that an Effect-style algebra (`Effect<A, E, R>`) can survive
through a UI component tree from leaf to root, in current TypeScript, without
any host-language changes. The framework's name is **effx**.

---

## 0. What we're trying to prove

Components produce values of type `Effect<View, E, R>`. When composed, the
parent's effect row is the **union of children's E channels** and the
**intersection of children's R channels**. At the root, a `Layer` must be
provided that satisfies the entire program's `R`. Forgetting a service or
failing to catch an error becomes a **compile-time error that names the
missing thing**.

The novel claim: every layer of the UI tree participates in Effect's algebra,
with no `JSX.Element`-shaped barrier anywhere.

## 1. Why JSX is fundamentally out

TypeScript's type checker hardcodes JSX semantics:

- For `<Foo />`, the expression's type is `JSX.Element` from the global `JSX`
  namespace, **regardless** of what `Foo` returns.
- The component's actual return type is only checked for assignability to
  `JSX.Element`; it does not propagate.
- `jsxFactory` only affects emit. `JSX.Element` cannot be made
  generic-over-the-component.

So as long as TypeScript sees angle-bracket syntax, channels get erased.
**TypeScript must never see JSX in our pipeline.** Two consequences:

1. The runtime API is plain function calls: `h(tag, props, ...children)`.
   Generic inference works normally on `h`'s signature, so channels fold
   correctly.
2. If we want angle-bracket aesthetics, we need a **real source-to-source
   transformer** that rewrites JSX-shaped syntax in `.efx` files into `h()`
   call expressions **before** TypeScript ever sees the source.

---

## 2. Phases

### Phase 1 — Prove the type story (plain TS, no syntax sugar)

Goal: make channel propagation visible and enforced in current TypeScript,
demo written in plain `h()` calls.

### Phase 2 — Add `.efx` source transformer (Babel-based)

Goal: angle-bracket syntax for the same semantics. Pure ergonomics layer.

Phase 2 is conceptually unblocked by phase 1: phase 1's `h()` signature is
exactly what phase 2 emits to.

---

## 3. Phase 1 architecture

### Packages

```
playground/
├─ packages/
│  ├─ runtime/         # h(), mount(), View IR, channel-fold types, reactivity
│  └─ effx/            # umbrella: re-exports runtime + effect-smol bits
├─ apps/
│  └─ demo/            # demo app in plain TS using h()
└─ refs/               # cloned references (effect-smol, solid, vite-plugin-svelte)
```

### View IR

A discriminated union of what a component can produce. Use `Data.TaggedEnum`
from effect so we get constructors, refinements, and pattern matching for
free:

```ts
import { Data } from "effect"

type View = Data.TaggedEnum<{
  Text:     { readonly value: string }
  Element:  { readonly tag: string; readonly props: Props; readonly children: ReadonlyArray<View> }
  Fragment: { readonly children: ReadonlyArray<View> }
  Reactive: { readonly source: Atom<View> | AtomRef<View> }    // reactive binding
  Empty:    {}                                                  // for false/null/undefined children
}>
const View = Data.taggedEnum<View>()
```

### `h()` signature (the load-bearing piece)

```ts
type Child =
  | Effect<View, any, any>
  | View
  | string | number | boolean | null | undefined
  | Option<Child>
  | Either<any, Child>
  | Chunk<Child>
  | Stream<Child, any, any>
  | AtomRef<Child>          // sync reactive — direct subscribe
  | Atom<Child>             // declarative reactive — via AtomRegistry
  | readonly Child[]

declare function h<Cs extends readonly Child[]>(
  tag: string | ((props: any) => Effect<View, any, any>),
  props: Props,
  ...children: Cs
): Effect<View, FoldE<Cs>, FoldR<Cs> | AtomRegistry>
//                          ^^^^^^^^^^^^^^^^^^^^^^^^^
// If any child is reactive, the result requires AtomRegistry in R.
```

### `FoldE` / `FoldR` — the type-level fold

Conditional types that walk the children tuple and union/intersect channels.
Handle each container shape:

- `Effect<_, E, R>`              → contribute `E`/`R`
- `Option<T>` / `Either<_, T>`   → recurse into `T`
- `Chunk<T>` / `Stream<T, E, R>` → recurse into `T`, union `E`/`R`
- `T | false | null | undefined` → drop the unit branches, recurse
- `readonly T[]`                 → recurse into element type
- primitives                     → contribute nothing
- union types                    → distribute the fold across branches

Approx 100 lines of conditional types. This is the bit that's expected to be
fiddly; getting it tight and testing it with `tstyche` or expect-type
assertions is part of phase 1.

### Reactivity model — consume effect-smol's `unstable/reactivity`

**We don't build a reactivity system.** effect-smol ships a complete one in
`effect/unstable/reactivity`. We just consume it.

The core (`Atom`, `AtomRef`, `AtomRegistry`, `AsyncResult`, `Reactivity`) is
**framework-agnostic** — verified by inspection: zero React/DOM imports, only
imports from Effect itself. The popular `@effect-atom/atom-react` package is a
*separate* React-hooks adapter built on top of those same primitives. Our
`mount()` is the moral equivalent of that adapter, but for direct DOM
bindings instead of React hooks.

The primitives we use directly:

| Primitive | Role | API surface we depend on |
|---|---|---|
| `AtomRef<A>`  | Local mutable state (Solid-signal equivalent)  | `.value` (sync read), `.subscribe(f)` (sync callback), `.set`, `.update`, `.map`, `.prop` |
| `Atom<A>`     | Declarative reactive — automatic dependency tracking via `AtomRegistry` | `Atom.make`, `Atom.readable`, `Atom.writable`, the registry tracks deps |
| `AtomRegistry`| `Context.Service` holding atoms' current values & the dep graph | Provided by `Layer` at the root; required by `h()` whenever any reactive child is present |
| `AsyncResult<A, E>` | UI-friendly async state — `Initial \| Success \| Failure` + a `waiting` overlay flag | Returned by `Atom`s wrapping `Effect`s; perfect for fetch states |

Why this is right for us:

- **Sync subscribe**: `AtomRef.subscribe(callback)` is a synchronous, fire-on-change callback — no Stream/PubSub plumbing required at the binding layer. Equality-aware: writes that produce an `Equal.equals` value don't notify.
- **Automatic dep tracking**: `Atom`s read other atoms during their compute function; the registry records dependencies as a side effect of those reads. No FiberRef/Context.Reference scope needed.
- **Async out of the box**: an `Atom` wrapping an `Effect` reads as `AsyncResult<A, E>` — render `Initial`/`Success`/`Failure` with `.match` and you have loading/success/error states for free.
- **Lifecycle via registry**: atoms are disposed when no longer observed; the registry handles cleanup. No manual subscription bookkeeping in `mount`.

What `h()` does with reactive children: when it encounters an `AtomRef<T>` or
`Atom<T>` in the children tuple, it emits a `View.Reactive` node into the IR.
At DOM build time, `mount` subscribes that DOM subtree to the source and
patches when the source notifies. The subscription is scoped to a `Scope`,
which closes on unmount.

For derived/computed values inside a component, just compose atoms — no
custom memoization layer:

```ts
const userName  = AtomRef.make("alice")
const greeting  = userName.map(n => `Hello, ${n}`)   // ReadonlyRef<string>, auto-derived
```

### `mount()`

```ts
declare function mount<E, R>(
  app: Effect<View, E, R>,
  el: HTMLElement
): Effect<void, E, R | AtomRegistry | Scope>
```

Runs the Effect in a `Scope`, walks the resulting `View` tree, builds DOM
nodes, and subscribes any `View.Reactive` bindings (via `AtomRef.subscribe`
or by reading through the `AtomRegistry`). Subscriptions and DOM event
listeners are registered via `Effect.acquireRelease` so they auto-cancel
when the scope closes (unmount).

The full Effect is what you `Effect.provide()` a `Layer` to and then
`Effect.runPromise`. The Layer must satisfy `R + AtomRegistry`.

### Phase 1 demo (plain TS, intentionally ugly)

Services and errors use Effect v4 idioms — `Context.Service` and
`Schema.TaggedError`:

```ts
import { Context, Effect, Layer, Schema } from "effect"

class HttpError extends Schema.TaggedError<HttpError>()("HttpError", {
  status:  Schema.Number,
  message: Schema.String,
}) {}

class Http extends Context.Service<Http, {
  readonly get: <A>(url: string) => Effect.Effect<A, HttpError>
}>()("demo/Http") {}

class Theme extends Context.Service<Theme, {
  readonly mode: "light" | "dark"
}>()("demo/Theme") {}

const UserPage = Effect.fn("UserPage")(function* (userId: string) {
  const http  = yield* Http
  const theme = yield* Theme
  const user  = yield* http.get<User>(`/users/${userId}`)

  return yield* h("div", { class: `page ${theme.mode}` },
    h("h1", {}, user.name),
    user.bio && h("p", { class: "bio" }, user.bio),
    user.posts.length > 0
      ? h("ul", {}, user.posts.map(p => h("li", {}, p.title)))
      : h("p", {}, "No posts yet.")
  )
})
// inferred: Effect<View, HttpError, Http | Theme>
```

Ugly but the channels propagate, and hover-tooltip on `UserPage` shows the
inferred `E` and `R`. That's the whole proof.

A reactive variant (counter on the same page) uses `AtomRef` directly:

```ts
const Counter = Effect.fn("Counter")(function* () {
  const count = AtomRef.make(0)
  return yield* h("button",
    { onClick: () => count.update(n => n + 1) },
    "clicked ", count, " times"   // AtomRef<number> in child position → reactive binding
  )
})
// inferred: Effect<View, never, AtomRegistry>
```

---

## 4. Phase 2 architecture — `.efx` source transformer

### Goal

Let authors write the demo above as:

```tsx
const UserPage = (userId: string) => Effect.gen(function* () {
  const user = yield* Http.get<User>(`/users/${userId}`)
  const theme = yield* Env.get(Theme)

  return yield* (
    <div class="page">
      <h1>{user.name}</h1>
      {user.bio && <p class="bio">{user.bio}</p>}
      {user.posts.length > 0
        ? <ul>{user.posts.map(p => <li>{p.title}</li>)}</ul>
        : <p>No posts yet.</p>}
    </div>
  )
})
```

Identical semantics, identical inferred type — TypeScript still sees only
`h()` call expressions because the compiler rewrites JSX before TS gets the
file.

### Source transformer (Babel as parser, NOT as JSX transform)

We use `@babel/parser` solely because it parses TS + angle-bracket syntax
into a documented AST. We do **not** use `@babel/preset-react` or any
JSX-to-`React.createElement` transform — we write our own AST visitor that
turns every `JSXElement` / `JSXFragment` / `JSXExpressionContainer` node
into a `CallExpression` representing `h(tag, props, ...children)`.

Pipeline per `.efx` file:

1. **Parse** with `@babel/parser`, plugins `["typescript", "jsx"]`.
2. **Walk AST** with `@babel/traverse`; replace JSX nodes with call expressions.
3. **Generate** with `@babel/generator` — emit as plain TS (no JSX
   remaining). Output extension is `.ts` for the toolchain.
4. **Emit sourcemap** so diagnostics on the emitted TS map back to `.efx` lines.

### Vite plugin

```ts
export function efx(): Plugin {
  return {
    name: "vite-plugin-efx",
    enforce: "pre",
    resolveId(id) { /* resolve .efx imports */ },
    load(id) { /* read .efx files */ },
    transform(code, id) {
      if (!id.endsWith(".efx")) return null
      const { code: out, map } = transformEfx(code, id)
      return { code: out, map }
    },
  }
}
```

### IDE/tsserver story

For the POC, we punt on full IDE integration:

- `tsc` works on the **emitted** `.ts` (post-transform). Errors are real,
  channels are inferred correctly, sourcemaps map them back to `.efx`.
- VS Code sees `.efx` as a plain text file initially. We can add a basic
  language extension later that highlights syntax and runs the transformer
  in the background.
- A full tsserver language-service plugin (so `.efx` gets live diagnostics
  while editing) is **out of scope for the POC**. It would be the obvious
  next step after proving the rest works.

### Sourcemap strategy

Babel's generator emits source positions. Vite consumes those. We don't need
anything fancy — Babel's standard sourcemap output is sufficient as long as
we don't elide nodes silently.

---

## 5. Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| Effect substrate | `effect@beta` (4.0.0-beta.70+) | Effect v4 = effect-smol, published on npm under `effect@beta` |
| Local signal primitive | `AtomRef` from `effect/unstable/reactivity` | Sync `.value` + sync `.subscribe(cb)`; equality-aware; ships `.map`/`.prop` for derived/nested refs |
| Declarative signal | `Atom` + `AtomRegistry` from `effect/unstable/reactivity` | Auto dep-tracking via registry-mediated reads; the framework consumes this rather than building its own tracker |
| Async UI state | `AsyncResult<A, E>` from `effect/unstable/reactivity` | `Initial`/`Success`/`Failure` + `waiting` overlay; pattern-match for loading/data/error |
| Services | `Context.Service` (v4) | Replaces v3 `Context.Tag`; cleaner class syntax |
| Errors | `Schema.TaggedError` | Yieldable, schema-aware, integrates with `Cause` |
| Tagged unions (View IR) | `Data.TaggedEnum` | Constructors, refinements, `Match` integration for free |
| Subscription lifecycle | `Effect.acquireRelease` + `Scope` | Auto-cleanup on unmount; standard Effect resource discipline |
| List primitive | `Chunk` from effect-smol | Native to Effect, persistent, has `.map`/`.flatMap` |
| Stream primitive | `Stream` from effect-smol | Native to Effect, composes with all of the above |
| Bundler / dev | Vite | Workspace standard; Svelte's plugin is good reference |
| Package manager | pnpm workspaces | Lightweight; supports the monorepo |
| Compiler parser | `@babel/parser` (phase 2 only) | Best-documented TS+JSX AST; we use it as a parser, not for its built-in JSX transform |
| Type assertions in tests | `tstyche` or `expect-type` | Phase 1's channel-fold types need positive/negative type tests |
| Demo data source | mocked `Http` Layer | No network required; demonstrates Layer mechanics |

---

## 5b. Framework concepts → Effect v4 primitives

A cheat-sheet for what we consume vs. what we build. **The framework is mostly thin glue over Effect v4.**

| Framework concept | Effect v4 primitive | We build | We consume |
|---|---|---|---|
| Component | `Effect.fn("Name")(function*(){})` |  | ✓ |
| Component composition | `Effect.gen` + `yield*` |  | ✓ |
| Service / requirement (R) | `Context.Service<Self, Shape>()("id")` |  | ✓ |
| Tagged error (E) | `Schema.TaggedError` |  | ✓ |
| Layer (root provisioning) | `Layer.mergeAll`, `Effect.provide` |  | ✓ |
| Local component state | `AtomRef.make(initial)` |  | ✓ |
| Derived state | `ref.map(f)` / `ref.prop(key)` / `Atom.readable` |  | ✓ |
| Async data state (loading/success/error) | `Atom` wrapping an `Effect` → `AsyncResult<A, E>` |  | ✓ |
| Pattern-match async state | `AsyncResult.match` / `AsyncResult.matchWithWaiting` |  | ✓ |
| Reactive dependency graph | `AtomRegistry` |  | ✓ |
| Resource cleanup on unmount | `Effect.acquireRelease` + `Scope` |  | ✓ |
| Reactive list of items | `AtomRef.collection` (typed iterable of `AtomRef<A>`) |  | ✓ |
| Streamed children | `Stream<View, E, R>` |  | ✓ |
| Conditional render | `Option<View>` + `Option.match`, or `false`/`null` in child slot |  | ✓ |
| Either-branch render | `Either<View, View>` + `Either.match` |  | ✓ |
| List render | `Chunk<View>` + `Chunk.map` |  | ✓ |
| View IR | `Data.TaggedEnum` | ✓ |  |
| `h()` factory | conditional-type fold over children tuple | ✓ |  |
| `mount()` | walks View IR → DOM, wires subscriptions via Scope | ✓ |  |
| `.efx` source transformer | Babel-AST rewrite (phase 2) | ✓ |  |

The "We build" column is intentionally small. The POC's job is the load-bearing
type fold + a DOM walker, not a reactive system or a service container.

---

## 6. Risks and open questions

### R1. Conditional-type fold complexity
`FoldE`/`FoldR` over union types with container peeling tends to hit TS's
inference limits. We may need to split into smaller named types and use
`infer` strategically. Worst case: support only the most common containers
(Effect, Option, primitives, arrays) in phase 1 and add Stream/Chunk/Either
in a follow-up.

### R2. `unstable/reactivity` is unstable
`Atom` / `AtomRef` / `AtomRegistry` live under `effect/unstable/reactivity`
in v4 beta. Per the migration notes, unstable modules can receive breaking
changes between minor releases. We accept this risk for the POC — pin the
exact beta and document the import path; bumping later is mechanical.

### R3. Sourcemap fidelity through Babel → Vite → tsc
Three sourcemap consumers in a chain. Likely fine but not battle-tested.
Risk lives only in phase 2.

### R4. `.efx` parser in TS+JSX-shape — is the surface a strict subset of TSX?
Yes, intentionally. `.efx` *looks like* TSX but is semantically `.ts + h()`.
If we need novel syntax later (e.g., signal sigils, `$:` reactive
declarations), we can extend the AST visitor — but that's beyond POC.

### R5. effect-smol API drift during beta
Locked to a specific beta version in the workspace; bump deliberately.

---

## 7. Acceptance criteria

### Phase 1 (must pass before phase 2 begins)

- [ ] `pnpm typecheck` passes on the runtime package
- [ ] `h(...)` builds a `View` tree with channels propagating per a documented
      test matrix (positive + negative `tstyche` cases for each container shape)
- [ ] Demo `UserPage` written in plain TS `h()` calls compiles
- [ ] Hovering `UserPage` in the IDE shows
      `Effect<View, HttpError, HttpSvc | Theme>` (or equivalently named types)
- [ ] Removing `HttpLive` from the root `Layer.mergeAll` produces a TS error
      that names `HttpSvc` (or the equivalent service tag)
- [ ] Forgetting to handle an error tag produces a TS error that names the tag
- [ ] `pnpm dev` opens the demo in a browser and the DOM renders
- [ ] `AtomRef.update` on the Counter component triggers a fine-grained DOM
      update (only the affected text node changes, verified in devtools)
- [ ] An `Atom` wrapping an `Effect` renders `AsyncResult` states correctly
      (loading → success / failure) without manual subscription code

### Phase 2 (when phase 1 passes)

- [ ] `.efx` files with TSX-shape syntax type-check via the emitted `.ts`
- [ ] The phase-1 demo rewritten in `.efx` syntax produces identical inferred
      types
- [ ] Sourcemaps point compile errors back to `.efx` lines
- [ ] Vite HMR works on `.efx` file edits
- [ ] No JSX-related TypeScript diagnostics anywhere in the project (no
      `Cannot find namespace 'JSX'`, etc.) — proves TS never sees JSX

---

## 8. What's explicitly out of scope (for now)

- Server/client split (RSC-like). Single client app only.
- Resumability / lazy chunks (Qwik-style).
- A real HTTP layer — we mock.
- A tsserver language-service plugin for live `.efx` diagnostics.
- Solid-level reactivity micro-optimization (we aim for "works"; "fastest"
  is later).
- Linear effect tracking for resources (`acquireRelease` works; lint-level
  enforcement comes later).
- Multi-app composition / module federation.
- Test runner choice for the demo (handled separately).

---

## 9. File-by-file build plan

Phase 1 build order, smallest-to-largest:

1. `packages/runtime/src/View.ts` — `Data.TaggedEnum` View IR (~30 lines)
2. `packages/runtime/src/types/Fold.ts` — `FoldE`/`FoldR`/`Child` conditional
   types (~100 lines), plus `tstyche` test file. Includes peeling of `AtomRef`/`Atom`.
3. `packages/runtime/src/h.ts` — `h()` implementation: normalize children into
   View nodes, emit `View.Reactive` for `AtomRef`/`Atom` children (~100 lines)
4. `packages/runtime/src/mount.ts` — DOM rendering + reactive subscriptions via
   `AtomRef.subscribe` and `AtomRegistry` reads, scoped via `Effect.acquireRelease` (~150 lines)
5. `packages/runtime/src/index.ts` — public exports + an `EfxLive` Layer that
   bundles `AtomRegistry.layer` and `Reactivity.layer`
6. `apps/demo/src/services.ts` — `Http` and `Theme` Context.Services + `HttpLive` Layer (~60 lines)
7. `apps/demo/src/UserPage.ts` — demo component using `Effect.fn` + plain `h()` calls (~80 lines)
8. `apps/demo/src/Counter.ts` — reactive demo via `AtomRef` (~30 lines)
9. `apps/demo/src/main.ts` — root composition + `mount` + `Effect.runPromise` (~30 lines)
10. `apps/demo/index.html` + `apps/demo/vite.config.ts`

Note we no longer have a separate `reactivity.ts` — effect-smol's
`unstable/reactivity` is consumed directly.

Phase 2 build order:

11. `packages/compiler/src/transform.ts` — Babel AST visitor (~200 lines)
12. `packages/compiler/src/index.ts` — public `transformEfx()` API
13. `packages/vite-plugin/src/index.ts` — Vite plugin (~60 lines)
14. Rename demo files `.ts` → `.efx`, replace `h()` calls with angle brackets
15. Verify acceptance criteria for phase 2

---

## 10. Definition of done for the conversation

We're done when:

- Phase 1 acceptance criteria pass.
- A path to phase 2 is clear and the design above remains the contract.
- Optionally: phase 2 also passes, if time/scope allows in this session.

If phase 2 turns out to be too big for one session, phase 1 alone is a
respectable POC — it proves the load-bearing claim. Phase 2 is ergonomics on
top of an already-proven type system.
