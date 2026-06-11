/**
 * Type-level smoke tests for `Component.make`. This file is type-checked but
 * never executed.
 *
 * Pins the two overloads: the generator form re-derives the channels the way
 * `Effect.fn` does; the Effect-returning form is identity-typed, so a generic
 * component survives the wrapper with its type parameter intact (issue #70's
 * acceptance).
 */
import { Effect } from "effect"
import * as Component from "./Component.ts"
import { h } from "./h.ts"
import type { View } from "./View.ts"
import type { TagE, TagProps, TagR } from "./types/Fold.ts"

// Test fixtures
interface HttpService { readonly _tag: "HttpService" }
class HttpError { readonly _tag = "HttpError" as const }
declare const someView: View

// Helper: assignability assertion (lhs must be subtype of rhs and vice versa)
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assertEquals<A, B extends Equals<A, B> extends true ? unknown : never>(): void

// 1) Generator body: construction E and R re-derive from the yielded effects,
//    the live channel rides the returned View's phantom — same as Effect.fn.
declare const genBody: (
  props: { id: string },
) => Generator<Effect.Effect<number, HttpError, HttpService>, View, never>
const Gen = Component.make(genBody, "Gen")
assertEquals<
  typeof Gen,
  (props: { id: string }) => Effect.Effect<View, HttpError, HttpService>
>()

declare const liveBody: (props: { id: string }) => Generator<never, View<HttpError>, never>
const Live = Component.make(liveBody, "Live")
assertEquals<ReturnType<typeof Live>, Effect.Effect<View<HttpError>, never, never>>()

// 2) A propless component needs NO props parameter at all — `function* ()`
//    is the idiom; the `_props: {} = {}` boilerplate is gone. The zero-param
//    shape stays directly callable AND usable as an h() tag (`<Counter />`
//    compiles to `h(Counter, {})`): `TagProps` of a zero-param tag folds to
//    the empty object, and the Tag* channel folds still extract.
declare const counterBody: () => Generator<never, View, never>
const Counter = Component.make(counterBody, "Counter")
const _noArgs: Effect.Effect<View, never, never> = Counter()
const _asTag = h(Counter, {})
assertEquals<typeof _asTag, Effect.Effect<View<never>, never, never>>()

declare const ProplessFailing: () => Effect.Effect<View, HttpError, HttpService>
assertEquals<TagE<typeof ProplessFailing>, HttpError>()
assertEquals<TagR<typeof ProplessFailing>, HttpService>()
const _proplessFolded = h("div", {}, h(ProplessFailing, {}))
assertEquals<typeof _proplessFolded, Effect.Effect<View<never>, HttpError, HttpService>>()

// 3) A GENERIC Effect-returning component typechecks through the wrapper with
//    its type parameter intact — the identity-typed overload. `n.toFixed` is
//    the proof: it compiles only if `T` was pinned to `number` at the call
//    site rather than collapsing to `unknown`.
const Row = Component.make(
  <T,>(props: { item: T; render: (item: T) => string }) => Effect.succeed(someView),
  "Row",
)
const _rowCall = Row({ item: 1, render: (n) => n.toFixed(2) })
assertEquals<typeof _rowCall, Effect.Effect<View, never, never>>()

// 4) A made component still drives the Tag* folds when used as an h() tag.
assertEquals<TagE<typeof Gen>, HttpError>()
assertEquals<TagR<typeof Gen>, HttpService>()
assertEquals<TagProps<typeof Gen>, { id: string }>()

