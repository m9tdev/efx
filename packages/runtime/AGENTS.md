# `@efx/runtime` — the framework runtime

What the user actually imports from when writing components.
Public surface (from `src/index.ts`):

- `h` — the view factory (the compile target for `<...>` source
  syntax) + `h.track`/`h.read`/`h.peek` (compiler hooks)
- `mount` — DOM renderer (returns `Effect<void, E, R | AtomRegistry | Scope>`)
- `list` — keyed reactive list helper (`View.List` IR node)
- `Fragment` — `<>...</>` compile target
- `EfxLive` — base Layer providing `AtomRegistry`
- Types: `View`, `Props`, `FoldE`/`FoldR`/`TagE`/`TagR`/`TagProps`,
  `IntrinsicProps`, `HtmlEventHandlers`

This is where the **channel propagation contract lives** —
`h()`'s signature uses `FoldE`/`FoldR` conditional types to union
every child's `E` and `R` into the result type. See
[`src/types/Fold.ts`](./src/types/Fold.ts).

### `h()` parameter naming — coupled to the TS plugin

The `HFn` type's parameters are `_tag`, `_props`, `_children`
(underscore prefix, in `h.ts`). This is **coupled to
[`@efx/ts-plugin`](../ts-plugin/AGENTS.md)** — the plugin's
inlay-hint filter drops any hint matching
`/^_?(tag|props|children):?$/i`, so these labels never appear in
the editor margin. If you rename them, update the regex.

## Files

| File | Purpose |
|---|---|
| `src/h.ts` | `h()` factory + `track`/`read`/`peek` reactivity-tracking machinery + `normalizeChild` (any child shape → `View`) |
| `src/View.ts` | `View` IR (intermediate representation) — hand-written union of 6 named interfaces (`ViewText`, `ViewElement`, `ViewFragment`, `ViewReactive`, `ViewList`, `ViewEmpty`); constructors via `Data.taggedEnum<View>()`. The normalized DOM-materialization shape `mount` switches on. Plus `isView`, `VIEW_TAGS` |
| `src/mount.ts` | DOM renderer. `buildDom(View, registry) → { node, cleanup }`, `mount(app, el)` |
| `src/index.ts` | Public exports + `list`, `Fragment`, `EfxLive` |
| `src/types/Fold.ts` | `ChildE`/`ChildR`/`FoldE`/`FoldR`/`TagE`/`TagR`/`TagProps` — the channel-fold conditional types |
| `src/types/Html.ts` | `IntrinsicProps`/`HtmlEventHandlers` — typed event handlers for HTML intrinsics |
| `src/types/Fold.test-d.ts` | `expectTypeOf` matrix — every channel-fold shape |

## Reactivity model

Reactivity is delegated to `effect/unstable/reactivity`. We do not
ship our own atom/signal primitive.

- `AtomRef<T>` — local mutable cell (the "ref"). Subscribe gets
  notified on `.set` / `.update`.
- `Atom<T>` — derived in an `AtomRegistry` context. Need
  `registry.get(atom)` / `registry.subscribe(atom, fn)`.
- `AtomRef.Collection<T>` — reactive array; rows are
  `AtomRef.AtomRef<T>` so each row is its own subscribable cell.

`mount` requires `AtomRegistry` in `R`. `EfxLive` provides it.

## The track/read/peek dance

The compiler wraps `{expr}` JSX expressions in `h.track(() => expr)`
**only when** it actually rewrote something inside (see
[compiler AGENTS.md](../compiler/AGENTS.md)). Inside that scope:

- `h.read(ref)` — reads `.value`, registers `ref` as a tracked dep.
- `h.peek(id)` — for AtomRef, unwraps + tracks; for non-AtomRef,
  identity. Used for bare identifiers in test positions.

`h.track` itself:

1. Sets module-level `currentTracker` to a fresh dep set.
2. Runs the thunk; `h.read`/`h.peek` add to the set when they see an
   AtomRef.
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
and "DOM nodes." `normalizeChild` (in `h.ts`) coerces inputs to
View; `buildDom` (in `mount.ts`) switches on the variant tag and
produces DOM. Closed-for-now at 6 variants:

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
a variant is a coordinated edit across three files:

  - `buildDom` (mount.ts) — exhaustive `switch (view._tag)` forces
    a new case (TS will tell you)
  - `valueToView` (mount.ts) — if the new variant can come out of
    a `Reactive`'s emitted value
  - `normalizeChild` (h.ts) — if it can also be authored directly
    from JSX (vs. only constructed internally)

Channels are unaffected — they're folded at the `h()` call site
via `FoldE`/`FoldR`, which operate on input child *shapes*
(Effect, Option, Atom, …), not on the IR. (Recall: there is no
"JSX call site" in the emitted code — the compiler turns every
`<div>...</div>` into a plain `h(...)` call before tsc sees it.
See root [AGENTS.md](../../AGENTS.md) on JSX-as-syntax-only.) By
the time `normalizeChild` returns a View, all channels have been
hoisted into the surrounding Effect.

Good candidates if a need arises: `Portal` (render children to a
different DOM root), `Suspense` (boundary for in-flight Effects).
Anti-pattern: convenience wrappers like `Card`/`Heading` — those
are components, not IR.

## mount internals — invariants

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
`Atom.isAtom` / `isAtomRef`. `valueToView` (synchronous) coerces the
emitted value into a `View` — including `Effect`, which is run with
the current scope so `Effect.acquireRelease` registers releases on
*this* node's scope.

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

**List per-row Scope**: each new row gets its own
`Scope.makeUnsafe()`. The row's render Effect runs in that scope so
`Effect.acquireRelease(acquire, release)` inside the row component
registers `release` on the row scope. On row removal,
`Scope.closeUnsafe(rowScope, Exit.void)` fires the release. This is
the mechanism Lifecycle.efx exercises.

**`mount` adds a finalizer** that removes the rendered DOM and
calls `rendered.cleanup()` when its scope closes. The caller must
provide a scope (`Effect.scoped` typically) and keep it alive for
the lifetime of the rendered UI.

## Anti-patterns

- Don't add View IR variants as convenience wrappers (`Card`,
  `Heading`, etc.) — those are components, not IR. New variants
  are for new DOM-materialization shapes (`Portal`, `Suspense`)
  and require coordinated edits across `buildDom`, `valueToView`,
  and `normalizeChild`. See "Closed-for-now, not closed-forever"
  above.
- Don't normalize Reactive sources eagerly. `valueToView` is
  synchronous on purpose; subscribing first then rendering would
  flash a comment in the DOM.
- Don't return `DocumentFragment` from `buildDom`. Stable replacement
  needs a real parent node.
- Don't extend `h.track`'s behavior to handle composite expressions
  — the compiler decides what's rewritten; the runtime just executes.
- Don't subscribe to `AtomRef.Collection` per-item-value events
  (only to structural events). Rows do their own value reactivity.
- Don't expose helpers that wrap Effect's own combinators
  (`Effect.map`, `Atom.map`, etc.). API surface is intentionally
  minimal — users compose with native Effect primitives.

## Channel-fold quick check

If you change `h()`'s signature or any of the `Fold*` types, run:

```
pnpm --filter @efx/runtime typecheck
# and (for end-to-end JSX shape coverage):
pnpm --filter @efx/demo typecheck
```

The `channels.test-d.ts` files (`runtime/src/types/Fold.test-d.ts`
and `apps/demo/src/channels.test-d.ts`) are compile-time proofs
that the fold works for the JSX shapes we care about. Failing
`expectTypeOf` calls are real regressions.
