/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Chunk, Option, Result, Scope } from "effect"
import { Cause, Effect, Stream } from "effect"
import { Atom, AtomRegistry, type AtomRef } from "effect/unstable/reactivity"
import {
  Async,
  type AsyncHandle,
  Catch,
  type EventHandler,
  h,
  list,
  mount,
  type View,
} from "@verrex/core"
import { AsyncEscalate } from "./AsyncEscalate.vx"
import { AsyncUserPage } from "./AsyncUserPage.vx"
import { Clock } from "./Clock.vx"
import { Counter } from "./Counter.vx"
import { LiveUser } from "./LiveUser.vx"
import { HttpError, Http, HttpLive, Theme, type User } from "./services.ts"
import { TypedHandlers } from "./TypedHandlers.vx"
import { UserPage } from "./UserPage.vx"

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
declare function assertEquals<
  A,
  B extends (Equals<A, B> extends true ? unknown : never),
>(): void

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
assertEquals<
  AsyncUserPageType,
  Effect.Effect<View, never, Http | Scope.Scope>
>()

// ─── AsyncEscalate: tag-map failure arm handles HttpError at the leaf; the
//     RateLimited residual rides View<RateLimited> to a page Catch tag map.
//     Fully discharged end-to-end → View<never>/E never, Http folds.

type AsyncEscalateType = ReturnType<typeof AsyncEscalate>
assertEquals<
  AsyncEscalateType,
  Effect.Effect<View, never, Http | Scope.Scope>
>()

// ─── TypedHandlers: both channels enter through `onclick` alone (#72). The
//     inner Loader stamps Effect<View<HttpError>, never, Http>; the tag-map
//     Catch discharges the live HttpError, the handler's Http rides R out.

type TypedHandlersType = ReturnType<typeof TypedHandlers>
assertEquals<
  TypedHandlersType,
  Effect.Effect<View, never, Http | Scope.Scope>
>()

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

// ─── Clock bridges a Stream to a ref via `streamRef`, whose fork makes
//     `Scope` the component's only requirement — the tick stream needs no
//     services and can't fail, so R and E contribute nothing else ─────────

type ClockType = ReturnType<typeof Clock>
assertEquals<ClockType, Effect.Effect<View, never, Scope.Scope>>()

// ─── Composition: a tree containing UserPage AND Counter unions channels ─

const Composed = h("div", {}, Counter(), UserPage({ userId: "42" }))

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
const WithList = h(
  "ul",
  {},
  ids.map((id) => UserPage({ userId: id })),
)
type WithListType = typeof WithList
assertEquals<WithListType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── <Component /> form: the compiler lowers component tags to DIRECT calls
//     (#71) — `<UserPage userId="42"/>` is `UserPage({ userId: "42" })` in the
//     emitted code, so the component's E/R is just the call's Effect type and
//     folds into a surrounding h() as an ordinary child. (These direct calls
//     ARE the compiled form of the JSX tags.)

const CounterAsTag = Counter() // <Counter />
assertEquals<typeof CounterAsTag, Effect.Effect<View, never, never>>()

const UserPageAsTag = UserPage({ userId: "42" }) // <UserPage userId="42"/>
assertEquals<
  typeof UserPageAsTag,
  Effect.Effect<View, HttpError, Http | Theme>
>()

