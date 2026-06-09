/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Cause, Chunk, Effect, Option, Result, Scope } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { Catch, h, mount, type View } from "@verrex/core"
import { AsyncUserPage } from "./AsyncUserPage.vx"
import { Counter } from "./Counter.vx"
import { LiveUser } from "./LiveUser.vx"
import { HttpError, Http, Theme } from "./services.ts"
import { UserPage } from "./UserPage.vx"

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assertEquals<A, B extends Equals<A, B> extends true ? unknown : never>(): void

// ─── UserPage carries E = HttpError, R = Http | Theme ───────────────────
//     (in-component fetch: failure folds E to the root, blocking)

type UserPageType = ReturnType<typeof UserPage>
assertEquals<UserPageType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── AsyncUserPage: the same fetch behind an `Async` boundary. The boundary
//     handles failure locally (the failure arm), so E is `never`; Http still folds
//     (fetch on the mount fiber), plus Scope from the fork (`forkScoped`).
//     Same data, opposite E — the boundary vs. fold-to-root contrast, both
//     compile-time enforced.

type AsyncUserPageType = ReturnType<typeof AsyncUserPage>
assertEquals<AsyncUserPageType, Effect.Effect<View, never, Http | Scope.Scope>>()

// ─── Counter is pure (no E or R from the component itself; AtomRegistry
//     is added at mount) ──────────────────────────────────────────────────

type CounterType = ReturnType<typeof Counter>
assertEquals<CounterType, Effect.Effect<View, never, never>>()

// ─── LiveUser fetches async data via the auto-tracking `Async` boundary
//     (`Async(() => http.getUser(userId.value), …)`). Because the service is
//     extracted up front (`const http = yield* Http`) and the fetch runs on the
//     mount fiber (not a baked Atom.runtime), `Http` stays in R — a forgotten
//     layer is a compile error. `E` is `never`: the boundary renders failure via the
//     failure arm rather than propagating it. (This is the thesis the boundary
//     protects.)

type LiveUserType = ReturnType<typeof LiveUser>
assertEquals<LiveUserType, Effect.Effect<View, never, Http | Scope.Scope>>()

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

// ─── Event handlers on intrinsic elements get typed event arguments ─────

h("button", {
  onclick: (e) => {
    const _: number = e.button          // MouseEvent has .button
    void _
  },
})

h("input", {
  oninput: (e) => {
    const _: EventTarget | null = e.target  // Event
    void _
  },
})

h("input", {
  onkeydown: (e) => {
    const _: string = e.key             // KeyboardEvent has .key
    void _
  },
})

h("form", {
  onsubmit: (e) => {
    const _: HTMLElement | null = e.submitter as HTMLElement | null
    void _
  },
})

// @ts-expect-error — wrong event type: KeyboardEvent ↛ MouseEvent
h("button", { onclick: (_e: KeyboardEvent) => {} })

// Handlers may take fewer args than the event signature (function variance)
h("button", { onclick: () => {} })

// Arbitrary attributes still pass through (intersection with index signature)
h("div", { "data-id": "x", "aria-hidden": "true", customX: 42 })

// ─── Props are type-checked against the component's declared shape ───────

// @ts-expect-error — missing required prop `userId`
const Missing = h(UserPage, {})
void Missing

// @ts-expect-error — typo: `userid` is not in `{ userId: string }`
const Typo = h(UserPage, { userid: "42" })
void Typo

// @ts-expect-error — wrong type: number not assignable to string
const WrongType = h(UserPage, { userId: 42 })
void WrongType

// @ts-expect-error — extra prop not declared on component
const Extra = h(UserPage, { userId: "42", nope: true })
void Extra

// ─── Container parity: ChildE/ChildR must peel exactly what coerceAsync
//     peels at runtime (Fold.ts ↔ coerce.ts). A shape folded here but not
//     peeled there makes the channel claim a *lie* (the type promises an E/R
//     the runtime would `String(v)` away). These pin the inner Effect's E/R
//     folding through each peelable container. `Stream` is in NEITHER — it is
//     deliberately not peeled, so it contributes no channels.

