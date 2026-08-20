import { Cause, Effect, Exit, Scope } from "effect"
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

// ─── AtomRef → Atom bridge (used by h.reader) ─────────────────────────────

/**
 * The AtomRef→Atom bridge. An `Atom`'s read context tracks only `Atom`
 * dependencies, so a reader's `get(ref)` deps enter the reactive graph
 * through this: an Atom that subscribes to the ref (pushing changes via
 * `setSelf`) and unsubscribes in its node finalizer — the same
 * external-source pattern effect uses internally. The registry refcounts the
 * node, so the ref subscription exists exactly while something downstream
 * (a mounted `h.reader`) is subscribed — no manual teardown anywhere.
 *
 * Memoized per ref: the graph keys dependencies by atom object identity, so
 * every reader reading the same ref must `get` the same bridge.
 *
 * The cache is module-global, ACROSS registries, and that's safe: an Atom is
 * a description, not a node — each registry keys its own node state per
 * atom, so one bridge object mounted in two registries is two independent
 * nodes with independent subscriptions and finalizers. Scoping the cache
 * per registry would only allocate duplicate bridges for the same ref.
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
  // Arrays are STRUCTURE (how a JSX expression yields several children —
  // `{items.map(…)}`, a compiled `<>…</>`, spread children), so they peel.
  // Effect's value containers (Option / Result / Chunk / AsyncResult) do NOT:
  // they are values the author maps explicitly (`Option.getOrNull`,
  // `Result.match`, `Chunk.toReadonlyArray`, `AsyncResult.builder`). Do NOT
  // peel them implicitly — it hides a channel (a `Result.Failure` would render
  // nothing, error dropped) and reads as magic. Anything unrecognised is
  // stringified.
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
 * **Asymmetric vs. coerceAsync**: this path does NOT peel Atom/AtomRef (a
 * nested reactive source at render time is coerced via `String()` rather
 * than silently expanded). Neither path peels Effect's value containers
 * (Option/Result/Chunk/AsyncResult) — see coerceAsync.
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
