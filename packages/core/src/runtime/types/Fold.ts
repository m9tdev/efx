import type { Chunk, Effect, Option, Result } from "effect"
import type { Atom, AtomRef } from "effect/unstable/reactivity"
import type { View } from "../View.ts"

/**
 * Documentation-only type listing the leaf shapes a child can take. The
 * actual `h()` constraint is `readonly unknown[]` because TypeScript rejects
 * recursive type aliases that branch through multiple generic instantiations.
 *
 * Recursion is handled at the use site by `ChildE`/`ChildR` — they recurse
 * via `infer` inside conditional types, which TS does support.
 *
 * This set must stay in lockstep with the containers `coerceAsync` peels in
 * `../coerce.ts` (Effect, Option, Result, Chunk, Atom, AtomRef, array). A
 * shape listed here but not peeled there makes the channel fold *lie* — the
 * type claims an E/R the runtime never produces (it would `String(v)` the
 * value instead). `apps/demo/src/channels.test-d.ts` pins this parity.
 */
export type Child =
  | Effect.Effect<View, any, any>
  | View
  | string
  | number
  | boolean
  | null
  | undefined
  | Option.Option<unknown>
  | Result.Result<unknown, any>
  | Chunk.Chunk<unknown>
  | Atom.Atom<unknown>
  | AtomRef.ReadonlyRef<unknown>
  | ReadonlyArray<unknown>

// Errors live in two honest homes by phase, so the fold has two families:
//  - ChildE → CONSTRUCTION errors, on the result Effect's `E` channel
//    (a child's build Effect failing propagates as the parent build fails).
//  - ChildLiveE → LIVE errors, on the result `View<E>` channel
//    (errors a rendered subtree can still produce — they ride the child's
//    `View<E>` success). `R` unifies (one Layer set serves both phases), so
//    there is a single `ChildR`.
// A `Catch` boundary discharges both; `mount` requires both `never`.
// Component tags need no fold family of their own: since #71 the compiler
// lowers `<MyComp/>` to a direct `MyComp({...})` call, so a component's
// channels surface as an ordinary Effect CHILD of the surrounding `h()`.

/**
 * Walk a single child's type, extracting the union of every **construction**
 * `E` — an Effect child's own error channel. A bare `View<E>` child is already
 * built, so it contributes no construction error (its live `E` is `ChildLiveE`'s
 * job). Distributes over unions automatically.
 */
export type ChildE<C> =
  C extends Effect.Effect<any, infer E, any> ? E :
  C extends View<any> ? never :
  C extends Option.Option<infer T> ? ChildE<T> :
  C extends Result.Result<infer A, any> ? ChildE<A> :
  C extends Chunk.Chunk<infer T> ? ChildE<T> :
  C extends Atom.Atom<infer T> ? ChildE<T> :
  C extends AtomRef.ReadonlyRef<infer T> ? ChildE<T> :
  C extends ReadonlyArray<infer T> ? ChildE<T> :
  never

/**
 * Walk a single child's type, extracting the union of every **live** `E` — the
 * error a rendered subtree can still produce after construction. It reads the
 * phantom `E` off a bare `View<E>` child, and recurses into an Effect's *success*
 * (where a `View<E>` rides) — ignoring the Effect's own `E`, which is
 * construction (`ChildE`'s job). One `infer` at the `View` leaf, no walk into the
 * View's children, so the recursion stays shallow.
 */
export type ChildLiveE<C> =
  C extends Effect.Effect<infer A, any, any> ? ChildLiveE<A> :
  // Coalesce `unknown`→`never`: a phantom-free `ViewNode` (no `ViewErr`) matches
  // `View<infer VE>` with `VE = unknown`; treat it as no live error rather than
  // poisoning the fold. (Latent — `ViewNode` isn't part of the public child shapes.)
  C extends View<infer VE> ? ([unknown] extends [VE] ? never : VE) :
  C extends Option.Option<infer T> ? ChildLiveE<T> :
  C extends Result.Result<infer A, any> ? ChildLiveE<A> :
  C extends Chunk.Chunk<infer T> ? ChildLiveE<T> :
  C extends Atom.Atom<infer T> ? ChildLiveE<T> :
  C extends AtomRef.ReadonlyRef<infer T> ? ChildLiveE<T> :
  C extends ReadonlyArray<infer T> ? ChildLiveE<T> :
  never

/**
 * Walk a single child's type, extracting the union of every `R` channel.
 *
 * Effect's `R` is encoded as a *union* type (each service is a member),
 * not an intersection — so we union here too. A `View<E>` carries no `R`.
 */
export type ChildR<C> =
  C extends Effect.Effect<any, any, infer R> ? R :
  C extends View<any> ? never :
  C extends Option.Option<infer T> ? ChildR<T> :
  C extends Result.Result<infer A, any> ? ChildR<A> :
  C extends Chunk.Chunk<infer T> ? ChildR<T> :
  C extends Atom.Atom<infer T> ? ChildR<T> :
  C extends AtomRef.ReadonlyRef<infer T> ? ChildR<T> :
  C extends ReadonlyArray<infer T> ? ChildR<T> :
  never

/** Fold a tuple of children to the union of their construction `E` channels. */
export type FoldE<Cs extends readonly unknown[]> = ChildE<Cs[number]>

/** Fold a tuple of children to the union of their live `E` channels (`View<E>`). */
export type FoldLiveE<Cs extends readonly unknown[]> = ChildLiveE<Cs[number]>

/** Fold a tuple of children to the union of their `R` channels. */
export type FoldR<Cs extends readonly unknown[]> = ChildR<Cs[number]>

// ─── Props fold: typed event handlers (#72) ────────────────────────────────
//
// An event handler is where most LIVE errors are born: the element is already
// rendered when the handler runs, so its failure has no construction channel
// to ride. The runtime side has always existed (`applyProp` runs a returned
// Effect on the mount context and routes its failure to the boundary sink) —
// these types make it visible: a handler returning `Effect<_, E, R>`
// contributes `E` to the element's live channel (`View<E>`, dischargeable by
// `Catch`, gated by `mount`) and `R` to the element's requirements (a missing
// Layer is a compile error at `mount`).
//
// Only `on*`-keyed props fold. That mirrors the runtime exactly: `applyProp`
// attaches a listener (and runs returned Effects) only for `on*` function
// props; any other function-valued attr is stringified into an attribute and
// never invoked — folding it would make the type claim an `E` that can never
// fire. (The same parity rule as `Child` ↔ `coerceAsync`.)

/**
 * The live `E` of one handler prop: a function returning `Effect<_, E, _>`
 * contributes `E`; a void/imperative handler, a non-function value, or a
 * tracked-`unknown` attr contributes nothing.
 */
type HandlerLiveE<H> = H extends (...args: ReadonlyArray<any>) => infer Ret
  ? Ret extends Effect.Effect<any, infer E, any> ? E : never
  : never

/** The `R` of one handler prop — same shape as `HandlerLiveE`, R channel. */
type HandlerR<H> = H extends (...args: ReadonlyArray<any>) => infer Ret
  ? Ret extends Effect.Effect<any, any, infer R> ? R : never
  : never

/** Fold a props object to the union of its `on*` handlers' live `E` channels. */
export type FoldPropsLiveE<P> = {
  [K in keyof P]-?: K extends `on${string}` ? HandlerLiveE<P[K]> : never
}[keyof P]

/** Fold a props object to the union of its `on*` handlers' `R` channels. */
export type FoldPropsR<P> = {
  [K in keyof P]-?: K extends `on${string}` ? HandlerR<P[K]> : never
}[keyof P]