// Component children union with the surrounding element's other children.
const Mixed = h(
  "div",
  {},
  UserPage({ userId: "42" }), // contributes HttpError + Http | Theme
  Counter(), // contributes nothing
)
assertEquals<typeof Mixed, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Generic components survive JSX tags (#71's acceptance) ─────────────
//     Direct calls infer the type parameter natively — the old h()-mediated
//     higher-rank erasure is gone.

declare const GenericRow: <T>(props: {
  item: T
  render: (item: T) => string
}) => Effect.Effect<View, never, never>
// <GenericRow item={42} render={n => n.toFixed(2)}/> — T pins to number;
// `n.toFixed` compiles only because T survived.
const RowCall = GenericRow({ item: 42, render: (n) => n.toFixed(2) })
assertEquals<typeof RowCall, Effect.Effect<View, never, never>>()

// ─── Event handlers on intrinsic elements get typed event arguments ─────

h("button", {
  onclick: (e) => {
    const _: number = e.button // MouseEvent has .button
    void _
  },
})

h("input", {
  oninput: (e) => {
    const _: EventTarget | null = e.target // Event
    void _
  },
})

h("input", {
  onkeydown: (e) => {
    const _: string = e.key // KeyboardEvent has .key
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

// ─── Typed event handlers: the live channel is born at the leaf (#72) ────
//     Handlers are where most live errors are born — the element is already
//     rendered when one runs, so its failure can only ride the LIVE channel.
//     An Effect-returning handler stamps its `E` on the element's `View<E>`
//     (dischargeable by `Catch`, gated by `mount`) and folds its `R` into
//     the element's requirements (a forgotten Layer is a compile error at
//     the root). The runtime always routed these (sink + captured context);
//     now the types track them.

declare const failingSave: Effect.Effect<void, HttpError, never>
declare const auditedLog: Effect.Effect<void, never, Http>

// The handler's E lands on the LIVE channel — construction stays `never`
// (the element builds fine; only a click can fail).
const SaveButton = h("button", { onclick: () => failingSave }, "save")
assertEquals<typeof SaveButton, Effect.Effect<View<HttpError>, never, never>>()

// @ts-expect-error — the unhandled failing onclick is undischarged: mount's
// View<never> gate rejects the app, naming HttpError. Forgot a boundary.
mount(SaveButton, root)

// A Catch discharges it — catch-all, or tag-selective with the unwrapped error.
mount(
  Catch(SaveButton, (_cause) => h("p", {}, "save failed")),
  root,
)
mount(Catch(SaveButton, { HttpError: (e) => h("p", {}, `${e.status}`) }), root)

// The handler's R folds into the element's requirements, exactly like a
// construction R — the root must provide Http or the app doesn't compile.
const AuditButton = h("button", { onclick: () => auditedLog }, "audit")
assertEquals<typeof AuditButton, Effect.Effect<View, never, Http>>()

// Handler channels fold through composition like any other channel: the live
// E and the R both survive an enclosing element.
const Toolbar = h("div", {}, SaveButton, AuditButton, Counter())
assertEquals<typeof Toolbar, Effect.Effect<View<HttpError>, never, Http>>()

// A void/imperative handler beside an Effect-returning one contributes nothing.
const MixedHandlers = h("button", {
  onclick: () => failingSave,
  onblur: () => {},
})
assertEquals<
  typeof MixedHandlers,
  Effect.Effect<View<HttpError>, never, never>
>()

// A non-`on*` function-valued attr is inert (the runtime stringifies it,
// never runs it) — it must not contribute channels the runtime can't fire.
const InertFn = h("div", { format: () => failingSave })
assertEquals<typeof InertFn, Effect.Effect<View, never, never>>()

// The bare key `on` is inert too — the runtime's handler branch requires
// key.length > 2, so folding it would force a Catch that can never fire.
const InertOn = h("div", { on: () => failingSave })
assertEquals<typeof InertOn, Effect.Effect<View, never, never>>()

// An `any`-returning handler (an untyped lib call) is inert — and must NOT
// swallow a sibling handler's channels (the unguarded fold inferred
// `unknown`, which coalesced the whole element's live E to never one level
// up and made R undischargeable).
declare const someAny: any
const AnyBeside = h("button", {
  onclick: () => someAny,
  onkeydown: () => failingSave,
})
assertEquals<typeof AnyBeside, Effect.Effect<View<HttpError>, never, never>>()
const Nested = h("div", {}, AnyBeside)
assertEquals<typeof Nested, Effect.Effect<View<HttpError>, never, never>>()

// Mid-tree Effect.provide discharges a handler's R — and the runtime agrees:
// handlers run on the context captured when h() built the element (pinned at
// runtime by testing/event-handlers.test.ts), so this is not a type-level lie.
const ProvidedButton = Effect.provide(AuditButton, HttpLive)
assertEquals<typeof ProvidedButton, Effect.Effect<View, never, never>>()

// An extracted handler annotated with the exported EventHandler keeps its
// channels — the annotation type carries E/R slots. (A WIDER hand annotation
// — `(): unknown =>` — erases them: inherent to reading the inferred props
// type; documented in types/Html.ts.)
declare const annotated: EventHandler<MouseEvent, HttpError, Http>
const AnnotatedBtn = h("button", { onclick: annotated })
assertEquals<typeof AnnotatedBtn, Effect.Effect<View<HttpError>, never, Http>>()

// list() folds row channels: a row with a failing/service-using handler
// surfaces View<E> and R on the list itself (per-row Scope stays excluded).
declare const todos: AtomRef.Collection<string>
const RowChannels = list(todos, (item) =>
  h("li", {}, h("button", { onclick: () => failingSave }, item)),
)
assertEquals<typeof RowChannels, Effect.Effect<View<HttpError>, never, never>>()
const RowR = list(todos, (item) =>
  h("li", {}, h("button", { onclick: () => auditedLog }, item)),
)
assertEquals<typeof RowR, Effect.Effect<View, never, Http>>()

// Async arms and Catch fallbacks FOLD `R` (#120): a handler (or any Effect
// child) inside an arm needing a service the fetch does not folds onto the
// boundary's requirements — a missing Layer there is the same compile error
// as anywhere else, not a click-time Service-not-found defect. `Scope` stays
// excluded (arms render under the node scope, like list rows/handlers).
declare const fetchUser: () => Effect.Effect<User, HttpError, Http>
declare const themedLog: Effect.Effect<void, never, Theme>
const ArmFoldsR = Async(fetchUser, {
  success: (u) => h("button", { onclick: () => themedLog }, u.name),
})
assertEquals<
  typeof ArmFoldsR,
  Effect.Effect<View<HttpError>, never, Http | Theme | Scope.Scope>
>()
// Providing only Http leaves Theme on the requirements — a forgotten Layer
// for an arm's handler is a compile error, no longer a click-time defect.
const ArmProvidedHttp = Effect.provide(ArmFoldsR, HttpLive)
assertEquals<
  typeof ArmProvidedHttp,
  Effect.Effect<View<HttpError>, never, Theme | Scope.Scope>
>()

// Every arm folds: `initial` (bare value), `failure` (function or tag map).
declare const themedView: Effect.Effect<View, never, Theme>
const InitialFoldsR = Async(fetchUser, {
  initial: themedView,
  failure: () => h("p", {}, "err"),
  success: (u) => h("p", {}, u.name),
})
assertEquals<
  typeof InitialFoldsR,
  Effect.Effect<View, never, Http | Theme | Scope.Scope>
>()
const FailureFoldsR = Async(fetchUser, {
  failure: () => themedView,
  success: (u) => h("p", {}, u.name),
})
assertEquals<
  typeof FailureFoldsR,
  Effect.Effect<View, never, Http | Theme | Scope.Scope>
>()
const TagMapArmFoldsR = Async(fetchUser, {
  failure: { HttpError: () => themedView },
  success: (u) => h("p", {}, u.name),
})
assertEquals<
  typeof TagMapArmFoldsR,
  Effect.Effect<View, never, Http | Theme | Scope.Scope>
>()

// The original inference worry (a conditional arm) holds up post-#71: a
// conditional over intrinsics/components folds each branch's R; an `any`
// arm return is inert (guarded), not poisoning.
const CondArm = Async(fetchUser, {
  success: (u) => (flag ? h("p", {}, u.name) : themedView),
})
assertEquals<
  typeof CondArm,
  Effect.Effect<View<HttpError>, never, Http | Theme | Scope.Scope>
>()
// A component-call branch — the shape the original worry named — folds the
// component's R and stays inferred. (Arms must still return
// `View | Effect<View>`: `flag && <X/>` is `false | Effect`, rejected as
// before — unchanged, unrelated to the fold.)
const CompCondArm = Async(fetchUser, {
  success: (u) => (flag ? UserPage({ userId: u.id }) : h("p", {}, u.name)),
})
assertEquals<
  typeof CompCondArm,
  Effect.Effect<View<HttpError>, never, Http | Theme | Scope.Scope>
>()
const AnyArm = Async(fetchUser, { success: () => someAny })
assertEquals<
  typeof AnyArm,
  Effect.Effect<View<HttpError>, never, Http | Scope.Scope>
>()

// A generic arms parameter would drop excess-property checking; NoExcess
// re-arms it — a typo'd optional arm key is still a compile error (on the
// call, as an overload-resolution failure) in all three forms.
// @ts-expect-error — `intial` is not an arm
Async(fetchUser, { intial: themedView, success: (u) => h("p", {}, u.name) })
// @ts-expect-error — `intial` is not an arm
Async(fetchUser, {
  success: (u) => h("p", {}, u.name),
  failure: () => h("p", {}, "x"),
  intial: themedView,
})
// @ts-expect-error — `intial` is not an arm
Async(fetchUser, {
  success: (u) => h("p", {}, u.name),
  failure: { HttpError: () => h("p", {}, "x") },
  intial: themedView,
})

// Catch fallbacks fold too — both forms — while an arm needing only what the
// runtime provides (Scope) or nothing adds nothing.
declare const failingView: Effect.Effect<View, HttpError, never>
const FallbackFoldsR = Catch(failingView, () => themedView)
assertEquals<
  typeof FallbackFoldsR,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
// An inline handler that reads `cause` and `reset` still infers under the
// generic H, and folds what it uses.
const InlineFallback = Catch(failingView, (cause, reset) =>
  Effect.gen(function* () {
    yield* themedLog
    return yield* h("button", { onclick: reset }, Cause.pretty(cause))
  }),
)
assertEquals<
  typeof InlineFallback,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
const TagFallbackFoldsR = Catch(failingView, { HttpError: () => themedView })
assertEquals<
  typeof TagFallbackFoldsR,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
declare const scopedView: Effect.Effect<View, never, Scope.Scope>
const ScopedArmAddsNothing = Catch(failingView, () => scopedView)
assertEquals<
  typeof ScopedArmAddsNothing,
  Effect.Effect<View, never, Scope.Scope>
>()

// A typed FAILING handler inside a Catch fallback is rejected (the fallback
// must produce View<never>) — discharge it inside the fallback instead: a
// nested Catch compiles.
declare const failing: Effect.Effect<View, HttpError, never>
mount(
  Catch(failing, (_cause, reset) =>
    Catch(h("button", { onclick: () => failingSave, onblur: reset }, "retry"), {
      HttpError: (e) => h("p", {}, `retry failed: ${e.status}`),
    }),
  ),
  root,
)

// ─── Props are type-checked against the component's declared shape ───────

// (the direct-call lowering means these errors point at UserPage's own
// signature, not at h's conditional types)

// @ts-expect-error — missing required prop `userId`
const Missing = UserPage({})
void Missing

// @ts-expect-error — typo: `userid` is not in `{ userId: string }`
const Typo = UserPage({ userid: "42" })
void Typo

// @ts-expect-error — wrong type: number not assignable to string
const WrongType = UserPage({ userId: 42 })
void WrongType

// @ts-expect-error — extra prop not declared on component
const Extra = UserPage({ userId: "42", nope: true })
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

declare const resEff: Result.Result<
  Effect.Effect<View, HttpError, Http>,
  unknown
>
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
assertEquals<
  typeof Caught,
  Effect.Effect<View, never, Http | Theme | Scope.Scope>
>()

// @ts-expect-error — UserPage's HttpError is undischarged: `mount` rejects it,
// and the error names `HttpError` (not assignable to `never`). Forgot a boundary.
mount(UserPage({ userId: "42" }), root)

// With the boundary, the same app mounts.
mount(Caught, root)

// A pure component needs no boundary — it's already `View<never>`, `never`.
mount(Counter(), root)

// ─── mount owns the AtomRegistry (#167) ─────────────────────────────────
//     A component that resolves `yield* AtomRegistry` carries it on R, and
//     mount DISCHARGES it — the result needs no registry layer. This is the
//     type-level half of the fix: the registry no longer rides `mount`'s R,
//     so it can no longer be provided with the wrong lifetime.

const RegistryUser = Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry
  return yield* h("p", {}, `${typeof registry}`)
})
assertEquals<
  typeof RegistryUser,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry>
>()
assertEquals<
  ReturnType<typeof mount<AtomRegistry.AtomRegistry>>,
  Effect.Effect<void, never, Scope.Scope>
>()
mount(RegistryUser, root)

// ─── Atom carriers: the COMPONENT owns the requirements ──────────────────
//     The service instance is extracted in the component body (`yield* Http`
//     is what puts Http in R), and the Atom's stream source is built from
//     that instance — so the source itself is context-free, `Atom.runtime`
//     (which would bake the Layer and discharge R) never appears, and a
//     forgotten HttpLive is still a compile error at mount.

const AtomCarrier = Effect.gen(function* () {
  const http = yield* Http // Http rides the component's R
  const user = Atom.make(Stream.fromEffect(http.getUser("42")))
  return yield* h("p", { "data-user": user }, "·")
})
assertEquals<typeof AtomCarrier, Effect.Effect<View, never, Http>>()

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
assertEquals<
  typeof CaughtHttp,
  Effect.Effect<View, ParseError, Http | Scope.Scope>
>()

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
assertEquals<
  typeof CaughtBoth,
  Effect.Effect<View, never, Http | Scope.Scope>
>()
mount(CaughtBoth, root)

// Handle every tag at once → discharged, mountable.
const AllTags = Catch(TwoErrors, {
  HttpError: (e) => h("p", {}, `${e.status}`),
  ParseError: (e) => h("p", {}, e.message),
})
assertEquals<typeof AllTags, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(AllTags, root)

// ─── The LIVE half of the mount gate ────────────────────────────────────
//     A View carrying a live error (`View<E≠never>`) is also rejected by `mount`,
//     and `Catch` discharges it — the symmetric counterpart of the construction
//     (Effect-E) gate above.

declare const liveOnly: Effect.Effect<View<HttpError>, never, never>

// @ts-expect-error — the View can fail live with HttpError; mount requires View<never>.
mount(liveOnly, root)

// catch-all discharges the live error → mountable.
mount(
  Catch(liveOnly, (_cause) => h("p", {}, "live error")),
  root,
)

// tag-map discharges it too, narrowing to View<never>.
mount(Catch(liveOnly, { HttpError: (e) => h("p", {}, `${e.status}`) }), root)

// ─── Async: the failure arm picks the error's home ──────────────────────
//     Providing `failure` handles the failure at the leaf — `View<never>`,
//     nothing for a boundary to see. Omitting it puts `E` on the LIVE channel
//     (`View<E>`) — the leaf primitive that stamps `View<E≠never>` — and the
//     failure (initial fetch or refetch) routes to the nearest `Catch`.

declare const getUser42: () => Effect.Effect<User, HttpError, Http>

// Open form: HttpError rides the View channel; Http still folds into R.
const OpenAsync = Async(getUser42, { success: (u) => h("p", {}, u.name) })
assertEquals<
  typeof OpenAsync,
  Effect.Effect<View<HttpError>, never, Http | Scope.Scope>
>()

// Handled form: discharged to View<never>; the cause is precisely typed.
const HandledAsync = Async(getUser42, {
  success: (u) => h("p", {}, u.name),
  failure: (cause) => {
    const _typed: Cause.Cause<HttpError> = cause
    void _typed
    return h("p", {}, "failed")
  },
})
assertEquals<
  typeof HandledAsync,
  Effect.Effect<View, never, Http | Scope.Scope>
>()

// The live E folds through enclosing elements (FoldLiveE picks it off the
// child Effect's View<E> success).
const OpenInTree = h("main", {}, OpenAsync)
assertEquals<
  typeof OpenInTree,
  Effect.Effect<View<HttpError>, never, Http | Scope.Scope>
>()

// @ts-expect-error — the open Async's HttpError is undischarged: mount rejects
// it, naming HttpError. Add a Catch boundary (or a failure arm at the leaf).
mount(OpenInTree, root)

// A page-level Catch discharges the live failure → mountable.
mount(
  Catch(OpenInTree, (_cause) => h("p", {}, "failed")),
  root,
)

// Tag-map form discharges it too, narrowing to View<never>.
mount(Catch(OpenInTree, { HttpError: (e) => h("p", {}, `${e.status}`) }), root)

// ─── Async tag-map failure arm: per-tag leaf handling, residual rides ───
//     `failure` as a `_tag → handler` map mirrors Catch's tag-selective form:
//     matched tags are handled at the leaf (the fetch loop stays live), the
//     residual rides the live channel by `Exclude<E, { _tag }>` and must still
//     meet a `Catch` before `mount`.

declare const getUserTwo: () => Effect.Effect<
  User,
  HttpError | ParseError,
  Http
>

// Handle one tag → its handler gets the unwrapped error; the residual stays
// on the live channel: View<ParseError>.
const TagMapAsync = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e) => {
      const _status: number = e.status
      void _status
      return h("p", {}, "http error")
    },
  },
})
assertEquals<
  typeof TagMapAsync,
  Effect.Effect<View<ParseError>, never, Http | Scope.Scope>
