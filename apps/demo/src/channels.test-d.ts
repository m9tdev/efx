/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Effect } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { h, type View } from "@effx/runtime"
import { Counter } from "./Counter"
import { HttpError, Http, Theme } from "./services.ts"
import { UserPage } from "./UserPage"

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assertEquals<A, B extends Equals<A, B> extends true ? unknown : never>(): void

// ─── UserPage carries E = HttpError, R = Http | Theme ───────────────────

type UserPageType = ReturnType<typeof UserPage>
assertEquals<UserPageType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Counter is pure (no E or R from the component itself; AtomRegistry
//     is added at mount) ──────────────────────────────────────────────────

type CounterType = ReturnType<typeof Counter>
assertEquals<CounterType, Effect.Effect<View, never, never>>()

// ─── Composition: a tree containing UserPage AND Counter unions channels ─

const Composed = h("div", {},
  Counter(),
  UserPage({ userId: "42" }),
)

type ComposedType = typeof Composed
// E unions HttpError (only UserPage contributes E).
// R unions Http | Theme. (Counter contributes nothing; AtomRegistry is mount's concern.)
assertEquals<ComposedType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Conditional render preserves channels ─────────────────────────────

declare const flag: boolean
const WithCond = h("div", {}, flag && UserPage({ userId: "42" }))
type WithCondType = typeof WithCond
assertEquals<WithCondType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Array of effects preserves channels ───────────────────────────────

declare const ids: string[]
const WithList = h("ul", {}, ids.map((id) => UserPage({ userId: id })))
type WithListType = typeof WithList
assertEquals<WithListType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── <Component /> form: h(Component, props) carries the component's E/R ─

const CounterAsTag = h(Counter, {})
assertEquals<typeof CounterAsTag, Effect.Effect<View, never, never>>()

const UserPageAsTag = h(UserPage, { userId: "42" })
assertEquals<typeof UserPageAsTag, Effect.Effect<View, HttpError, Http | Theme>>()

// Tag E/R unions with child E/R
const Mixed = h("div", {},
  h(UserPage, { userId: "42" }),       // tag contributes HttpError + Http | Theme
  h(Counter, {}),                       // contributes nothing
)
assertEquals<typeof Mixed, Effect.Effect<View, HttpError, Http | Theme>>()

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
