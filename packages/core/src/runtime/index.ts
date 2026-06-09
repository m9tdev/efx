import { Cause, Effect, Fiber, Layer, Queue, Scope } from "effect"
import { AsyncResult, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { trackDeps } from "./coerce.ts"
import { type BoundaryState, type Props, View } from "./View.ts"

export { h } from "./h.ts"
export { mount } from "./mount.ts"
export { type Props, View } from "./View.ts"
// `Async`, `asyncRef`, `catchCause`, `list`, `Fragment`, `VerrexLive` are declared + exported below.
export type { Child, ChildE, ChildR, FoldE, FoldR, TagE, TagProps, TagR } from "./types/Fold.ts"
export type { HtmlEventHandlers, IntrinsicProps } from "./types/Html.ts"

/**
 * Reactive keyed list. Renders one row per item in `from`, keyed by the
 * item's `AtomRef` identity. Adds/removes only the rows that changed —
 * unaffected rows stay mounted with their DOM and subscriptions intact.
 *
 * Generic `T` is preserved through the function call site (which JSX
 * component tags can't do because of higher-rank polymorphism limits in
 * TypeScript). Use as `{list(coll, (item) => <Row item={item} />)}`.
 *
 * `index` is a reactive `ReadonlyRef<number>`, not a plain number: when a row
 * shifts position (because an earlier row was added or removed) or is reordered,
 * `mount` pushes the new index into this ref without re-rendering the row. Read
 * it as `index.value` (the compiler routes that through `h.read`, so it tracks
 * like any other ref) to display a live position.
 *
 * **Breaking:** `index` was a plain `number` in earlier versions; it is now a
 * `ReadonlyRef<number>`. Migrate `i` → `i.value` (and note `i` can no longer be
 * used in arithmetic without `.value`).
 */
export const list = <T>(
  from: AtomRef.Collection<T>,
  render: (
    item: AtomRef.AtomRef<T>,
    index: AtomRef.ReadonlyRef<number>,
  ) => View | Effect.Effect<View, never, Scope.Scope> | Effect.Effect<View, never, never>,
): View =>
  View.List({
    source: from as AtomRef.Collection<unknown>,
    render: render as (
      item: AtomRef.AtomRef<unknown>,
      index: AtomRef.ReadonlyRef<number>,
    ) => unknown,
  })

/**
 * The reactive effectful data primitive — the async leaf of the
 * errors-as-values model, and what `<Async>` is sugar over.
 *
 * `asyncRef(() => effect)` runs `effect` on the **mount fiber** (so its `R`
 * folds into the component — a forgotten `Layer` is a compile error at the root
 * `mount`) and returns a reactive `AsyncResult<A, E>` you handle with Effect's
 * own `AsyncResult.match`:
 *
 * ```tsx
 * const user = yield* asyncRef(() => http.getUser(userId.value))
 * //    user: ReadonlyRef<AsyncResult<User, HttpError>>
 * {user.map(AsyncResult.match({ onInitial, onFailure, onSuccess }))}
 * ```
 *
 * Reactivity is discovered, not declared: any ref the thunk reads (`.value` →
 * `h.read`) becomes a dependency and the effect re-runs (interrupting the stale
 * run) when it changes — the thunk is the re-run scope. Built on `AtomRef` +
 * `AsyncResult` + `forkScoped`; no `Atom.runtime` (which would discharge `R`),
 * no new View IR.
 */
export const asyncRef = <A, E, R>(
  effect: () => Effect.Effect<A, E, R>,
): Effect.Effect<AtomRef.ReadonlyRef<AsyncResult.AsyncResult<A, E>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const state = AtomRef.make<AsyncResult.AsyncResult<A, E>>(AsyncResult.initial(true))
    const scope = yield* Effect.scope

    // A "run" request carries the effect to fork. The first is produced by
    // running the thunk under dep-tracking; each tracked ref's change enqueues
    // a fresh run (re-running the thunk to pick up new ref values + deps).
    const runs = yield* Queue.unbounded<Effect.Effect<A, E, R>>()
    let unsubs: Array<() => void> = []

    const schedule = (): void => {
      for (const u of unsubs) u()
      unsubs = []
      const { result: eff, deps } = trackDeps(effect)
      for (const dep of deps) unsubs.push(dep.subscribe(schedule))
      Queue.offerUnsafe(runs, eff)
    }
    schedule() // initial run + dep subscriptions
    yield* Scope.addFinalizer(scope, Effect.sync(() => { for (const u of unsubs) u() }))

    // Supervisor loop on the mount fiber: one child at a time; a new run
    // interrupts the prior. Scope close interrupts loop + live child.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let child: Fiber.Fiber<void, never> | null = null
        while (true) {
          const eff = yield* Queue.take(runs)
          if (child) yield* Fiber.interrupt(child)
          state.set(AsyncResult.initial(true)) // waiting
          child = yield* Effect.forkChild(
            Effect.matchCause(eff, {
              onFailure: (cause) => { state.set(AsyncResult.failure(cause)) },
              onSuccess: (value) => { state.set(AsyncResult.success(value)) },
            }),
          )
        }
      }),
    )

    return state as AtomRef.ReadonlyRef<AsyncResult.AsyncResult<A, E>>
  })

