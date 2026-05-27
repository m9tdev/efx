import { Chunk, Effect, Exit, Option, Result, Scope } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import type { ChildE, ChildR } from "./types/Fold.ts"
import { isView, View } from "./View.ts"

export const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && AtomRef.TypeId in u

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
 * source at render time) into a View. If `scope` is provided and the value
 * is an Effect, the effect is run with that scope, so `Effect.acquireRelease`
 * / `Effect.addFinalizer` inside the effect register releases against it.
 *
 * **Asymmetric vs. coerceAsync**: this path does NOT peel
 * Option/Result/Chunk/Atom/AtomRef. At render-time those containers have
 * already been unwrapped by the caller; if one shows up here it's coerced
 * via `String()` rather than silently expanded.
 */
export const coerceSync = (v: unknown, scope?: Scope.Closeable): View => {
  if (v == null || v === false || v === true) return Empty
  if (typeof v === "string") return View.Text({ value: v })
  if (typeof v === "number" || typeof v === "bigint") {
    return View.Text({ value: String(v) })
  }
  if (isView(v)) return v
  if (Effect.isEffect(v)) {
    const provided = scope
      ? Effect.provideService(v as Effect.Effect<unknown, unknown, Scope.Scope>, Scope.Scope, scope)
      : (v as Effect.Effect<unknown, unknown, never>)
    const exit = Effect.runSyncExit(provided)
    return Exit.match(exit, {
      onSuccess: (val) => coerceSync(val, scope),
      onFailure: (cause) =>
        View.Text({ value: `[effect failed: ${String(cause)}]` }),
    })
  }
  if (Array.isArray(v)) {
    return View.Fragment({ children: v.map((x) => coerceSync(x, scope)) })
  }
  return View.Text({ value: String(v) })
}
