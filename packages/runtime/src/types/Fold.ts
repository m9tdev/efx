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

/**
 * Walk a single child's type, peeling container layers, extracting the union
 * of every `E` channel encountered.
 *
 * Distributes over unions: if `C = A | B`, TS evaluates `ChildE<A> |
 * ChildE<B>` automatically.
 */
export type ChildE<C> =
  C extends Effect.Effect<any, infer E, any> ? E :
  C extends Option.Option<infer T> ? ChildE<T> :
  C extends Result.Result<infer A, any> ? ChildE<A> :
  C extends Chunk.Chunk<infer T> ? ChildE<T> :
  C extends Atom.Atom<infer T> ? ChildE<T> :
  C extends AtomRef.ReadonlyRef<infer T> ? ChildE<T> :
  C extends ReadonlyArray<infer T> ? ChildE<T> :
  never

/**
 * Walk a single child's type, peeling container layers, extracting the union
 * of every `R` channel encountered.
 *
 * Effect's `R` is encoded as a *union* type (each service is a member),
 * not an intersection — so we union here too.
 */
export type ChildR<C> =
  C extends Effect.Effect<any, any, infer R> ? R :
  C extends Option.Option<infer T> ? ChildR<T> :
  C extends Result.Result<infer A, any> ? ChildR<A> :
  C extends Chunk.Chunk<infer T> ? ChildR<T> :
  C extends Atom.Atom<infer T> ? ChildR<T> :
  C extends AtomRef.ReadonlyRef<infer T> ? ChildR<T> :
  C extends ReadonlyArray<infer T> ? ChildR<T> :
  never

/**
 * Fold a tuple of children to the union of their `E` channels.
 *
 * `Cs[number]` extracts the union of element types; `ChildE` distributes
 * over that union and returns the union of every E.
 */
export type FoldE<Cs extends readonly unknown[]> = ChildE<Cs[number]>

/**
 * Fold a tuple of children to the union of their `R` channels.
 */
export type FoldR<Cs extends readonly unknown[]> = ChildR<Cs[number]>

/**
 * When the JSX tag is a component function `(props) => Effect<View, E, R>`,
 * extract its `E` channel so `h(Component, ...)` contributes it to the
 * surrounding expression's type. String tags contribute `never`.
 */
export type TagE<T> = T extends (props: any) => Effect.Effect<any, infer E, any> ? E : never

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