>()

// @ts-expect-error — "Nope" is not one of the thunk's error tags
Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: { Nope: () => h("p", {}, "x") },
})

// @ts-expect-error — ParseError still rides the live channel; mount rejects it, naming it
mount(TagMapAsync, root)

// A boundary discharges the residual → mountable.
mount(Catch(TagMapAsync, { ParseError: (e) => h("p", {}, e.message) }), root)

// A tag map needs an E with at least one tagged member: with TagsOf<E> = never
// the Handlers constraint collapses to `never` (not the empty mapped type, which
// would accept ANY map as a silently-dead handler set).
declare const getUntagged: () => Effect.Effect<string, string, never>
// @ts-expect-error — E = string has no tags; the tag-map overload is rejected
Async(getUntagged, {
  success: (s) => h("p", {}, s),
  failure: { Oops: () => h("p", {}, "x") },
})

// Handle every tag at the leaf → View<never>, mountable with no boundary.
const TagMapAll = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e) => h("p", {}, `${e.status}`),
    ParseError: (e) => h("p", {}, e.message),
  },
})
assertEquals<typeof TagMapAll, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(TagMapAll, root)

// Every failure handler (catch-all and tag-map) receives `retry` last —
// typed () => void, the leaf analog of Catch's reset.
const HandledRetry = Async(getUser42, {
  success: (u) => h("p", {}, u.name),
  failure: (cause, retry) => {
    const _c: Cause.Cause<HttpError> = cause
    const _r: () => void = retry
    void _c
    void _r
    return h("p", {}, "failed")
  },
})
assertEquals<
  typeof HandledRetry,
  Effect.Effect<View, never, Http | Scope.Scope>
