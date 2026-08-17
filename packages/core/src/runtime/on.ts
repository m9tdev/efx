import { Cause, Effect, Option, type Types } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import { bridgeAtom, isAtomRef } from "./coerce.ts"
import type { ChildE, ChildLiveE, ChildR } from "./types/Fold.ts"
import type { View } from "./View.ts"

// `<On value={x} Tag={(v) => …} … />` — render a tagged value (or an
// atom/ref of one) by tag, with FAILURES BUBBLING BY DEFAULT.
// Works for anything `_tag`ged: Option (Some/None), Result, AsyncResult, Exit,
// a `Data.TaggedEnum` state union. Every tag handler is optional (missing →
// renders nothing) EXCEPT that a failure-carrying variant — `{ _tag:
// "Failure"; cause: Cause<E> }` (AsyncResult, Exit) or `{ _tag: "Failure";
// failure: E }` (Result) — is escalated when unhandled: the residual rides
// `View<E>` to the nearest `Catch`, and `mount` refuses it. Failures are
// handled by the ERROR'S TAG directly in the props (`HttpError={(e, f) => …}`
// — handled at the leaf, the rest bubbles: `Exclude<E, { _tag: handled }>`)
// or by a `Failure` arm over the whole variant (handles all → residual never).
// Interrupt-only causes are dropped, not escalated (teardown, not an error),
// and so is an unhandled failure whose retry is in flight (`waiting`) — it
// renders nothing until it settles.
// This is the escalation default the old `Async` arms had, generalized to any
// tagged value and with no matching API of its own — the two failure shapes
// are the only special case.

type Tagged = { readonly _tag: string }
type Tags<T> = T extends { readonly _tag: infer K extends string } ? K : never
type Variant<T, K extends string> = Extract<T, { readonly _tag: K }>

/** The typed error a `Failure` variant of `T` carries, if any. */
type FailureError<T> =
  Variant<T, "Failure"> extends never
    ? never
    : Variant<T, "Failure"> extends { readonly cause: Cause.Cause<infer E> }
      ? E
      : Variant<T, "Failure"> extends { readonly failure: infer E }
        ? E
        : never

/**
 * The error's tags as arms, next to the value's own tags. Each handler also
 * receives the whole `Failure` variant (`f.waiting` on an AsyncResult — a
 * retry in flight is STILL a Failure here; tags are the truth, unlike
 * `builder.onInitialOrWaiting`).
 */
type FailureTagArms<E, F> = {
  readonly [K in Types.Tags<E>]?: (
    error: Extract<E, { readonly _tag: K }>,
    variant: F,
  ) => unknown
}

/** Does `T` carry a `waiting` flag (AsyncResult)? Then a `Waiting` arm is offered. */
type HasWaiting<T> = T extends { readonly waiting: boolean } ? true : never

/**
 * The arms, as PROPS of `<On value={…} Tag={…} />`: one optional function
 * per tag (missing → nothing); the failure's ERROR tags are arms too;
 * `Failure` handles the whole variant; `Waiting` (only
 * for waiting-capable values) wins over the tag arms while `waiting` is true
 * — `builder.onWaiting` semantics — and covers the first fetch too
 * (`AsyncResult.initial(true)` is waiting).
 */
export type TagHandlers<T> = {
  readonly [K in Exclude<Tags<T>, "Failure">]?: (
    variant: Variant<T, K>,
  ) => unknown
} & ([FailureError<T>] extends [never]
  ? { readonly Failure?: (variant: Variant<T, "Failure">) => unknown }
  : {
      readonly Failure?: (variant: Variant<T, "Failure">) => unknown
    } & FailureTagArms<FailureError<T>, Variant<T, "Failure">>) &
  ([HasWaiting<T>] extends [never]
    ? {}
    : { readonly Waiting?: (value: T & { readonly waiting: true }) => unknown })

/** What still bubbles after `H` handled its part of `T`'s failure. */
export type Residual<T, H> = [FailureError<T>] extends [never]
  ? never
  : H extends { readonly Failure: (variant: any) => unknown }
    ? never
    : Exclude<FailureError<T>, { readonly _tag: HandledKeys<H> }>

/** The keys of `H` that actually carry a handler (an unset optional key is not one). */
export type HandledKeys<H> = {
  [K in keyof H]-?: H[K] extends (...args: any) => unknown ? K : never
}[keyof H]

