# `verrex` — the framework runtime

What the user actually imports from when writing components.
Public surface (from `index.ts`):

- `h` — the view factory (the compile target for `<...>` source
  syntax) + `h.track`/`h.read` (compiler hooks)
- `mount` — DOM renderer (returns `Effect<void, E, R | AtomRegistry | Scope>`)
- `list` — keyed reactive list helper (`View.List` IR node)
- `Await` — async render boundary (auto-tracking; see "`Await`" below)
- `Fragment` — `<>...</>` compile target
- `VerrexLive` — base Layer providing `AtomRegistry`
- Types: `View`, `Props`, `FoldE`/`FoldR`/`TagE`/`TagR`/`TagProps`,
  `IntrinsicProps`, `HtmlEventHandlers`

This is where the **channel propagation contract lives** —
`h()`'s signature uses `FoldE`/`FoldR` conditional types to union
every child's `E` and `R` into the result type. See
[`types/Fold.ts`](./types/Fold.ts).

### `h()` parameter naming — coupled to the TS plugin

The `HFn` type's parameters are `_tag`, `_props`, `_children`
(underscore prefix, in `h.ts`). This is **coupled to
[`@verrex/ts-plugin`](../../../ts-plugin/AGENTS.md)** — the plugin's
inlay-hint filter drops any hint matching
`/^_?(tag|props|children):?$/i`, so these labels never appear in
the editor margin. If you rename them, update the regex.

## Files

| File | Purpose |
|---|---|
| `h.ts` | `h()` factory + `track`/`read` reactivity-tracking machinery (built on `trackDeps`/`recordDep` from `coerce.ts`) |
| `coerce.ts` | `coerceAsync` (any child shape → `Effect<View>`) and `coerceSync` (render-time emission → `View`). Internal; not re-exported from `index.ts`. Owns `isAtomRef` (brand check against `AtomRef.TypeId`) and the shared dependency tracker `trackDeps`/`recordDep` (used by both `h.track` and `Await`) |
| `View.ts` | `View` IR (intermediate representation) — hand-written union of 6 named interfaces (`ViewText`, `ViewElement`, `ViewFragment`, `ViewReactive`, `ViewList`, `ViewEmpty`); constructors via `Data.taggedEnum<View>()`. The normalized DOM-materialization shape `mount` switches on. Plus `isView`, `VIEW_TAGS` |
| `mount.ts` | DOM renderer. `buildDom(view, registry, scope) → Node`, `mount(app, el)`. Cleanup is delegated to `Scope` — every subscription/listener/release registers a finalizer on the scope it was created in, and parent-fork cascade tears them down on close |
| `index.ts` | Public exports + `list`, `Await`, `Fragment`, `VerrexLive` |
| `coerce.test.ts` | Vitest suite for `coerceAsync` / `coerceSync` (parity + the sync/async asymmetry pin) |
| `types/Fold.ts` | `ChildE`/`ChildR`/`FoldE`/`FoldR`/`TagE`/`TagR`/`TagProps` — the channel-fold conditional types |
| `types/Html.ts` | `IntrinsicProps`/`HtmlEventHandlers` — typed event handlers for HTML intrinsics |
| `types/Fold.test-d.ts` | `expectTypeOf` matrix — every channel-fold shape |

## Reactivity model

Reactivity is delegated to `effect/unstable/reactivity`. We do not
ship our own atom/signal primitive.

- `AtomRef<T>` — local mutable cell (the "ref"). Subscribe gets
  notified on `.set` / `.update`.
- `Atom<T>` — derived in an `AtomRegistry` context. Need
  `registry.get(atom)` / `registry.subscribe(atom, fn)`.
- `AtomRef.Collection<T>` — reactive array; rows are
  `AtomRef.AtomRef<T>` so each row is its own subscribable cell.

`mount` requires `AtomRegistry` in `R`. `VerrexLive` provides it.

## The track/read dance

The compiler wraps `{expr}` JSX expressions in `h.track(() => expr)`
**only when** it actually rewrote a `.value` read inside (see
[compiler AGENTS.md](../compiler/AGENTS.md)). Inside that scope:

