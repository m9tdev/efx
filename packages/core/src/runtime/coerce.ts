import { Cause, Chunk, Effect, Exit, Option, Result, Scope } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import type { ChildE, ChildR } from "./types/Fold.ts"
import { isView, View } from "./View.ts"

export const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && AtomRef.TypeId in u

/**
 * Where a runtime (post-mount) failure is routed instead of being swallowed.
 * A reactive re-render whose Effect fails, and (in `mount`) a failing event
 * handler, both hand their `Cause` to a sink threaded down from `mount`. The
 * root default logs; a `Catch` boundary replaces it per-subtree. Carries
 * `Cause<unknown>` because the build path is untyped — the type-level guarantee
 * that only declared errors reach a boundary lives in the fold, not here.
 */
export type ErrorSink = (cause: Cause.Cause<unknown>) => void

// ─── Dependency tracking (shared by h.track and Async) ───────────────────
//
// `currentTracker`, when set, collects every ref passed to `readTracked`.
// `trackDeps(thunk)` runs `thunk` with a fresh collector and returns its
// result plus the set of refs it read — the low-level primitive both the
// compiler-driven `h.track` and the `Async` boundary use to learn what to
// re-run on.

let currentTracker: Set<AtomRef.ReadonlyRef<unknown>> | null = null

export const trackDeps = <A>(
  thunk: () => A,
): { readonly result: A; readonly deps: Set<AtomRef.ReadonlyRef<unknown>> } => {
  const deps = new Set<AtomRef.ReadonlyRef<unknown>>()
  const prev = currentTracker
  currentTracker = deps
  try {
    return { result: thunk(), deps }
  } finally {
    currentTracker = prev
  }
}

/** Record `ref` as a dependency of the active `trackDeps` scope, if any. */
export const recordDep = (ref: AtomRef.ReadonlyRef<unknown>): void => {
  if (currentTracker) currentTracker.add(ref)
}

/**
 * Owns the subscribe/resubscribe/teardown bookkeeping that `h.track` and
 * `asyncRef` both need: a fresh set of dependency subscriptions on every run,
 * each firing `onChange`. Both callers re-run a thunk under `trackDeps` and
 * must re-subscribe to whatever refs that run read (a ternary's other branch,
 * an effect's new deps), so the prior subscriptions are dropped first.
 *
 * The `unsubs` array is nulled after each teardown because `AtomRef`'s
 * unsubscribe is **not idempotent** — replaying a stale unsubscriber would
 * corrupt a later subscription's bookkeeping. Once `dispose`d the manager is
 * inert: `resubscribe` is a no-op (a retained `refetch`/derived can fire after
 * its scope tears down), and `closed` lets a caller surface that to its own
 * callers.
 */
export const makeDepSubscription = (
  onChange: () => void,
): {
  resubscribe: (deps: Iterable<AtomRef.ReadonlyRef<unknown>>) => void
  dispose: () => void
  readonly closed: boolean
} => {
  let unsubs: Array<() => void> = []
  let closed = false
  const unsubscribeAll = () => {
    for (const u of unsubs) u()
    unsubs = []
  }
  return {
    resubscribe: (deps) => {
      if (closed) return
      unsubscribeAll()
      for (const dep of deps) unsubs.push(dep.subscribe(onChange))
    },
    dispose: () => {
      closed = true
      unsubscribeAll()
    },
    get closed() {
      return closed
    },
  }
}

/**
 * A `h.track` derived `AtomRef` stashes its `makeDepSubscription.dispose` here
 * so the subtree that mounts it can tear down the derived→underlying-ref
 * subscriptions on scope close. `h.track` has no scope of its own to register a
 * finalizer on (it's a plain sync call in a compiled component body), so the
 * one place that *does* scope the subscription — `subscribeRefScoped` in
 * `mount.ts` — disposes it via `getTrackDispose`. User refs and `asyncRef`'s
 * `state` (which owns its own teardown) carry no such tag, so the dispose is
 * `h.track`-only by construction.
 */
const TrackDisposeId = Symbol.for("verrex/trackDispose")

/** Tag `ref` with the `dispose` that tears down its tracked subscriptions. */
export const setTrackDispose = (
  ref: AtomRef.ReadonlyRef<unknown>,
  dispose: () => void,
): void => {
  ;(ref as { [TrackDisposeId]?: () => void })[TrackDisposeId] = dispose
}

