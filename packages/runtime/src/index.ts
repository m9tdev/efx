import { Cause, Effect, Fiber, Layer, Queue, Scope } from "effect"
import { AsyncResult, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { trackDeps } from "./coerce.ts"
import { type Props, View } from "./View.ts"

export { h } from "./h.ts"
export { mount } from "./mount.ts"
export { type Props, View } from "./View.ts"
// `Await`, `list`, `Fragment`, `EfxLive` are declared + exported below.
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
 */
export const list = <T>(
  from: AtomRef.Collection<T>,
  render: (
    item: AtomRef.AtomRef<T>,
    index: number,
  ) => View | Effect.Effect<View, never, Scope.Scope> | Effect.Effect<View, never, never>,
): View =>
  View.List({
    source: from as AtomRef.Collection<unknown>,
    render: render as (item: AtomRef.AtomRef<unknown>, index: number) => unknown,
  })

/**
 * Render arms for an async boundary. Arm channels are accepted permissively
 * (`any`): the arms render at the node scope via the Reactive path and their
 * E/R are NOT folded into the boundary's result (the `effect`'s R is — that's
 * the thesis-bearing channel). Permissive `any` also matters for inference: a
 * JSX arm with a conditional folds its own channels to `any`, and a stricter
 * type here would reject it.
 */
interface AwaitArms<A, E> {
  readonly pending?: View | Effect.Effect<View, any, any>
  readonly onSuccess: (value: A) => View | Effect.Effect<View, any, any>
  readonly onError?: (cause: Cause.Cause<E>) => View | Effect.Effect<View, any, any>
}

/**
 * Async render boundary. Runs an Effect on the mount fiber and renders its
 * pending / success / error states — a leaf that owns one effectful data source
 * (a Resource, à la Solid; NOT React Suspense — no throw-and-catch, the boundary
 * handles its own states).
 *
 * The first argument is a **thunk** that produces the effect to run. The thunk
 * is run under dependency tracking (the same machinery as `h.track`): any
 * reactive ref it reads via `.value` becomes a dependency, and the boundary
 * **re-runs the effect when one changes**, interrupting the stale run. So a
 * static fetch and a reactive refetch are the same call — the deps are
 * discovered, not declared:
 *
 * ```tsx
 * const userId = AtomRef.make("42")        // buttons: userId.set("7")
 * const client = yield* Http               // service extracted up front
 *
 * {Await(() => client.getUser(userId.value), {   // reads userId.value → auto-refetch
 *   pending:   <Spinner/>,
 *   onError:   (cause) => <Err cause={cause}/>,
 *   onSuccess: (user)  => <UserCard user={user}/>,
 * })}
 * ```
 *
 * A thunk that reads no refs simply runs once. (The compiler rewrites `.value`
 * to `h.read`, which records the dep — so in `.vx` you just write
 * `userId.value` inside the thunk.)
 *
 * The thunk may be written inline OR extracted to a binding — the compiler
 * rewrites `.value`→`h.read` across the whole component body, not just in JSX
 * expressions, so `const get = () => http.getUser(userId.value)` then
 * `Await(get, …)` tracks identically to the inline form.
 *
 * Channels: extract services with `yield* Service` *before* the thunk so the
 * effect the thunk builds carries no `R` (it's already discharged into the
 * component's `R`); the boundary returns `Effect<View, never, Scope>`. `E` is
 * rendered through `onError`, not propagated — the boundary handles failure.
 * State is `AsyncResult` in a plain `AtomRef` rendered through the existing
 * `Reactive` node — no `Atom.runtime`, no new View IR, no `mount` changes.
 */
export const Await = <A, E, R>(
  effect: () => Effect.Effect<A, E, R>,
  arms: AwaitArms<A, E>,
): Effect.Effect<View, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const arm = (r: AsyncResult.AsyncResult<A, E>): unknown =>
      AsyncResult.match(r, {
        onInitial: () => arms.pending ?? null,
        onFailure: (f) => (arms.onError ? arms.onError(f.cause) : null),
        onSuccess: (s) => arms.onSuccess(s.value),
      })
    const view = AtomRef.make<unknown>(arm(AsyncResult.initial(true)))
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
          view.set(arm(AsyncResult.initial(true))) // waiting
          child = yield* Effect.forkChild(
            Effect.matchCause(eff, {
              onFailure: (cause) => { view.set(arm(AsyncResult.failure(cause))) },
              onSuccess: (value) => { view.set(arm(AsyncResult.success(value))) },
            }),
          )
        }
      }),
    )

    return View.Reactive({ source: view as AtomRef.ReadonlyRef<unknown> })
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
 * The base Layer every efx app needs. Provides the `AtomRegistry` so any
 * reactive children in the view tree have somewhere to live.
 *
 * Merge this with your app-specific Layers (Http, Db, Theme, etc.) before
 * passing to `Effect.provide`.
 */
export const EfxLive: Layer.Layer<AtomRegistry.AtomRegistry> = AtomRegistry.layer
