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
// This escalation default applies to any tagged value and has no matching API
// of its own — the two failure shapes are the only special case.

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
 * Does `T` carry a `waiting` flag (AsyncResult)? Then a `Waiting` arm is
 * offered.
 */
type HasWaiting<T> = T extends { readonly waiting: boolean } ? true : never

/**
 * The `Failure` variant with its error narrowed to `E2` — what the `Failure`
 * arm sees after the error-tag arms took theirs: `cause: Cause<E2>`
 * (AsyncResult, Exit) or `failure: E2` (Result).
 */
type NarrowFailure<F, E2> = F extends { readonly cause: Cause.Cause<any> }
  ? Omit<F, "cause"> & { readonly cause: Cause.Cause<E2> }
  : F extends { readonly failure: any }
    ? Omit<F, "failure"> & { readonly failure: E2 }
    : F

/**
 * Every key `<On>` accepts for `T`: value tags, the failure's error tags,
 * `Waiting`, and `value`.
 */
type ArmKeys<T> =
  | Tags<T>
  | Types.Tags<FailureError<T>>
  | "value"
  | ([HasWaiting<T>] extends [never] ? never : "Waiting")

/**
 * The arms, as PROPS of `<On value={…} Tag={…} />`, keyed by the arms
 * ACTUALLY PRESENT (`K`, inferred from the props' keys — `value` is in the
 * key space only so it doesn't push inference to the constraint). One
 * function per value tag (missing → nothing); the failure's ERROR tags are
 * arms too (each also receives the whole `Failure` variant — `f.waiting` on
 * an AsyncResult: a retry in flight is STILL a Failure here; tags are the
 * truth, unlike `builder.onInitialOrWaiting`); `Failure` handles the REST of
 * the variant — its error is narrowed by the error-tag arms present (`NoInfer`
 * keeps that parameter from feeding `K`); `Waiting` (only for
 * waiting-capable values) wins over the tag arms while `waiting` is true —
 * `builder.onWaiting` semantics — and covers the first fetch too
 * (`AsyncResult.initial(true)` is waiting).
 */
export type TagHandlers<T, K extends string = ArmKeys<T>> = {
  readonly [P in K]: P extends "value"
    ? unknown
    : P extends "Failure"
      ? (
          variant: NarrowFailure<
            Variant<T, "Failure">,
            Exclude<
              FailureError<T>,
              { readonly _tag: Exclude<NoInfer<K>, "Failure"> }
            >
          >,
        ) => unknown
      : P extends "Waiting"
        ? (value: T & { readonly waiting: true }) => unknown
        : P extends Tags<T>
          ? (variant: Variant<T, P>) => unknown
          : (
              error: Extract<FailureError<T>, { readonly _tag: P }>,
              variant: Variant<T, "Failure">,
            ) => unknown
}

/**
 * What still bubbles after the arms `K` handled their part of `T`'s failure.
 */
export type Residual<T, K extends string> = [FailureError<T>] extends [never]
  ? never
  : "Failure" extends K
    ? never
    : Exclude<FailureError<T>, { readonly _tag: K }>

/**
 * Handler returns (views, Effects) fold like any reactive emission: E is LIVE,
 * R folds.
 */
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
export function On<
  T extends Tagged,
  K extends ArmKeys<T> = never,
  const H extends TagHandlers<T, K> = TagHandlers<T, K>,
>(
  props: {
    readonly value: T | Atom.Atom<T> | AtomRef.ReadonlyRef<T>
  } & TagHandlers<T, K> &
    H,
): Effect.Effect<View<Residual<T, K> | HandlersLiveE<H>>, never, HandlersR<H>>
export function On(
  props: { readonly value: unknown } & Record<string, unknown>,
): Effect.Effect<View<any>, never, any> {
  // Validate the PROPS object (a rest-spread would hide its prototype).
  assertHandlers(props)
  const { value: on, ...handlers } = props
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
    // A throw must not escape the registry read (it would freeze this node's
    // siblings for good — see `h.reader`); an arm that throws is a defect →
    // `Effect.die`, a live failure for the nearest `Catch` / the root sink.
    try {
      return dispatch(value as Tagged, handlers, failure, waiting)
    } catch (error) {
      return Effect.die(error)
    }
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
  // Only the two failure SHAPES escalate (`cause: Cause` / `failure`); a user
  // union's own `Failure` variant without either is an ordinary tag (the type
  // says so: `FailureError<T>` is `never` for it).
  if (tag === "Failure" && isFailureVariant(value)) {
    const cause = causeOf(value)
    // Error-tag arm first (the more specific), then the whole-variant arm.
    const err = Option.getOrUndefined(Cause.findErrorOption(cause))
    const t =
      typeof err === "object" && err !== null && "_tag" in err
        ? (err as Tagged)._tag
        : undefined
    // (an error tagged "Failure" itself has no error-tag arm: that key IS
    // the whole-variant arm)
    if (t !== undefined && t !== "Failure" && Object.hasOwn(handlers, t)) {
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
  // OWN keys only — a value tagged "toString" must not hit Object.prototype.
  const fn = Object.hasOwn(handlers, tag) ? handlers[tag] : undefined
  return typeof fn === "function" ? fn(value) : null
}

const isFailureVariant = (v: Tagged): boolean => {
  const rec = v as unknown as Record<string, unknown>
  return Cause.isCause(rec["cause"]) || Object.hasOwn(rec, "failure")
}

/**
 * A `Failure` variant's cause: `cause` (AsyncResult, Exit) or a
 * `Cause.fail(failure)` (Result).
 */
const causeOf = (v: Tagged): Cause.Cause<unknown> => {
  const rec = v as unknown as Record<string, unknown>
  if (Cause.isCause(rec["cause"])) return rec["cause"] as Cause.Cause<unknown>
  return Cause.fail(rec["failure"])
}

const assertHandlers = (handlers: Record<string, unknown>): void => {
  const proto = Object.getPrototypeOf(handlers)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      "On: arms must be a plain object — handlers on a prototype (class instance) never dispatch",
    )
  }
  for (const key of Object.keys(handlers)) {
    if (key === "value") continue
    const v = handlers[key]
    if (typeof v === "function") continue
    throw new TypeError(
      `On: handler "${key}" is not a function — its tag was discharged from the type but would never dispatch`,
    )
  }
}
