# `apps/demo` — usage patterns by primitive

Each `.efx` file exercises a different framework primitive. The
demo is also the canonical "example" — when documenting an
intended pattern, prefer extending an existing demo over inventing
a new one elsewhere.

The actual app at `src/main.efx` mounts every demo into one page so
they can be exercised in a browser side-by-side.

## What each demo proves

| File | Primitive |
|---|---|
| `Counter.efx` | Local `AtomRef` state, no Effect services. Reactive `.value` interpolation inside `{...}` expressions. |
| `UserPage.efx` | Synchronous-style Effect.fn returning a view with `R = Http \| Theme` and `E = HttpError` channels in scope. |
| `LiveUser.efx` | `AtomRef` + `AsyncResult` pattern matching for loading/success/failure shapes. |
| `Todos.efx` | Keyed reactive list (`list(coll, ...)`). Per-row reactivity: toggling one row doesn't tear down others. |
| `Lifecycle.efx` | `Effect.acquireRelease` inside a row — release fires when the row is removed (per-row Scope in mount). |
| `main.efx` | Wires Layers (`EfxLive`, `HttpLive`, `ThemeLive`) + `Effect.scoped` + `Effect.never` (keep scope alive for page lifetime). |
| `services.ts` | Mock Http + Theme services. `Data.TaggedError` for `HttpError`. |

## No sibling `.ts` files on disk

Cross-file `.efx` imports carry an explicit `.efx` extension (see
the root [AGENTS.md](../../AGENTS.md) invariant). As a result
nothing in this demo's build pipeline emits sibling `.ts` files:
`pnpm typecheck` runs [`@efx/check`](../../packages/check/AGENTS.md)
directly, `vite build` runs
[`@efx/vite-plugin`](../../packages/vite-plugin/AGENTS.md)
directly, and the editor's
[TS plugin](../../packages/ts-plugin/AGENTS.md) maps virtual-code
results back to source `.efx` positions natively. (An earlier
demo build script ran an `efx-compile` CLI that emitted sibling
`.ts` files for tsc to pick up — `@efx/compiler` itself was, and
still is, a pure in-memory `transformEfx`. The CLI is gone.)

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
pnpm --filter @efx/demo typecheck
```

A regression here is the framework's central thesis breaking. The
file is intentionally not run as a runtime test — `expectTypeOf` is
purely a typing assertion.

## Vite dev server

`vite.config.ts` is intentionally minimal — it wires
`@efx/vite-plugin`. The plugin's `configureServer` middleware adds
`?import` to any `.efx` URL so Vite treats it as a module rather
than serving raw text on direct GET. Don't add a separate
filename-rewrite shim; the plugin already handles it.

The dev server binds to `0.0.0.0` (set in vite.config.ts) so LAN
devices can hit the demo. Don't drop that without checking.

## Anti-patterns

- Don't import from `@efx/runtime/internal` — there is no internal
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

- Runtime contract: [`packages/runtime/AGENTS.md`](../../packages/runtime/AGENTS.md)
- Compiler rewrites (what `.efx` actually becomes): [`packages/compiler/AGENTS.md`](../../packages/compiler/AGENTS.md)
- Framework rationale + channel-fold thesis: root [`AGENTS.md`](../../AGENTS.md)