- `h.read(ref)` — a **faithful, transparent wrapper for `.value`**:
  byte-for-byte `ref.value` for any non-AtomRef (throws on null exactly
  as `.value` would — no `?.` swallow), and for a branded AtomRef it
  *additionally* registers `ref` as a tracked dep when a tracker is
  active. This faithfulness is what lets the compiler emit `h.read` for
  *every* `.value` read in a component body (not just JSX) without any
  compile-time atom analysis — the `isAtomRef` brand is the exact gate.

`h.track` itself (via `trackDeps` in `coerce.ts`, shared with `Await`):

1. `trackDeps` sets a module-level collector to a fresh dep set.
2. Runs the thunk; `h.read`→`recordDep` adds to the set per AtomRef.
3. **If the set is empty**, returns the thunk's result directly
   (no AtomRef wrap, no reactivity overhead — and the caller's
   static typing is preserved).
4. **If the set is non-empty**, creates a derived `AtomRef`, sets
   its initial value to the thunk's result, subscribes to every
   tracked ref, re-runs the thunk on change.
5. Deps are re-collected on every rerun (a ternary may read
   different refs on its other branch). Old subs are dropped first.

**Invariant: the empty-deps early return is load-bearing.** Without
it, every `<Row item={item} />` would erase `item`'s generic type to
`unknown`.

## View IR

The intermediate representation between "arbitrary JSX child value"
and "DOM nodes." `coerceAsync` (in `coerce.ts`) coerces inputs to
View at `h()` call time; `coerceSync` (also in `coerce.ts`) coerces
render-time emissions from Reactive sources; `buildDom` (in
`mount.ts`) switches on the variant tag and produces DOM. Closed-
for-now at 6 variants:

- `Text { value }` — plain text node
- `Element { tag, props, children }` — DOM element
- `Fragment { children }` — group of views, no DOM container
- `Reactive { source: Atom | AtomRef.ReadonlyRef }` — subscribe to
  source, swap rendered child on emit
- `List { source: AtomRef.Collection, render }` — keyed reactive list
- `Empty {}` — comment placeholder (used for `false`/`null` children)

### Why hand-written interfaces (not `Data.TaggedEnum<{...}>`)

`View` is declared as a union of named `interface`s, not as
`Data.TaggedEnum<{ Text: {...}, Element: {...}, ... }>`. The
shorthand form is more compact, but it runs every variant through
`Types.Simplify`, which strips the `View` alias name and causes TS
to inline the entire union in every hover (`Effect<{ _tag: "Text";
... } | { _tag: "Element"; ... } | ..., never, never>` — roughly
30 lines per component signature). Named interfaces anchor the
alias, so hovers show the concise `Effect<View, never, never>`.

Constructors still come from `Data.taggedEnum<View>()` — the
runtime behavior is identical. Don't "simplify" this back to the
inline form.

### Closed-for-now, not closed-forever

The current 6 variants cover everything we need to render. Adding
a variant is a coordinated edit across two files:

  - `buildDom` (mount.ts) — exhaustive `switch (view._tag)` forces
    a new case (TS will tell you)
  - `coerce.ts` — `coerceAsync` if it can be authored from JSX,
    and/or `coerceSync` if it can be emitted from a Reactive
    source. Often one of the two is enough.

Channels are unaffected — they're folded at the `h()` call site
via `FoldE`/`FoldR`, which operate on input child *shapes*
(Effect, Option, Atom, …), not on the IR. (Recall: there is no
"JSX call site" in the emitted code — the compiler turns every
`<div>...</div>` into a plain `h(...)` call before tsc sees it.
See root [AGENTS.md](../../../../AGENTS.md) on JSX-as-syntax-only.) By
the time `coerceAsync` returns a View, all channels have been
hoisted into the surrounding Effect.

Good candidates if a need arises: `Portal` (render children to a
different DOM root). Note an async boundary did **not** need a new
variant — see `Await` below. Anti-pattern: convenience wrappers like
`Card`/`Heading` — those are components, not IR.

## `Await` — the async render boundary

`Await` (index.ts) renders an Effect's pending/success/error states as a
leaf that owns one effectful data source (a Resource, à la Solid — **not**
React Suspense: no throw-and-catch). One auto-tracking form:

```tsx
Await(() => effect, { pending?, onSuccess, onError? })
```

