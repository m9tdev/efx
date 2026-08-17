import { Cause, Effect, Option, type Types } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import { bridgeAtom, isAtomRef } from "./coerce.ts"
import type { ChildE, ChildLiveE, ChildR } from "./types/Fold.ts"
import type { View } from "./View.ts"

// `<MatchTags on={x}>{{ Tag: (v) => …, … }}</MatchTags>` — render a tagged
// value (or an atom/ref of one) by tag, with FAILURES BUBBLING BY DEFAULT.
// Works for anything `_tag`ged: Option (Some/None), Result, AsyncResult, Exit,
// a `Data.TaggedEnum` state union. Every tag handler is optional (missing →
// renders nothing) EXCEPT that a failure-carrying variant — `{ _tag:
// "Failure"; cause: Cause<E> }` (AsyncResult, Exit) or `{ _tag: "Failure";
// failure: E }` (Result) — is escalated when unhandled: the residual rides
// `View<E>` to the nearest `Catch`, and `mount` refuses it. `Failure` takes a
// function (handles all → residual never) or a TAG MAP over the error's tags
// (handled at the leaf, the rest bubbles: `Exclude<E, { _tag: handled }>`).
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
 * `Failure` as a tag map over the error's tags. Each handler also receives
 * the whole `Failure` variant (`f.waiting` on an AsyncResult — a retry in
 * flight is STILL a Failure here; tags are the truth, unlike
 * `builder.onInitialOrWaiting`).
 */
type FailureTagMap<E, F> = {
  readonly [K in Types.Tags<E>]?: (
    error: Extract<E, { readonly _tag: K }>,
    variant: F,
  ) => unknown
}

/** The handlers object: one optional function per tag; `Failure` may be a tag map. */
export type TagHandlers<T> = {
  readonly [K in Exclude<Tags<T>, "Failure">]?: (
    variant: Variant<T, K>,
  ) => unknown
} & ([FailureError<T>] extends [never]
  ? { readonly Failure?: (variant: Variant<T, "Failure">) => unknown }
  : {
      readonly Failure?:
        | ((variant: Variant<T, "Failure">) => unknown)
        | FailureTagMap<FailureError<T>, Variant<T, "Failure">>
    })

/** What still bubbles after `H` handled its part of `T`'s failure. */
export type Residual<T, H> = [FailureError<T>] extends [never]
  ? never
  : H extends { readonly Failure: (variant: any) => unknown }
    ? never
    : H extends { readonly Failure: infer M }
      ? Exclude<FailureError<T>, { readonly _tag: keyof M }>
      : FailureError<T>

/** Handler returns (views, Effects) fold like any reactive emission: E is LIVE, R folds. */
type HandlerRet<H> = {
  [K in keyof H]: H[K] extends (...args: any) => infer R
    ? R
    : H[K] extends Record<string, (...args: any) => infer R>
      ? R
      : never
}[keyof H]
type HandlersLiveE<H> = ChildE<HandlerRet<H>> | ChildLiveE<HandlerRet<H>>
type HandlersR<H> = ChildR<HandlerRet<H>>

/**
 * ```tsx
 * <MatchTags on={user}>{{
 *   Initial: () => "loading",
 *   Success: (s) => s.value.name,
 *   Failure: { HttpError: (e) => e.message },   // RateLimited bubbles: View<RateLimited>
 * }}</MatchTags>
 * <MatchTags on={selected}>{{ Some: (o) => <b>{o.value}</b> }}</MatchTags>   // None → nothing
 * ```
 */
export function MatchTags<
  T extends Tagged,
  const H extends TagHandlers<T>,
>(props: {
  readonly on: T | Atom.Atom<T> | AtomRef.ReadonlyRef<T>
  readonly children: readonly [H]
}): Effect.Effect<View<Residual<T, H> | HandlersLiveE<H>>, never, HandlersR<H>>
export function MatchTags(props: {
  readonly on: unknown
  readonly children: readonly [Record<string, unknown>]
}): Effect.Effect<View<any>, never, any> {
  const handlers = props.children[0]
  assertHandlers(handlers)
  const failure = handlers["Failure"]
  const on = props.on
  // Always a reactive node (even for a plain value): the dispatch result —
  // including an unhandled failure raised as `Effect.failCause` — is a
  // render-time emission, so its E is LIVE (View<E>) uniformly.
  const source = Atom.readable((get) => {
    const value = Atom.isAtom(on)
      ? get(on)
      : isAtomRef(on)
        ? get(bridgeAtom(on))
        : on
    return dispatch(value as Tagged, handlers, failure)
  })
  return Effect.succeed(source as unknown as View<any>) as any
}

const dispatch = (
  value: Tagged,
  handlers: Record<string, unknown>,
  failure: unknown,
): unknown => {
  const tag = value._tag
  if (tag === "Failure") {
    const cause = causeOf(value)
    if (typeof failure === "function") return failure(value)
    if (
      failure !== undefined &&
      failure !== null &&
      typeof failure === "object"
    ) {
      const err = Option.getOrUndefined(Cause.findErrorOption(cause))
      const t =
        typeof err === "object" && err !== null && "_tag" in err
          ? (err as Tagged)._tag
          : undefined
      if (t !== undefined && Object.hasOwn(failure, t)) {
        const fn = (failure as Record<string, unknown>)[t]
        if (typeof fn === "function") return fn(err, value)
      }
    }
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
      "MatchTags: handlers must be a plain object — handlers on a prototype (class instance) never dispatch (#91)",
    )
  }
  for (const key of Object.keys(handlers)) {
    const v = handlers[key]
    if (typeof v === "function") continue
    if (key === "Failure" && v !== null && typeof v === "object") {
      for (const t of Object.keys(v as object)) {
        if (typeof (v as Record<string, unknown>)[t] !== "function") {
          throw new TypeError(
            `MatchTags: Failure tag-map handler "${t}" is not a function — its tag was discharged from the type but would never dispatch (#91)`,
          )
        }
      }
      continue
    }
    throw new TypeError(
      `MatchTags: handler "${key}" is not a function — its tag was discharged from the type but would never dispatch (#91)`,
    )
  }
}