>()

const TagMapRetry = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e, retry) => {
      const _r: () => void = retry
      void _r
      return h("p", {}, `${e.status}`)
    },
  },
})
assertEquals<
  typeof TagMapRetry,
  Effect.Effect<View<ParseError>, never, Http | Scope.Scope>
>()

// ─── AsyncHandle: asyncRef returns { state, refetch }; Async accepts the
//     handle directly — same E homes as the thunk form, but the data outlives
//     the subtree and only Scope is contributed to R (the thunk's R already
//     folded where asyncRef ran).

declare const userHandle: AsyncHandle<User, HttpError | ParseError>

const HandleOpen = Async(userHandle, { success: (u) => h("p", {}, u.name) })
assertEquals<
  typeof HandleOpen,
  Effect.Effect<View<HttpError | ParseError>, never, Scope.Scope>
>()

const HandleTagMap = Async(userHandle, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e, retry) => {
      const _r: () => void = retry
      void _r
      return h("p", {}, `${e.status}`)
    },
  },
})
assertEquals<
  typeof HandleTagMap,
  Effect.Effect<View<ParseError>, never, Scope.Scope>
>()

// A handle-based open Async still needs a boundary before mount.
// @ts-expect-error — HttpError | ParseError ride the live channel
mount(HandleOpen, root)
mount(
  Catch(HandleOpen, (_cause) => h("p", {}, "failed")),
  root,
)

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
// The `@ts-expect-error` assertions above prove props are type-checked at
// JSX call sites, and that a forgotten error boundary fails to compile.

// ─── #159: a tracked handler on an UNLISTED `on*` key keeps its channels ──
//     The compiler wraps `ontimeupdate={flag.value ? saveA : saveB}` in
//     `h.track(() => …)`. That used to return `unknown`, which the
//     `Record<string, unknown>` half of IntrinsicProps swallowed silently —
//     so the handler ran at runtime with its `E`/`R` erased, past mount's
//     gate, with no Catch and no Layer. h.track now returns the honest
//     `T | Atom<T>`, both members of which fold.

declare const flagRef: AtomRef.AtomRef<boolean>
declare const saveA: (e: Event) => Effect.Effect<void, HttpError, Http>
declare const saveB: (e: Event) => Effect.Effect<void, HttpError, Http>

const TrackedUnlisted = h("video", {
  ontimeupdate: h.track(() => (h.read(flagRef) ? saveA : saveB)),
})
assertEquals<
  typeof TrackedUnlisted,
  Effect.Effect<View<HttpError>, never, Http>
>()

// A tracked attr that is NOT a handler stays inert — no channels invented.
const TrackedAttr = h("div", {
  class: h.track(() => (h.read(flagRef) ? "a" : "b")),
})
assertEquals<typeof TrackedAttr, Effect.Effect<View<never>, never, never>>()