declare const optEff: Option.Option<Effect.Effect<View, HttpError, Http>>
const WithOption = h("div", {}, optEff)
assertEquals<typeof WithOption, Effect.Effect<View, HttpError, Http>>()

declare const resEff: Result.Result<Effect.Effect<View, HttpError, Http>, unknown>
const WithResult = h("div", {}, resEff)
assertEquals<typeof WithResult, Effect.Effect<View, HttpError, Http>>()

declare const chunkEff: Chunk.Chunk<Effect.Effect<View, HttpError, Http>>
const WithChunk = h("div", {}, chunkEff)
assertEquals<typeof WithChunk, Effect.Effect<View, HttpError, Http>>()

// ─── The error-boundary thesis: discharge-or-it-won't-compile ───────────
//     `Catch` discharges a subtree's errors; `mount` requires a fully
//     discharged app (`View<never>`, `never`). A forgotten boundary is a
//     compile error that NAMES the error — the runtime counterpart of a
//     forgotten Layer naming a service.

declare const root: HTMLElement

// Catch-all (function form) turns a failing subtree into a fully-discharged one.
// The handler's cause is precisely typed — `Cause<HttpError>`, not `Cause<unknown>`.
const Caught = Catch(UserPage({ userId: "42" }), (cause, reset) => {
  const _typedCause: Cause.Cause<HttpError> = cause
  void _typedCause
  void reset
  return h("div", {}, "failed")
})
// E discharged to `never`; UserPage's `Http | Theme` fold through, plus `Scope`
// from the boundary's fork.
assertEquals<typeof Caught, Effect.Effect<View, never, Http | Theme | Scope.Scope>>()

// @ts-expect-error — UserPage's HttpError is undischarged: `mount` rejects it,
// and the error names `HttpError` (not assignable to `never`). Forgot a boundary.
mount(UserPage({ userId: "42" }), root)

// With the boundary, the same app mounts.
mount(Caught, root)

// A pure component needs no boundary — it's already `View<never>`, `never`.
mount(Counter(), root)

// ─── Catch tag-map form narrows the error channel by tag ────────────────
//     Handle specific tags; the rest stay on the channel and must still be
//     discharged before `mount`. A typo'd tag key is a compile error.

class ParseError {
  readonly _tag = "ParseError" as const
  readonly message = ""
}
declare const TwoErrors: Effect.Effect<View, HttpError | ParseError, Http>

// Handle one tag → handler gets the unwrapped error; both channels narrow by
// `Exclude<E, { _tag }>`.
const CaughtHttp = Catch(TwoErrors, {
  HttpError: (e, reset) => {
    const _status: number = e.status
    void _status
    void reset
    return h("p", {}, "http error")
  },
})
assertEquals<typeof CaughtHttp, Effect.Effect<View, ParseError, Http | Scope.Scope>>()

// @ts-expect-error — "Nope" is not one of the child's error tags
Catch(TwoErrors, { Nope: () => h("p", {}, "x") })

// @ts-expect-error — ParseError is still undischarged; mount rejects it, naming it
mount(CaughtHttp, root)

// Handle the remaining tag → fully discharged, mountable.
const CaughtBoth = Catch(CaughtHttp, {
  ParseError: (e) => {
    const _msg: string = e.message
    void _msg
    return h("p", {}, "parse error")
  },
})
assertEquals<typeof CaughtBoth, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(CaughtBoth, root)

// Handle every tag at once → discharged, mountable.
const AllTags = Catch(TwoErrors, {
  HttpError: (e) => h("p", {}, `${e.status}`),
  ParseError: (e) => h("p", {}, e.message),
})
assertEquals<typeof AllTags, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(AllTags, root)

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
// The `@ts-expect-error` assertions above prove props are type-checked at
// JSX call sites, and that a forgotten error boundary fails to compile.
