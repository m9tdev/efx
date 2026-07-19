import { Cause, Data, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Component from "./Component.ts"
import { View } from "./View.ts"

class Boom extends Data.TaggedError("Boom")<{ readonly hint: string }> {}

describe("Component.make", () => {
  it("stamps the component name as the span on a construction-failure Cause", () => {
    const Fails = Component.make(function* () {
      return yield* Effect.fail(new Boom({ hint: "construction" }))
    }, "MyFailingCard")

    const exit = Effect.runSyncExit(Fails())
    if (!Exit.isFailure(exit)) throw new Error("expected the build to fail")
    // The boundary fallback's job — "show WHERE it failed" — depends on the
    // span name landing in the rendered cause.
    expect(Cause.pretty(exit.cause)).toContain("MyFailingCard")
  })

  it("fails soft without a name (no span, still works)", () => {
    const Anon = Component.make(function* () {
      return View.Empty()
    })
    const exit = Effect.runSyncExit(Anon())
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("accepts a plain Effect-returning body (the signature-preserving form)", () => {
    const Plain = Component.make(
      (_props: {}) => Effect.succeed(View.Empty()),
      "Plain",
    )
    const exit = Effect.runSyncExit(Plain({}))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