/** Handler returns (views, Effects) fold like any reactive emission: E is LIVE, R folds. */
type HandlerRet<H> = {
  // `value` is not an arm (a callable `Fn` there would otherwise fold its R).
  [K in Exclude<keyof H, "value">]: H[K] extends (...args: any) => infer R
    ? R
    : never
}[Exclude<keyof H, "value">]
type HandlersLiveE<H> = ChildE<HandlerRet<H>> | ChildLiveE<HandlerRet<H>>
type HandlersR<H> = ChildR<HandlerRet<H>>

/**
 * ```tsx
 * <On value={user}
 *   Waiting={() => "loading"}
 *   Success={(s) => s.value.name}
 *   HttpError={(e) => e.message}   // RateLimited bubbles: View<RateLimited>
 * />
 * <On value={selected} Some={(o) => <b>{o.value}</b>} />   // None → nothing
 * ```
 */
export function On<T extends Tagged, const H extends TagHandlers<T>>(
  props: { readonly value: T | Atom.Atom<T> | AtomRef.ReadonlyRef<T> } & H,
): Effect.Effect<View<Residual<T, H> | HandlersLiveE<H>>, never, HandlersR<H>>
export function On(
  props: { readonly value: unknown } & Record<string, unknown>,
): Effect.Effect<View<any>, never, any> {
  const { value: on, ...handlers } = props
  assertHandlers(handlers)
  const failure = handlers["Failure"]
  const waiting = handlers["Waiting"]
  // Always a reactive node (even for a plain value): the dispatch result —
  // including an unhandled failure raised as `Effect.failCause` — is a
  // render-time emission, so its E is LIVE (View<E>) uniformly.
  const source = Atom.readable((get) => {
    const value = Atom.isAtom(on)
      ? get(on)
      : isAtomRef(on)
        ? get(bridgeAtom(on))
        : on
    return dispatch(value as Tagged, handlers, failure, waiting)
  })
  return Effect.succeed(source as unknown as View<any>) as any
}

const dispatch = (
  value: Tagged,
  handlers: Record<string, unknown>,
  failure: unknown,
  waiting: unknown,
): unknown => {
  const tag = value._tag
  if (
    typeof waiting === "function" &&
    (value as { readonly waiting?: boolean }).waiting === true
  ) {
    return waiting(value)
  }
  if (tag === "Failure") {
    const cause = causeOf(value)
    // Error-tag arm first (the more specific), then the whole-variant arm.
    const err = Option.getOrUndefined(Cause.findErrorOption(cause))
    const t =
      typeof err === "object" && err !== null && "_tag" in err
        ? (err as Tagged)._tag
        : undefined
    if (t !== undefined && Object.hasOwn(handlers, t)) {
      const fn = handlers[t]
      if (typeof fn === "function") return fn(err, value)
    }
    if (typeof failure === "function") return failure(value)
    // Unhandled: escalate — unless it is teardown, or a retry is in flight
    // (`waiting`, AsyncResult): re-escalating a stale failure while its
    // refetch runs would bounce a `Catch` back into its fallback before the
    // new result can land (refresh + reset would never recover). Render
    // nothing until it settles; a HANDLED tag still sees `f.waiting`.
    if (Cause.hasInterruptsOnly(cause)) return null
    if ((value as { readonly waiting?: boolean }).waiting === true) return null
    return Effect.failCause(cause)
  }
  const fn = handlers[tag]
  return typeof fn === "function" ? fn(value) : null
}

/** A `Failure` variant's cause: `cause` (AsyncResult, Exit) or a `Cause.fail(failure)` (Result). */
const causeOf = (v: Tagged): Cause.Cause<unknown> => {
  const rec = v as unknown as Record<string, unknown>
  if (Cause.isCause(rec["cause"])) return rec["cause"] as Cause.Cause<unknown>
  return Cause.fail(rec["failure"])
}

const assertHandlers = (handlers: Record<string, unknown>): void => {
  const proto = Object.getPrototypeOf(handlers)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      "On: arms must be a plain object — handlers on a prototype (class instance) never dispatch (#91)",
    )
  }
  for (const key of Object.keys(handlers)) {
    const v = handlers[key]
    if (typeof v === "function") continue
    throw new TypeError(
      `On: handler "${key}" is not a function — its tag was discharged from the type but would never dispatch (#91)`,
    )
  }
}
