/**
 * Type-level smoke tests for the channel fold. This file is type-checked
 * but never executed.
 *
 * Each `expectType` line is a compile-time assertion. If a fold returns the
 * wrong type, the assignment errors at type-check time.
 */
import type { Effect } from "effect"
import type { Atom, AtomRef } from "effect/unstable/reactivity"
import type { ChildE, ChildR, FoldE, FoldR } from "./Fold.ts"
import type { View } from "../View.ts"

// Test fixtures
interface HttpService { readonly _tag: "HttpService" }
interface DbService { readonly _tag: "DbService" }
class HttpError { readonly _tag = "HttpError" as const }
class NotFound { readonly _tag = "NotFound" as const }

type Eff1 = Effect.Effect<View, HttpError, HttpService>
type Eff2 = Effect.Effect<View, NotFound, DbService>

// Helper: assignability assertion (lhs must be subtype of rhs and vice versa)
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assertEquals<A, B extends Equals<A, B> extends true ? unknown : never>(): void

// 1) Single Effect child contributes its E and R
assertEquals<ChildE<Eff1>, HttpError>()
assertEquals<ChildR<Eff1>, HttpService>()

// 2) Tuple of effects unions E and R
assertEquals<FoldE<readonly [Eff1, Eff2]>, HttpError | NotFound>()
assertEquals<FoldR<readonly [Eff1, Eff2]>, HttpService | DbService>()

// 3) Primitives contribute nothing
assertEquals<FoldE<readonly [string, number, null, undefined, boolean]>, never>()
assertEquals<FoldR<readonly [string, number, null, undefined, boolean]>, never>()

// 4) Mixed primitives + effects only contribute the effects' channels
assertEquals<FoldE<readonly [string, Eff1, number]>, HttpError>()
assertEquals<FoldR<readonly [string, Eff1, number]>, HttpService>()

// 5) Array of effects peels the array layer
assertEquals<FoldE<readonly [ReadonlyArray<Eff1>]>, HttpError>()
assertEquals<FoldR<readonly [ReadonlyArray<Eff2>]>, DbService>()

// 6) AtomRef of an Effect peels the ref and surfaces the effect's channels
type Ref = AtomRef.ReadonlyRef<Eff1>
assertEquals<FoldE<readonly [Ref]>, HttpError>()
assertEquals<FoldR<readonly [Ref]>, HttpService>()

// 7) Atom of a View contributes nothing (View has no channels)
type AtomView = Atom.Atom<View>
assertEquals<FoldE<readonly [AtomView]>, never>()
assertEquals<FoldR<readonly [AtomView]>, never>()

// 8) Conditional render (`false | Effect<...>`) — false drops, effect contributes
type CondChild = false | Eff1
assertEquals<FoldE<readonly [CondChild]>, HttpError>()
assertEquals<FoldR<readonly [CondChild]>, HttpService>()

// 9) Ternary render (Eff1 | Eff2) — unions both
type EitherChild = Eff1 | Eff2
assertEquals<FoldE<readonly [EitherChild]>, HttpError | NotFound>()
assertEquals<FoldR<readonly [EitherChild]>, HttpService | DbService>()
