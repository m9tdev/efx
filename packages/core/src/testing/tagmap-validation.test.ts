// @vitest-environment happy-dom
/**
 * Construction-time validation of tag-map handler objects. The type
 * level discharges every `keyof Handlers` but dispatch honors only OWN,
 * function-valued keys — `assertHandlerMap` turns the two runtime-detectable
 * mismatches (prototype-keyed objects, non-function slots) into a TypeError
 * at the `Catch()` call site instead of a silently-dead handler.
 * (The third gap — a pre-built map whose TYPE declares keys the value doesn't
 * carry — is invisible at runtime and stays a documented limitation.)
 */
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { Catch, h, On } from "@verrex/core"

class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly id: string) {}
}
class Timeout {
  readonly _tag = "Timeout"
}
const _get = (): Effect.Effect<string, NotFound | Timeout> =>
  Effect.fail(new NotFound("x"))
const child: Effect.Effect<
  import("@verrex/core").View<NotFound | Timeout>,
  never,
  never
> = h("div", {}, h("span", { onclick: () => _get() }, "x"))

// Satisfies TagHandlers at the type level (methods match the constraint), but
// the handlers live on the prototype — exactly the shape that never dispatches.
class ProtoHandlers {
  NotFound(e: NotFound) {
    return h("p", {}, e.id)
  }
}

describe("On arm validation", () => {
  it("rejects a prototype-keyed props object and a non-function arm", () => {
    const value = { _tag: "NotFound" as const }
    expect(() =>
      On(Object.assign(new ProtoHandlers(), { value }) as never),
    ).toThrow(/On: a tag-map of handlers must be a plain object/)
    expect(() => On({ value, NotFound: undefined } as never)).toThrow(
      /On: tag-map handler "NotFound" is not a function/,
    )
  })
})

describe("tag-map construction validation", () => {
  it("Catch rejects a prototype-keyed handler object at the call site", () => {
    expect(() =>
      Catch(Object.assign(new ProtoHandlers(), { children: [child] })),
    ).toThrow(/Catch: a tag-map of handlers must be a plain object/)
  })

  it("Catch rejects a non-function handler slot, naming the key", () => {
    expect(() =>
      Catch({
        children: [child],
        NotFound: (e: NotFound) => h("p", {}, e.id),
        Timeout: undefined,
      } as never),
    ).toThrow(/Catch: tag-map handler "Timeout" is not a function/)
  })

  it("plain literals (including empty and null-prototype maps) still construct", () => {
    expect(() => Catch({ children: [child] })).not.toThrow()
    const bare = Object.assign(Object.create(null), {
      NotFound: (e: NotFound) => h("p", {}, e.id),
    })
    expect(() =>
      Catch(
        Object.assign(Object.create(null), bare, {
          children: [child],
        }) as never,
      ),
    ).not.toThrow()
  })
})
