/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Chunk, Effect, Option, Result, Scope } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { h, type View } from "@efx/runtime"
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

// ─── AsyncUserPage: the same fetch behind an `Await` boundary. The boundary
//     handles failure locally (onError), so E is `never`; Http still folds
//     (fetch on the mount fiber), plus Scope from the fork (`forkScoped`).
//     Same data, opposite E — the boundary vs. fold-to-root contrast, both
//     compile-time enforced.

type AsyncUserPageType = ReturnType<typeof AsyncUserPage>
assertEquals<AsyncUserPageType, Effect.Effect<View, never, Http | Scope.Scope>>()

// ─── Counter is pure (no E or R from the component itself; AtomRegistry
//     is added at mount) ──────────────────────────────────────────────────

type CounterType = ReturnType<typeof Counter>
assertEquals<CounterType, Effect.Effect<View, never, never>>()

// ─── LiveUser fetches async data via the auto-tracking `Await` boundary
//     (`Await(() => http.getUser(userId.value), …)`). Because the service is
//     extracted up front (`const http = yield* Http`) and the fetch runs on the
//     mount fiber (not a baked Atom.runtime), `Http` stays in R — a forgotten
//     layer is a compile error. `E` is `never`: the boundary renders failure via
//     onError rather than propagating it. (This is the thesis the boundary
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

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
// The `@ts-expect-error` assertions above prove props are type-checked at
// JSX call sites.