/**
 * The arms for `Async` / `<Async>`. Each maps to an `AsyncResult` variant.
 * Channels are accepted permissively (`any`) — the arms render at the node scope
 * and their E/R are NOT folded; only `from`'s `R` is (the thesis-bearing one).
 */
interface AsyncArms<A, E> {
  readonly initial?: View | Effect.Effect<View, any, any>
  readonly failure?: (cause: Cause.Cause<E>) => View | Effect.Effect<View, any, any>
  readonly success: (value: A) => View | Effect.Effect<View, any, any>
}

/**
 * Async render boundary — **thunk-first positional**
 * (like `list`) so `A`/`E` are fixed from `from` before the arms are typed; a
 * single props object would collapse `success`'s value to `unknown`.
 *
 * `from` is a thunk, so it can be inline or extracted
 * (`const getUser = () => http.getUser(userId.value)`); a ref read inside it
 * auto-refetches. The compiler lowers the `<Async from initial failure success/>`
 * JSX element to this positional call.
 *
 * ```tsx
 * Async(() => http.getUser(userId.value), {
 *   initial: <p>loading…</p>,
 *   failure: (cause) => <p>error: {Cause.pretty(cause)}</p>,
 *   success: (user) => <h1>{user.name}</h1>,   // user: User (inferred)
 * })
 * ```
 *
 * Sugar over `asyncRef` + `AsyncResult.match`: `from` runs on the mount fiber so
 * its `R` folds into the component (forgotten Layer = compile error); result is
 * `Effect<View, never, R | Scope>`. Failure renders via `failure` (omit → renders
 * nothing) — never thrown, never folded to `E`.
 */
export const Async = <A, E, R>(
  from: () => Effect.Effect<A, E, R>,
  arms: AsyncArms<A, E>,
): Effect.Effect<View, never, R | Scope.Scope> =>
  asyncRef(from).pipe(
    Effect.map((state) =>
      View.Reactive({
        source: state.map((r) =>
          AsyncResult.match(r, {
            onInitial: () => arms.initial ?? null,
            onFailure: (f) => (arms.failure ? arms.failure(f.cause) : null),
            onSuccess: (s) => arms.success(s.value),
          }),
        ) as AtomRef.ReadonlyRef<unknown>,
      }),
    ),
  )

