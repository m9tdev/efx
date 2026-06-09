import type { Chunk, Effect, Option, Result } from "effect"
import type { Atom, AtomRef } from "effect/unstable/reactivity"
import type { View } from "../View.ts"
import type { IntrinsicProps } from "./Html.ts"

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
//  - ChildE / TagE → CONSTRUCTION errors, on the result Effect's `E` channel
//    (a child's build Effect failing propagates as the parent build fails).
//  - ChildLiveE / TagLiveE → LIVE errors, on the result `View<E>` channel
//    (errors a rendered subtree can still produce — they ride the child's
//    `View<E>` success). `R` unifies (one Layer set serves both phases), so
//    there is a single `ChildR` / `TagR`.
// A `Catch` boundary discharges both; `mount` requires both `never`.

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
  C extends View<infer VE> ? VE :
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

/**
 * When the JSX tag is a component function `(props) => Effect<View<EV>, E, R>`,
 * extract its **construction** `E` so `h(Component, ...)` contributes it to the
 * result Effect's `E`. String tags contribute `never`.
 */
export type TagE<T> = T extends (props: any) => Effect.Effect<any, infer E, any> ? E : never

/**
 * Same, for the tag's **live** `E` — the `EV` riding its `View<EV>` success,
 * contributed to the result `View<E>` channel.
 */
export type TagLiveE<T> = T extends (props: any) => Effect.Effect<infer A, any, any>
  ? ChildLiveE<A>
  : never

/**
 * Same, for the tag's `R` channel.
 */
export type TagR<T> = T extends (props: any) => Effect.Effect<any, any, infer R> ? R : never

/**
 * The props shape a component tag expects, with `children` stripped (the JSX
 * factory threads children separately).
 *
 * For string tags ("div", "span", …) we fall back to the loose `Props` type;
 * a future improvement could thread `JSX.IntrinsicElements`-style HTML
 * attribute typing here.
 */
export type TagProps<T> =
  T extends string
    ? IntrinsicProps
    : T extends (props: infer P) => any
      ? Omit<P, "children">
      : Readonly<Record<string, unknown>>
