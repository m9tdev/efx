import { Cause, Chunk, Effect, Exit, Option, Result, Scope } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import type { ChildE, ChildR } from "./types/Fold.ts"
import { isView, View } from "./View.ts"

export const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && AtomRef.TypeId in u

/**
 * THE handler-key gate, shared by every consumer so they can't drift:
 * `applyProp` (attach listener + run returned Effects), `h()`'s
 * capture-context predicate, and — mirrored at the type level —
 * `FoldPropsChannels` in types/Fold.ts (`on${string}` minus the bare `"on"`,
 * which this `length > 2` excludes). If you change this, change the fold's
 * key conditional in the same commit; `types/Fold.test-d.ts` pins the type
 * side of the matrix and `coerce.test.ts` pins this side.
 */
export const isHandlerKey = (key: string): boolean =>
  key.length > 2 && key.startsWith("on")

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
 * Owns the subscribe/resubscribe/teardown bookkeeping `asyncRef` needs: a
 * fresh set of dependency subscriptions on every run, each firing `onChange`.
 * The caller re-runs a thunk under `trackDeps` and must re-subscribe to
 * whatever refs that run read (an effect's new deps), so the prior
 * subscriptions are dropped first. (`h.track` used to share this; it is now
 * a demand-driven `Atom` — see `bridgeAtom` — whose registry owns the same
 * lifecycle by refcount.)
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
 * The AtomRef→Atom bridge. An `Atom`'s read context tracks only `Atom`
 * dependencies, so a tracked thunk's `AtomRef` deps enter the reactive graph
 * through this: an Atom that subscribes to the ref (pushing changes via
 * `setSelf`) and unsubscribes in its node finalizer — the same
 * external-source pattern effect uses internally. The registry refcounts the
 * node, so the ref subscription exists exactly while something downstream
 * (a mounted `h.track` derived) is subscribed — no manual teardown anywhere.
 *
 * Memoized per ref: the graph keys dependencies by atom object identity, so
 * every `h.track` derived reading the same ref must `get` the same bridge.
 */
const bridgeCache = new WeakMap<
  AtomRef.ReadonlyRef<unknown>,
  Atom.Atom<unknown>
>()

export const bridgeAtom = (
  ref: AtomRef.ReadonlyRef<unknown>,
): Atom.Atom<unknown> => {
  let atom = bridgeCache.get(ref)
  if (atom === undefined) {
    atom = Atom.readable((get) => {
      get.addFinalizer(ref.subscribe((v) => get.setSelf(v)))
      return ref.value
    })
    bridgeCache.set(ref, atom)
  }
  return atom
}

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
  // Reactive nodes capture the construction context so their re-renders run
  // on it — a mid-tree Effect.provide reaches every rebuild, not just the
  // first paint (see ViewReactive.context).
  if (Atom.isAtom(v) || isAtomRef(v)) {
    return Effect.map(Effect.context<never>(), (context) =>
      View.Reactive({
        source: v as Atom.Atom<View> | AtomRef.ReadonlyRef<View>,
        context,
      }),
    )
  }
  return Effect.succeed(View.Text({ value: String(v) }))
}

function coerceChildren<C>(
  cs: ReadonlyArray<C>,
): Effect.Effect<View, ChildE<C>, ChildR<C>>
function coerceChildren(
  cs: ReadonlyArray<unknown>,
): Effect.Effect<View, any, any> {
  return Effect.gen(function* () {
    const out: View[] = []
    for (const c of cs) {
      out.push(yield* coerceAsync(c))
    }
    return View.Fragment({ children: out })
  })
}

/**
 * Runs a ready Effect to an Exit on a fixed context — a partially-applied
 * `Effect.runSyncExitWith(context)`, built once per BuildCtx (mount root /
 * a `withContext` derivation for a context-carrying IR node) and reused for
 * every render, instead of re-applying the curried runner per coercion.
 */
export type SyncRunner = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Exit.Exit<A, E>

/**
 * Synchronously coerce an arbitrary value (typically read from a reactive
 * source at render time) into a View. `scope` is provided to any Effect-shaped
 * value via `Effect.provideService`, so `Effect.acquireRelease` /
 * `Effect.addFinalizer` inside the effect register releases against it — INSIDE
 * the run, so the per-render scope wins over any stale `Scope` entry the
 * runner's context may carry. `run` executes the effect on the right ambient
 * context (see `SyncRunner` and ViewReactive/ViewList `.context`), which is
 * what lets a dynamically-built subtree resolve construction services and
 * capture real contexts for its handlers.
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
export const coerceSync = (
  v: unknown,
  scope: Scope.Scope,
  sink: ErrorSink,
  run: SyncRunner,
): View => {
  if (v == null || v === false || v === true) return Empty
  if (typeof v === "string") return View.Text({ value: v })
  if (typeof v === "number" || typeof v === "bigint") {
    return View.Text({ value: String(v) })
  }
  if (isView(v)) return v
  if (Effect.isEffect(v)) {
    // An already-resolved Effect (an Exit — e.g. Effect.succeed) needs no
    // scope, no context, and no fiber: feed it straight to Exit.match.
    // Wrapping it in provideService first would defeat effect's own Exit fast
    // path and spin a full fiber per re-render just to read a constant.
    const exit = Exit.isExit(v)
      ? (v as Exit.Exit<unknown, unknown>)
      : run(
          Effect.provideService(
            v as Effect.Effect<unknown, unknown, Scope.Scope>,
            Scope.Scope,
            scope,
          ),
        )
    return Exit.match(exit, {
      onSuccess: (val) => coerceSync(val, scope, sink, run),
      onFailure: (cause) => {
        if (!Cause.hasInterruptsOnly(cause)) sink(cause)
        return Empty
      },
    })
  }
  if (Array.isArray(v)) {
    return View.Fragment({
      children: v.map((x) => coerceSync(x, scope, sink, run)),
    })
  }
  return View.Text({ value: String(v) })
}
