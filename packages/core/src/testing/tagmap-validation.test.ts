// @vitest-environment happy-dom
/**
 * Construction-time validation of tag-map handler objects (#91). The type
 * level discharges every `keyof Handlers` but dispatch honors only OWN,
 * function-valued keys — `assertHandlerMap` turns the two runtime-detectable
 * mismatches (prototype-keyed objects, non-function slots) into a TypeError
 * at the `Async()`/`Catch()` call site instead of a silently-dead handler.
 * (The third gap — a pre-built map whose TYPE declares keys the value doesn't
 * carry — is invisible at runtime and stays documented in #91.)
 */
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { Async, Catch, h } from "@verrex/core"

class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly id: string) {}
}
class Timeout {
  readonly _tag = "Timeout"
}
const get = (): Effect.Effect<string, NotFound | Timeout> =>
  Effect.fail(new NotFound("x"))
const child = h("div", {}, Async(get, { success: (n) => h("span", {}, n) }))

// Satisfies TagHandlers at the type level (methods match the constraint), but
// the handlers live on the prototype — exactly the shape that never dispatches.
class ProtoHandlers {
  NotFound(e: NotFound) {
    return h("p", {}, e.id)
  }
}

describe("tag-map construction validation (#91)", () => {
  it("Async rejects a prototype-keyed handler object at the call site", () => {
    expect(() =>
      Async(get, {
        success: (n) => h("span", {}, n),
        failure: new ProtoHandlers(),
      }),
    ).toThrow(/Async: a tag-map of handlers must be a plain object/)
  })

  it("Async rejects a non-function handler slot, naming the key", () => {
    // `Timeout: undefined` is a compile error in-repo (exactOptionalPropertyTypes)
    // but compiles for default-tsconfig consumers — simulate them with a cast.
    expect(() =>
      Async(get, {
        success: (n) => h("span", {}, n),
        failure: {
          NotFound: (e: NotFound) => h("p", {}, e.id),
          Timeout: undefined,
        } as never,
      }),
    ).toThrow(/Async: tag-map handler "Timeout" is not a function/)
  })

  it("Catch rejects a prototype-keyed handler object at the call site", () => {
    expect(() => Catch(child, new ProtoHandlers())).toThrow(
      /Catch: a tag-map of handlers must be a plain object/,
    )
  })

  it("Catch rejects a non-function handler slot, naming the key", () => {
    expect(() =>
      Catch(child, {
        NotFound: (e: NotFound) => h("p", {}, e.id),
        Timeout: undefined,
      } as never),
    ).toThrow(/Catch: tag-map handler "Timeout" is not a function/)
  })

  it("plain literals (including empty and null-prototype maps) still construct", () => {
    expect(() =>
      Async(get, {
        success: (n) => h("span", {}, n),
        failure: { NotFound: (e) => h("p", {}, e.id) },
      }),
    ).not.toThrow()
    expect(() => Catch(child, {})).not.toThrow()
    const bare = Object.assign(Object.create(null), {
      NotFound: (e: NotFound) => h("p", {}, e.id),
    })
    expect(() => Catch(child, bare as never)).not.toThrow()
  })
})
