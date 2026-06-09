# `apps/demo` — usage patterns by primitive

Each `.vx` file exercises a different framework primitive. The
demo is also the canonical "example" — when documenting an
intended pattern, prefer extending an existing demo over inventing
a new one elsewhere.

The actual app at `src/main.vx` mounts every demo into one page so
they can be exercised in a browser side-by-side.

## What each demo proves

| File | Primitive |
|---|---|
| `Counter.vx` | Local `AtomRef` state, no Effect services. Reactive `.value` interpolation inside `{...}` expressions. |
| `UserPage.vx` | In-component fetch: `Effect.fn` that `yield*`s `http.getUser` directly, so the subtree blocks until it resolves and `E = HttpError` + `R = Http \| Theme` fold to the root (root-handled failure). The channel-propagation example. |
| `AsyncUserPage.vx` | The same fetch behind the `Async` boundary, once form: `Async(getUser, { initial, failure, success })` (thunk-first positional, extractable `from`). Non-blocking (initial placeholder) and failure rendered as a value (`failure`), so `E = never`; `Http` still folds (fetch on the mount fiber) → `Effect<View, never, Http \| Scope>`. The boundary counterpart to `UserPage` — same data, opposite `E`. Renders into `.async-user-page` (distinct from UserPage's `.user-page`). |
| `LiveUser.vx` | The `Async` boundary, auto-tracking form: `Async(() => http.getUser(userId.value), { … })`. The thunk reads a writable `AtomRef`'s `.value`, so it becomes a tracked dep and the fetch re-runs on change (interrupting the stale run) — no explicit trigger declared. Service extracted up front → `Effect<View, never, Http \| Scope>` (Http folded), unlike a baked `Atom.runtime` which would discharge it. |
| `Todos.vx` | Keyed reactive list (`{coll.value.map(item => <Row item={item}/>)}` compiles to `list(coll, render)`). Per-row reactivity: toggling one row doesn't tear down others. |
| `Lifecycle.vx` | `Effect.acquireRelease` inside a row — release fires when the row is removed (per-row Scope in mount). |
| `CatchDemo.vx` | The `Catch` error boundary (step 07), both forms: a function handler (catch-all over a `Crasher` whose click fails) and an object tag-map (`{ HttpError }` over a flaky `BadRequest` that ~50% of the time fails construction with a random typed error, routed + unwrapped — `retry` re-rolls and may recover). Discharges to `Effect<View, never, Scope>`; `reset`/`retry` re-run construction. Exercised end-to-end by `scripts/probe-catch.mjs`. |
| `main.vx` | Wires Layers (`VerrexLive`, `HttpLive`, `ThemeLive`) + `Effect.scoped` + `Effect.never` (keep scope alive for page lifetime). |
| `services.ts` | Mock Http + Theme services. `Data.TaggedError` for `HttpError`. |

## No sibling `.ts` files on disk

Cross-file `.vx` imports carry an explicit `.vx` extension (see
the root [AGENTS.md](../../AGENTS.md) invariant). As a result
nothing in this demo's build pipeline emits sibling `.ts` files:
`pnpm typecheck` runs [`@verrex/core/check`](../../packages/core/src/check/AGENTS.md)
directly, `vite build` runs
[`@verrex/core/vite`](../../packages/core/src/vite-plugin/AGENTS.md)
directly, and the editor's
[TS plugin](../../packages/ts-plugin/AGENTS.md) maps virtual-code
results back to source `.vx` positions natively. (An earlier
demo build script ran an `verrex-compile` CLI that emitted sibling
`.ts` files for tsc to pick up — `@verrex/core/compiler` itself was, and
still is, a pure in-memory `transformVerrex`. The CLI is gone.)

## `channels.test-d.ts`

Type-only test file. Uses `expectTypeOf` from `vitest` to assert
that:

- A `<Component />` whose body needs `Http` propagates `Http` into
  `R` at the surrounding `h()` call site (which is what the
  compiler turns the JSX-syntax into — see root
  [AGENTS.md](../../AGENTS.md)).
- A `<div>` containing such a component propagates `Http` too.
- Conditional / `&&` / list children all fold `E`/`R` correctly.
- A consumer that forgets a required Layer fails to type-check.

This is the **compile-time proof that channels survive the tree**.
If you touch `h()`'s signature, any of the `Fold*` types, or `View`
IR, run:

```
pnpm --filter verrex-demo typecheck
```

A regression here is the framework's central thesis breaking. The
file is intentionally not run as a runtime test — `expectTypeOf` is
purely a typing assertion.

## Vite dev server

`vite.config.ts` is intentionally minimal — it wires
`@verrex/core/vite`. The plugin's `configureServer` middleware adds
`?import` to any `.vx` URL so Vite treats it as a module rather
than serving raw text on direct GET. Don't add a separate
filename-rewrite shim; the plugin already handles it.

The dev server binds to `0.0.0.0` (set in vite.config.ts) so LAN
devices can hit the demo. Don't drop that without checking.

## Anti-patterns

- Don't import from `verrex/internal` — there is no internal
  subpath; everything is re-exported from the index.
- Don't wrap reactive reads in `.pipe(Effect.map(...))` for the
  common case — let the compiler emit `h.track`. Use Effect's
  combinators only when you actually need to compose multiple
  Effects.
- Don't add helper components that wrap intrinsics for no reason.
  The demo is opinionated about *not* having a component library;
  it shows what falls out of the framework directly.
- Don't reach for `AtomRef.unsafeMake` or `Effect.runSyncUnsafe`
  in component code — the runtime expects everything reactive to
  flow through scoped effects.

## Related context

- Runtime contract: [`packages/core/src/runtime/`](../../packages/core/src/runtime/AGENTS.md)
- Compiler rewrites (what `.vx` actually becomes): [`packages/core/src/compiler/`](../../packages/core/src/compiler/AGENTS.md)
- Framework rationale + channel-fold thesis: root [`AGENTS.md`](../../AGENTS.md)