/**
 * View-level error boundary — the catch-all. Mirrors `Effect.catchCause`: it
 * recovers the FAILURE side of a view subtree and lets success pass through (the
 * child renders itself). Contrast `Async`, which matches a data `AsyncResult`
 * and renders *every* state — a boundary supplies only the failure fallback.
 *
 * `catchCause(child, (cause, reset) => fallback)` catches both phases of failure:
 *  - **construction** — `child`'s build Effect fails (run under `Effect.catchCause`);
 *  - **live** — a post-mount failure inside the rendered subtree (a reactive
 *    re-render or an event-handler Effect) routed to this boundary's sink.
 * Either swaps the subtree for `fallback(cause, reset)`; `reset()` re-runs the
 * child's construction. Pure-interrupt causes (scope teardown) are ignored.
 *
 * `child`'s `R` folds into the component (construction + every `reset` run on the
 * mount fiber, like `asyncRef`), so a forgotten `Layer` is still a compile error
 * at `mount`. `cause` is `Cause<unknown>` for now — the typed `View<E>` discharge
 * (where a forgotten boundary becomes a compile error naming the error) lands in
 * a later pass. The fallback's own `E`/`R` are not folded — keep it pure markup,
 * like `Async`'s arms.
 *
 * ```tsx
 * {catchCause(<UserCard id={id} />, (cause, reset) => (
 *   <div class="err">{Cause.pretty(cause)}<button onClick={reset}>retry</button></div>
 * ))}
 * ```
 */
export const catchCause = <EV, EC, R>(
  child: Effect.Effect<View<EV>, EC, R>,
  handler: (cause: Cause.Cause<EC | EV>, reset: () => void) => View | Effect.Effect<View, any, any>,
): Effect.Effect<View<never>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    // Run `child`, folding both outcomes into a BoundaryState. `Effect.matchCause`
    // discharges `child`'s construction E (`EC`) while keeping R; re-runnable for
    // reset. Live errors riding the child's `View<EV>` are routed to `report`.
    const construct: Effect.Effect<BoundaryState, never, R> = Effect.matchCause(child, {
      onSuccess: (view): BoundaryState => ({ _tag: "ok", view }),
      onFailure: (cause): BoundaryState => ({ _tag: "error", cause }),
    })

    // Initial construction inline (folds R; no first-paint flash before the
    // child appears — unlike a forked run, which mount would race).
    const state = AtomRef.make<BoundaryState>(yield* construct)
    const runs = yield* Queue.unbounded<{ readonly _tag: "reset" } | {
      readonly _tag: "error"
      readonly cause: Cause.Cause<unknown>
    }>()

    // report/reset both go through the queue → applied on the forked fiber, never
    // synchronously inside the child's render (which would close the child scope
    // mid-render — reentrant). This is also why `report` is safe as a sink.
    const report = (cause: Cause.Cause<unknown>): void => {
      if (!Cause.hasInterruptsOnly(cause)) Queue.offerUnsafe(runs, { _tag: "error", cause })
    }
    const reset = (): void => {
      Queue.offerUnsafe(runs, { _tag: "reset" })
    }

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const msg = yield* Queue.take(runs)
          if (msg._tag === "error") state.set({ _tag: "error", cause: msg.cause })
          else state.set(yield* construct)
        }
      }),
    )

    // The node's handler slot is `Cause<unknown>` (runtime is untyped); the public
    // signature gives the user the precise `Cause<EC | EV>`. The values flowing in
    // are exactly those, so the cast is sound.
    return View.Boundary({
      state,
      handler: handler as (cause: Cause.Cause<unknown>, reset: () => void) => unknown,
      reset,
      report,
    })
  })

/**
 * Fragment component — the compile target for JSX `<>...</>` syntax.
 *
 * `h(Fragment, props, ...children)` evaluates to a `View.Fragment` whose
 * children are whatever was nested inside.
 */
export const Fragment = (
  props: Props & { children?: ReadonlyArray<View> },
): Effect.Effect<View, never, never> =>
  Effect.succeed(View.Fragment({ children: props.children ?? [] }))

/**
 * The base Layer every verrex app needs. Provides the `AtomRegistry` so any
 * reactive children in the view tree have somewhere to live.
 *
 * Merge this with your app-specific Layers (Http, Db, Theme, etc.) before
 * passing to `Effect.provide`.
 */
export const VerrexLive: Layer.Layer<AtomRegistry.AtomRegistry> = AtomRegistry.layer
