/**
 * Type-level smoke tests for the channel fold. This file is type-checked
 * but never executed.
 *
 * Each `expectType` line is a compile-time assertion. If a fold returns the
 * wrong type, the assignment errors at type-check time.
 */
import type { Effect } from "effect"
import type { Atom, AtomRef } from "effect/unstable/reactivity"
import type {
  ChildE,
  ChildLiveE,
  ChildR,
  FoldE,
  FoldLiveE,
  FoldPropsLiveE,
  FoldPropsR,
  FoldR,
} from "./Fold.ts"
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

// ─── View<E> error channel: construction vs live split (the boundary thesis) ──

// 10) A bare View<E> child: its live E rides the View; it's already built, so it
//     contributes no construction error and no R.
type ViewErr = View<HttpError>
assertEquals<ChildLiveE<ViewErr>, HttpError>()
assertEquals<ChildE<ViewErr>, never>()
assertEquals<ChildR<ViewErr>, never>()

// 11) An Effect whose SUCCESS is a View<E>: construction and live errors land on
//     different channels — Effect's own E is construction, the View's E is live.
type EffLive = Effect.Effect<View<HttpError>, NotFound, DbService>
assertEquals<ChildE<EffLive>, NotFound>()
assertEquals<ChildLiveE<EffLive>, HttpError>()
assertEquals<ChildR<EffLive>, DbService>()

// 12) Folds distribute the split over a tuple.
assertEquals<FoldE<readonly [ViewErr, EffLive]>, NotFound>()
assertEquals<FoldLiveE<readonly [ViewErr, EffLive]>, HttpError>()

// 13) A bare View<never> contributes nothing on any channel.
assertEquals<ChildLiveE<View>, never>()
assertEquals<ChildE<View>, never>()

// ─── Props fold: typed event handlers (#72) ──────────────────────────────

// 14) An Effect-returning handler contributes its E (live) and R.
type FailingClick = { onclick: (e: MouseEvent) => Effect.Effect<void, HttpError, HttpService> }
assertEquals<FoldPropsLiveE<FailingClick>, HttpError>()
assertEquals<FoldPropsR<FailingClick>, HttpService>()

// 15) A void/imperative handler contributes nothing.
type VoidClick = { onclick: (e: MouseEvent) => void }
assertEquals<FoldPropsLiveE<VoidClick>, never>()
assertEquals<FoldPropsR<VoidClick>, never>()

// 16) Non-handler props — strings, numbers, even a function NOT keyed `on*`
//     (the runtime stringifies it, never runs it) — contribute nothing.
type NoHandlers = {
  class: string
  tabindex: number
  format: () => Effect.Effect<void, HttpError, HttpService>
}
assertEquals<FoldPropsLiveE<NoHandlers>, never>()
assertEquals<FoldPropsR<NoHandlers>, never>()

// 17) Multiple handlers union their channels; mixed with inert props.
type TwoHandlers = {
  class: string
  onclick: (e: MouseEvent) => Effect.Effect<void, HttpError, HttpService>
  onkeydown: (e: KeyboardEvent) => Effect.Effect<void, NotFound, DbService>
  oninput: (e: Event) => void
}
assertEquals<FoldPropsLiveE<TwoHandlers>, HttpError | NotFound>()
assertEquals<FoldPropsR<TwoHandlers>, HttpService | DbService>()

// 18) An optional handler still folds (the `undefined` branch drops).
type OptionalClick = { onclick?: (e: MouseEvent) => Effect.Effect<void, HttpError, HttpService> }
assertEquals<FoldPropsLiveE<OptionalClick>, HttpError>()
assertEquals<FoldPropsR<OptionalClick>, HttpService>()

// 19) A tracked attr (`h.track` returns `unknown`) contributes nothing —
//     the channels were already erased upstream, the fold must not invent any.
type TrackedClick = { onclick: unknown }
assertEquals<FoldPropsLiveE<TrackedClick>, never>()
assertEquals<FoldPropsR<TrackedClick>, never>()

// 20) The empty props object (`h("div", {})` — the compiler's no-attrs shape).
//     Regression pin for the never-vacuous-conditional trap: `never extends
//     [infer E, any]` is true with NO candidates, resolving E to `unknown` —
//     these must stay literally `never`, not `unknown`.
assertEquals<FoldPropsLiveE<{}>, never>()
assertEquals<FoldPropsR<{}>, never>()

// 21) An `any`-typed handler (or handler RETURN — an untyped lib call) is
//     INERT, not poison: without the guard it would infer [unknown, unknown],
//     silently swallowing sibling handlers' channels one fold up and turning
//     R into an undischargeable blob. The sibling's channels must survive.
type AnyBeside = {
  onclick: (e: MouseEvent) => any
  onkeydown: (e: KeyboardEvent) => Effect.Effect<void, HttpError, HttpService>
}
assertEquals<FoldPropsLiveE<AnyBeside>, HttpError>()
assertEquals<FoldPropsR<AnyBeside>, HttpService>()
assertEquals<FoldPropsLiveE<{ onclick: any }>, never>()
assertEquals<FoldPropsR<{ onclick: any }>, never>()

// 22) The bare key "on" does NOT fold — runtime parity with applyProp's
//     `key.length > 2` gate (the runtime stringifies it, never attaches a
//     listener; folding would force a Catch that can never fire).
assertEquals<FoldPropsLiveE<{ on: () => Effect.Effect<void, HttpError> }>, never>()
assertEquals<FoldPropsR<{ on: () => Effect.Effect<void, never, HttpService> }>, never>()

// 23) UNION-typed props fold each member independently (a spread of a
//     conditional: `{...(cond ? withHandler : plain)}`). `keyof` of a union is
//     the key INTERSECTION, so without the distributive head a handler present
//     in only some members would silently erase.
type UnionProps =
  | { onclick: (e: MouseEvent) => Effect.Effect<void, HttpError, HttpService> }
  | { class: string }
assertEquals<FoldPropsLiveE<UnionProps>, HttpError>()
assertEquals<FoldPropsR<UnionProps>, HttpService>()

// 24) Key-gate parity matrix with the runtime's `isHandlerKey` (length > 2 &&
//     startsWith("on")) — `coerce.test.ts` pins the same table on the runtime
//     side. Minimum handler key is THREE chars ("onx"); the bare-"on"
//     exclusion is case 22's pin.
assertEquals<FoldPropsLiveE<{ onx: () => Effect.Effect<void, HttpError> }>, HttpError>()
assertEquals<FoldPropsLiveE<{ click: () => Effect.Effect<void, HttpError> }>, never>()

// 25) An AtomRef-valued handler folds THROUGH the ref to the inner function —
//     applyProp's AtomRef branch unwraps and re-applies it as a live listener,
//     so the wrapper must not hide the channels (custom `on*` keys admit refs
//     via the index signature).
type RefHandler = {
  onsave: AtomRef.ReadonlyRef<(e: Event) => Effect.Effect<void, HttpError, HttpService>>
}
assertEquals<FoldPropsLiveE<RefHandler>, HttpError>()
assertEquals<FoldPropsR<RefHandler>, HttpService>()
assertEquals<FoldPropsLiveE<{ onsave: AtomRef.ReadonlyRef<(e: Event) => void> }>, never>()