The first arg is a **thunk** that produces the effect. It runs under the
**same dependency tracker as `h.track`** (`trackDeps`/`recordDep`, shared
from `coerce.ts`): any reactive ref the thunk reads via `.value`/`h.read`
becomes a dependency, and the boundary **re-runs the effect when one
changes**, interrupting the stale run. So a static fetch and a reactive
refetch are the same call — deps are *discovered, not declared*:

```tsx
const userId = AtomRef.make("42")    // buttons: userId.set("7")
const http = yield* Http             // extract services up front
{Await(() => http.getUser(userId.value), { pending, onSuccess, onError })}
```

A thunk that reads no refs runs once. Positional thunk-first (like
`list(coll, render)`) so `A`/`E` are fixed before the arms are contextually
typed — arms in the same object literal as the effect defeat inference
(`onSuccess`'s value collapses to `unknown`). Arm channels are accepted
permissively (`any`) and are not folded into the result; that also avoids a
JSX conditional's `any`-folded channels breaking inference. **Arms must be
synchronous View-producers** — they render via `coerceSync` (`runSyncExit`),
so an *async* arm effect can never resolve and renders `[effect failed: …]`;
an arm effect needing an unprovided service also fails only at runtime (its
`R` isn't folded). Keep arms pure markup.

**Inline or extracted — both track.** The compiler rewrites `.value`→`h.read`
across the whole component body, not just in JSX expressions (see the compiler's
"Whole-body `.value` reads"), so an extracted thunk —
`const get = () => http.getUser(userId.value)` then `Await(get, …)` — refetches
identically to the inline form. The read just has to happen *inside* the thunk
(so it runs under `Await`'s tracker); a `.value` read into a local *before* the
thunk (`const id = userId.value; Await(() => http.getUser(id), …)`) captures a
snapshot and won't refetch — that's the ordinary eager-read semantics, not a
special case.

**Why a thunk, not the bare expression** (`Await(http.getUser(userId.value))`):
the bare form evaluates the effect eagerly with nothing re-runnable, and the
compiler's `h.track` wrapper can't run `Await`'s fiber (it would store the
unexecuted `Effect` in a ref → DOM stuck on the stale value). Making `Await`
itself the tracker — taking the thunk — composes the two reactive layers
(sync ref-tracking + async fiber) correctly.

It is a **plain helper, not a View IR variant** — it builds an
`AtomRef<unknown>` holding the current rendered arm and returns a
`View.Reactive` over it, so the existing Reactive node does all the DOM
work. The design that makes this fit verrex:

- **State** is Effect's `AsyncResult` matched to an arm, stored in a
  *synchronous* `AtomRef` (so the Reactive node reads it immediately and
  re-renders on `.set`).
- **Tracking + execution:** a `schedule()` runs the thunk under `trackDeps`,
  subscribes to the refs it read (re-scheduling on change), and enqueues the
  effect onto a `Queue`. A `forkScoped` supervisor loop drains the queue —
  `forkChild` per run, prior run `Fiber.interrupt`ed — on the **mount fiber**.
  Fork interrupted on scope close (teardown); ref subscriptions are a scope
  finalizer.
- **Channels:** because `forkScoped` forks the thunk's effect, the result
  folds its `R` — `Await` returns `Effect<View, never, R | Scope>` with **no
  cast**. Extract services with `yield* Service` before the thunk so they fold
  into the *component's* `R` (a missing Layer is a compile error at `mount`).
  `E` is `never` on purpose: the boundary *handles* failure via `onError`
  (rendered) rather than propagating it. Contrast in-component fetching
  (UserPage), where `E`+`R` both fold to the root.

Why NOT `Atom`/`Atom.runtime` for this: an `Atom.runtime(layer)` bakes the
Layer in and discharges `R` (loses the thesis); a per-call runtime built
from a captured context dies "registry disposed" once the creating program
returns. Running the user's Effect directly on the mount fiber is what
keeps `R` folded. `Atom`/`AtomRef` remain the right tool for *synchronous*
reactive state (Counter, `list`) — just not the spine for effectful data.

## mount internals — invariants

**Scope is threaded through `buildDom`.** Signature:
`buildDom(view, registry, scope: Scope.Scope) → Node`. Every
subscription, event listener, and per-row `Effect.acquireRelease`
release registers a finalizer on this scope (directly via
`Scope.addFinalizer`, or via a forked child for sub-trees that need
their own lifetime). On scope close, parent-fork cascade tears
everything down. There is no `{ node, cleanup }` wrapper return type
— closing the surrounding scope IS the cleanup.

**`subscribeRefScoped` / `subscribeAtomScoped`** are the only two
ways to subscribe to a reactive source from inside `mount.ts`.
They register the `dispose` callback as a `Scope.addFinalizer`
finalizer. Don't subscribe outside these helpers — the dispose
function would have no scope to bind to and would leak on teardown.

**Fragments wrap in `<span style="display: contents">`.** Not a
`DocumentFragment`, because `DocumentFragment` is consumed on insert
— a later `replaceChild(fragment, ...)` would fail. The wrapper
keeps a stable parent reference; `display:contents` makes the
wrapper invisible to CSS so children inherit the real parent's
styling (e.g., `<ul>` styling for `<li>` rows). Don't replace this
with a Fragment.

**Reactive nodes render a placeholder comment first**, then swap on
the first emit (synchronous if the source is already populated).
Source can be `Atom` or `AtomRef.ReadonlyRef`; dispatch on
`Atom.isAtom` / `isAtomRef`. `coerceSync` (from `coerce.ts`) coerces
the emitted value into a `View` — including `Effect`, which is run
with the per-render child scope so `Effect.acquireRelease`
registers releases on *that* render's scope. `coerceSync` is
deliberately asymmetric vs. `coerceAsync`: at this point in the
render path the Atom/AtomRef has already been peeled, so it does
NOT recurse into Option/Result/Chunk/Atom/AtomRef. Don't "fix" that
— the unwrap contract belongs upstream.

**Reactive ordering: build NEW → swap DOM → close OLD.** Per emit,
fork a fresh child scope from the Reactive's scope, build the new
subtree into it (subscribing whatever refs the new subtree needs),
swap into the DOM via `replaceChild`, THEN close the previous
emit's child scope. The reverse order (close OLD first, then build
NEW) would unsubscribe many refs and resubscribe many during a
single `notify` loop on the source — the same "diff, not
unsub-all-then-resub" hazard documented for `h.track`.

**List reconciles by AtomRef identity.** Not by index, not by value
equality. Each row's `AtomRef` is the key; on `subscribe`, only
structural changes (length differs or identity at any index differs)
trigger reconciliation. Per-value updates inside a row are handled
by the row's own reactive bindings — re-reconciling on those would
tear down DOM unnecessarily.

**List snapshot must be a copy, not a reference.** Effect's
`CollectionImpl` mutates its internal array in place on `push`/
`remove`, so storing `view.source.value` and later comparing
references would always say "no change." `snapshot = Array.from(next)`
is critical.

**List per-row Scope is a `Scope.forkUnsafe` child of the List's
scope** — not an orphan `Scope.makeUnsafe`. The row's render Effect
runs in that scope so `Effect.acquireRelease(acquire, release)`
inside the row component registers `release` on the row scope. On
row removal, `Scope.closeUnsafe(rowScope, Exit.void)` fires the
releases; on full teardown, the parent-fork cascade closes any
remaining rows automatically — leak-safe by construction. The
`Effect.runFork(closeExit)` shape is intentional: row releases can
be async, and fire-and-forget matches the surrounding DOM
synchronicity. Lifecycle.vx exercises this mechanism, and
`scripts/probe-lifecycle.mjs` exercises both row-removal and the
full-teardown cascade.

**`mount`** captures the ambient `Scope` via `yield* Effect.scope`,
threads it into `buildDom`, and adds one finalizer of its own
(removes the rendered root from the DOM). All other cleanup is
inside the scope. Callers must provide a scope (`Effect.scoped`
typically) and keep it alive for the lifetime of the rendered UI.

## Anti-patterns

- Don't add View IR variants as convenience wrappers (`Card`,
  `Heading`, etc.) — those are components, not IR. New variants
  are for new DOM-materialization shapes (`Portal`, `Suspense`)
  and require coordinated edits across `buildDom` and `coerce.ts`.
  See "Closed-for-now, not closed-forever" above.
