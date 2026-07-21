# `@verrex/core/testing` — in-process component test harness

Mount an verrex component into an in-process DOM, drive it, and tear it
down — without a browser or the Vite dev server. Fills the gap between
the type-level proof (`apps/demo/src/channels.test-d.ts`) and the
browser probes (`scripts/probe-*.mjs`): a deterministic, fast middle
layer for "does this component actually render and react?"

Public surface: `render(app, layer?)` returning a `RenderResult`, plus
`untracked(app)` — the ONE sanctioned type-erasure hatch for mounting an app
with an undischarged LIVE error (`View<E≠never>`), needed by sink-containment
tests ("a failing handler is contained, the app keeps working"). Route every
such test through it; an ad-hoc `as unknown as` cast on a handler effect or
app is a smell — the hatch exists to be greppable.

## What it does

```ts
const ui = await render(
  UserPage({ userId: "42" }),
  Layer.mergeAll(HttpTest, ThemeTest),
)
expect(ui.text(".user-card strong")).toBe("Ada Lovelace")
ui.click(".refresh")
await ui.tick()
await ui.unmount()
```

- `render(app, layer?)` — `app` is a component result (`Component(props)`,
  what a component tag compiles to since #71), i.e. an `Effect<View, E, R>`. Creates a
  container on `document.body`, makes a Closeable `Scope`, and runs
  `mount(app, container)` with the caller's layer + that scope
  provided. Returns once the DOM is attached. The layer is built INTO
  the harness scope via `Layer.build` — not `Effect.provide`, which would
  run the services' finalizers the moment the mount effect completes.
  The `AtomRegistry` needs no layer: `mount` owns one per mount and
  disposes it with the same scope close (see the mount-owns-registry
  invariant in the runtime AGENTS.md).
- `RenderResult` — `get`/`query`/`all`/`text` (DOM queries),
  `click`/`fire` (dispatch bubbling events that hit the component's
  handlers — an `onClick` returning an `Effect` is forked on the mount
  context with its services, and its failures route to the error sink, so
  a failing handler is contained rather than thrown; `event-handlers.test.ts`
  pins this), `tick()` (flush a macrotask so async/atom updates settle),
  `unmount()` (close the scope → fire every finalizer → detach).

## The load-bearing invariant: do NOT swallow E/R

The harness injects only `AtomRegistry` + `Scope`. Everything else the
component requires is `R` the **caller** must satisfy with `layer`, and
the type makes that mandatory:

```ts
type Required<R> = Exclude<R, AtomRegistry | Scope>
render(app, ...rest: [Required<R>] extends [never]
  ? [layer?: Layer<never>]            // no extra services → layer optional
  : [layer: Layer<Required<R>>])      // missing a service → COMPILE ERROR
```

A component needing `Http` won't `render` without an `Http` layer — the
same forgotten-`Layer`-is-a-compile-error guarantee verrex gives at a real
`mount`. **Never** loosen this to an untyped `layer?` default or a cast
that lies about coverage (`Layer.empty as Layer<Required<R>>`): that
would defeat the thesis exactly where it should be proven. The internal
`Layer.empty` fallback is only reached when `Required<R>` is `never`.

## `E` is auto-discharged to a defect

`R` is the caller's to satisfy (above); the construction error channel `E`
is the harness's to discharge. `render` wraps the app in
`Effect.catchCause(app, (cause) => Effect.die(Cause.squash(cause)))`, so an
**unboundaried** construction failure rejects the `render()` promise loudly —
a failing test, not a silently-empty DOM. A `Catch` boundary inside the tree
discharges first (its subtree resolves to `View<never>` and the fallback
renders), so only a failure that escaped every boundary reaches this
last-resort `die`. `catch.test.ts` exercises both paths.

## Why a Closeable scope (not `Effect.scoped`)

`mount` registers every subscription/listener/`acquireRelease` release
as a finalizer on the ambient `Scope`. The harness makes that scope with
`Scope.makeUnsafe()` and holds it open across interaction, then closes it
in `unmount()` — so a test can assert that finalizers fire on teardown
(the in-process equivalent of `scripts/probe-lifecycle.mjs`). Using
`Effect.scoped` would close the scope as soon as `mount` returned, tearing
the component down before you could drive it.

## Shared fixtures (`fixtures.ts`)

Test-only scaffolds for the Async/asyncRef suites (#98) — **not** exported
from the package and excluded in `tsconfig.build.json`, so it never reaches
`dist`. `makeUsersFixture(tagPrefix)` returns a fresh `Users` service per
suite — a factory, not module constants, because suites customize the getter
(gating, call counting, recovery flips) and a per-suite tag keeps service
identity distinct. It returns:

- `usersWith(get)` — a layer over a custom getter; build these **per test**
  over test-local state (the shape #95 settled on), never a shared mutable db.
- `UsersLive` — the canonical db-backed layer: `"42"`→Ada, `"7"`→Grace,
  `"slow"` fails `Timeout`, anything else fails `NotFound`.

The errors are module-level exports so they work as types too: `NotFound`
(a `Data.TaggedError`) and `Timeout` (deliberately a plain hand-rolled `_tag`
class — tag maps key on `_tag` alone, and both shapes must keep working).
The fixture also exports `Step`/`stepLayer`/`stepClick` (#72): a one-field
service whose resolution proves WHICH context a handler or row construction
ran on — shared by `event-handlers.test.ts` (dispatch pins) and
`context-capture.test.ts` (THE per-node capture pins, one per
capture-consuming path in the runtime AGENTS variant matrix).
The service's error channel is always `NotFound | Timeout`, so a leaf tag map
needs both tags to discharge to `View<never>`; suites exercising a _partial_
map handle one tag and let the residual ride to a boundary.

## Setup

- Each test file opts into happy-dom with a per-file
  `// @vitest-environment happy-dom` directive (the shared
  `vitest.config.ts` sets no global environment) so
  `document`/`HTMLElement`/`MouseEvent` exist in-process. `happy-dom` is a
  devDependency.
- Build components in tests with raw `h()` calls — no `.vx` compiler is
  needed; an `AtomRef` passed as a child coerces to a reactive node, so
  reactivity is exercisable without the Babel transform.

## Anti-patterns

- Don't add a `waitFor(predicate)` variant until a test needs it; the
  selector-based `waitFor` plus `tick()` covers the current cases (a test
  needing text-level polling keeps a local helper, see
  `async-refetch-regression.test.ts`).
- Don't re-declare a per-suite `Users`/db scaffold in a test file — take it
  from `fixtures.ts` (`makeUsersFixture`), and add to the fixture only what
  at least two suites share.
- Don't provide the component's real production layers here by default —
  tests pass their own (often test doubles). The harness only injects the
  ambient scope (and `mount` brings its own registry).
- Don't reach into `RenderResult.container` to mutate the DOM directly;
  drive the component through `click`/`fire` so the reactive path runs.

## Related context

- [`verrex`](../runtime/AGENTS.md) — `mount`, the View IR
  this harness drives.
- [`apps/demo/channels.test-d.ts`](../../../../apps/demo/src/channels.test-d.ts)
  — the type-level channel proof (compile-time peer to this runtime proof).
- [`scripts/`](../../../../scripts/AGENTS.md) — the browser probes this
  complements (use those for HMR / real-browser behaviors).
