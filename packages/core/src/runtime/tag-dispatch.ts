import { Cause, Option } from "effect"

/**
 * The one tag-matching rule shared by verrex's two tag-map surfaces (`Catch`
 * arms, `On` error-tag arms), plus the construction-time guard both run on
 * their props. Keeping rule and guard in one module means "which arm does this
 * cause hit" and "which handler shapes are rejected" cannot drift between the
 * surfaces.
 */

export type Tagged = { readonly _tag: string }

/**
 * Construction-time guard for tag-map handler objects: the type level
 * discharges every `keyof Handlers`, but dispatch only honors OWN,
 * function-valued keys — so reject, loudly and at the call site, the two
 * shapes that would silently over-discharge: prototype-keyed objects (class
 * instances, whose methods never dispatch) and non-function slots
 * (`Tag: undefined`, which compiles for consumers without
 * `exactOptionalPropertyTypes`). The third gap — pre-built maps whose TYPE
 * declares keys the value doesn't carry — is invisible at runtime (erasure)
 * and stays a documented limitation.
 *
 * `skip` lists the non-arm keys of the surface's props object (`"children"`
 * for `Catch`, `"value"` for `On`) — validate the PROPS object itself; a
 * rest-spread first would hide its prototype.
 */
export const assertHandlerMap = (
  handlers: Record<string, unknown>,
  surface: string,
  skip: ReadonlyArray<string> = [],
): void => {
  const proto = Object.getPrototypeOf(handlers)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `${surface}: a tag-map of handlers must be a plain object — handlers on a prototype (class instance) never dispatch`,
    )
  }
  for (const key of Object.keys(handlers)) {
    if (skip.includes(key)) continue
    if (typeof handlers[key] !== "function") {
      throw new TypeError(
        `${surface}: tag-map handler "${key}" is not a function — its tag was discharged from the type but would never dispatch`,
      )
    }
  }
}

/**
 * The handler matching the cause's first error, when that error is tagged and
 * `handlers` carries an OWN, function-valued key for it (non-plain maps and
 * non-function slots are rejected up front by `assertHandlerMap`; the
 * remaining erasure gap is a pre-built map whose TYPE declares keys the
 * value lacks).
 * Dispatch is on the cause's FIRST error — if it is untagged, no handler
 * matches even when a later error's tag is mapped; the design assumes a single
 * failure per cause. Returns the handler together with the error it matched
 * on, so dispatch tag and handler argument can't drift apart across the two
 * tag-map surfaces.
 *
 * `skipTag` excludes one tag from arm dispatch: `On` passes `"Failure"`
 * because that key IS its whole-variant arm — an error itself tagged
 * "Failure" has no error-tag arm there.
 */
export const matchTagArm = (
  handlers: Record<string, unknown>,
  cause: Cause.Cause<unknown>,
  skipTag?: string,
):
  | {
      readonly handler: (error: any, extra: any) => unknown
      readonly error: unknown
    }
  | undefined => {
  const err = Option.getOrUndefined(Cause.findErrorOption(cause))
  const t =
    typeof err === "object" && err !== null && "_tag" in err
      ? (err as Tagged)._tag
      : undefined
  if (t === undefined || t === skipTag || !Object.hasOwn(handlers, t)) {
    return undefined
  }
  const fn = handlers[t]
  return typeof fn === "function"
    ? { handler: fn as (error: any, extra: any) => unknown, error: err }
    : undefined
}