- Don't normalize Reactive sources eagerly. `coerceSync` is
  synchronous on purpose; subscribing first then rendering would
  flash a comment in the DOM.
- Don't make `coerceSync` peel Option/Result/Chunk/Atom/AtomRef.
  Those containers are unwrapped upstream of the Reactive render
  path; adding peeling here would either silently re-introduce
  async dependencies into a sync hot path or grow dead code.
- Don't return `DocumentFragment` from `buildDom`. Stable replacement
  needs a real parent node.
- Don't return `{ node, cleanup }` (or any wrapper around `Node`)
  from `buildDom`. Cleanup is the scope's job — adding a tuple back
  reintroduces parallel cleanup conventions that the scope-threading
  refactor consolidated. If you need teardown for something, register
  it via `Scope.addFinalizer` (or one of the `subscribe*Scoped`
  helpers).
- Don't call `Scope.makeUnsafe()` from inside `buildDom` to make an
  orphan scope for a sub-tree. Use `Scope.forkUnsafe(parent, ...)`
  so the sub-scope is parent-linked — closing the surrounding scope
  cascades into the sub-scope. Orphan scopes leak finalizers on
  unexpected teardown paths.
- Don't extend `h.track`'s behavior to handle composite expressions
  — the compiler decides what's rewritten; the runtime just executes.