/** The tracked-subscription dispose for `ref`, if it is a `h.track` derived. */
export const getTrackDispose = (
  ref: AtomRef.ReadonlyRef<unknown>,
): (() => void) | undefined => (ref as { [TrackDisposeId]?: () => void })[TrackDisposeId]

const Empty = View.Empty()

export function coerceAsync<C>(v: C): Effect.Effect<View, ChildE<C>, ChildR<C>>
export function coerceAsync(v: unknown): Effect.Effect<View, any, any> {
  if (v == null || v === false || v === true) return Effect.succeed(Empty)
  if (typeof v === "string") return Effect.succeed(View.Text({ value: v }))
  if (typeof v === "number" || typeof v === "bigint") {
    return Effect.succeed(View.Text({ value: String(v) }))
  }
  if (isView(v)) return Effect.succeed(v)
  if (Effect.isEffect(v)) {
    return Effect.flatMap(v as Effect.Effect<unknown, any, any>, coerceAsync)
  }
  if (Option.isOption(v)) {
    return Option.match(v, {
      onNone: () => Effect.succeed(Empty),
      onSome: coerceAsync,
    })
  }
  if (Result.isResult(v)) {
    return Result.match(v, {
      onFailure: () => Effect.succeed(Empty),
      onSuccess: coerceAsync,
    })
  }
  if (Chunk.isChunk(v)) return coerceChildren(Chunk.toReadonlyArray(v))
  if (Array.isArray(v)) return coerceChildren(v)
  if (Atom.isAtom(v)) {
    return Effect.succeed(View.Reactive({ source: v as Atom.Atom<View> }))
  }
  if (isAtomRef(v)) {
    return Effect.succeed(View.Reactive({ source: v as AtomRef.ReadonlyRef<View> }))
  }
  return Effect.succeed(View.Text({ value: String(v) }))
}

function coerceChildren<C>(cs: ReadonlyArray<C>): Effect.Effect<View, ChildE<C>, ChildR<C>>
function coerceChildren(cs: ReadonlyArray<unknown>): Effect.Effect<View, any, any> {
  return Effect.gen(function* () {
    const out: View[] = []
    for (const c of cs) {
      out.push(yield* coerceAsync(c))
    }
    return View.Fragment({ children: out })
  })
}

/**
 * Synchronously coerce an arbitrary value (typically read from a reactive
 * source at render time) into a View. `scope` is provided to any Effect-shaped
 * value via `Effect.provideService`, so `Effect.acquireRelease` /
 * `Effect.addFinalizer` inside the effect register releases against it.
 *
 * **Asymmetric vs. coerceAsync**: this path does NOT peel
 * Option/Result/Chunk/Atom/AtomRef. At render-time those containers have
 * already been unwrapped by the caller; if one shows up here it's coerced
 * via `String()` rather than silently expanded.
 *
 * A failing render Effect is **routed to `sink`** and renders nothing (an
 * `Empty` placeholder) — not stringified into the DOM as `[effect failed: …]`.
 * Pure-interrupt causes (a scope tearing down mid-render) are dropped, not
 * routed: they're teardown, not errors.
 */
export const coerceSync = (v: unknown, scope: Scope.Scope, sink: ErrorSink): View => {
  if (v == null || v === false || v === true) return Empty
  if (typeof v === "string") return View.Text({ value: v })
  if (typeof v === "number" || typeof v === "bigint") {
    return View.Text({ value: String(v) })
  }
  if (isView(v)) return v
  if (Effect.isEffect(v)) {
    const provided = Effect.provideService(
      v as Effect.Effect<unknown, unknown, Scope.Scope>,
      Scope.Scope,
      scope,
    )
    const exit = Effect.runSyncExit(provided)
    return Exit.match(exit, {
      onSuccess: (val) => coerceSync(val, scope, sink),
      onFailure: (cause) => {
        if (!Cause.hasInterruptsOnly(cause)) sink(cause)
        return Empty
      },
    })
  }
  if (Array.isArray(v)) {
    return View.Fragment({ children: v.map((x) => coerceSync(x, scope, sink)) })
  }
  return View.Text({ value: String(v) })
}