- Don't subscribe to `AtomRef.Collection` per-item-value events
  (only to structural events). Rows do their own value reactivity.
- Don't expose helpers that wrap Effect's own combinators
  (`Effect.map`, `Atom.map`, etc.). API surface is intentionally
  minimal — users compose with native Effect primitives.

## Known limits

### Generic components don't survive JSX call sites

A component declared as `<T>(props: {item: T}) => Effect<View, …>`
loses its `T` when called as `<MyComp item={x} />` — the same
higher-rank polymorphism limit React/Solid hit. `h()`'s outer
generics infer once per call site and can't carry a component's
inner type parameter through.

**Workaround.** Keep generics on a regular function whose call
site preserves `T`, and accept a function child instead of a JSX
`<MyComp<T>>` tag. `list(coll, render)` is the canonical shape:

```ts
list<T>(coll: AtomRef.Collection<T>, render: (item: AtomRef.AtomRef<T>, i: number) => …)
```

Users normally never write `list()` by hand — the compiler rewrites
`{coll.value.map(item => <Row item={item} />)}` in JSX expression
position into this call. The function is exported and stable so the
generated code has something to link to (and so escape hatches like
"call `list` from non-JSX code" stay possible).

Don't "fix" generic erasure by widening `h()`'s signature — see the
root [AGENTS.md](../../../../AGENTS.md) anti-pattern about pluggable JSX
backends. The narrow `h()` signature is what makes channel folding
work; carrying a component's inner generic would require
higher-rank polymorphism TS doesn't have.

### `h.read` overload preserves arbitrary `.value` types

`h.read` is intentionally overloaded two ways:

```ts
function read<T>(obj: AtomRef.ReadonlyRef<T>): T
function read<T extends HasValue>(obj: T): T["value"]
```

(`HasValue = { readonly value: unknown }`.) The second signature
is **load-bearing**: it lets compiled code like `h.read(s).bio`
(where `s` is an `AsyncResult.Success` and the source said
`s.value.bio`) type-check against `Success`'s payload. Drop it
and every pattern-match site against `AsyncResult` / `Option` /
`Result` shapes that reads `.value` inside a JSX expression
breaks. There is **no** nullable overload: reading `.value` on a
possibly-null base is a type error in the source `.value` form
too, and `h.read` now mirrors that — it is byte-for-byte
`obj.value` at runtime (it throws on null; there is no `?.`
swallow). The TS-side overloads are independent of the runtime
behavior (for AtomRefs it tracks; for anything else it's identity
to `.value`). Optional chaining (`obj?.value`) is left un-rewritten
by the compiler, so it never reaches `h.read`.

## Channel-fold quick check

If you change `h()`'s signature or any of the `Fold*` types, run:

```
pnpm --filter verrex typecheck
# and (for end-to-end JSX shape coverage):
pnpm --filter verrex-demo typecheck
```

The `channels.test-d.ts` files (`runtime/src/types/Fold.test-d.ts`
and `apps/demo/src/channels.test-d.ts`) are compile-time proofs
that the fold works for the JSX shapes we care about. Failing
`expectTypeOf` calls are real regressions.
