// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Logger } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "./index.ts"

// PR1 fix: an event handler that returns an Effect used to be added as a raw DOM
// listener and the returned Effect was DROPPED unexecuted. Now applyProp detects
// an Effect return and forks it on the mount's captured context, routing failures
// to the error sink. These tests pin: it runs, it sees the app's services, plain
// imperative handlers still work, and a failing handler is contained (not thrown
// out of the DOM dispatch). The reactive-render sink routing is unit-tested in
// runtime/coerce.test.ts; both paths share the same sink + interrupt guard.

describe("event handlers — Effect-returning", () => {
  it("runs the returned Effect (counter increments on click)", async () => {
    const Clicker = Effect.fn("Clicker")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: () => Effect.sync(() => count.set(count.value + 1)) },
        "count: ",
        count,
      )
    })

    const ui = await render(Clicker())
    expect(ui.text(".btn")).toBe("count: 0")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 1")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 2")
    await ui.unmount()
  })

  it("runs on the captured context — handler Effect can yield* a service", async () => {
    class Step extends Context.Service<Step, { readonly by: number }>()("test/Step") {}
    const StepLive = Layer.succeed(Step, { by: 10 })

    const ServiceClicker = Effect.fn("ServiceClicker")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        {
          class: "btn",
          onClick: () =>
            Effect.gen(function* () {
              const step = yield* Step
              count.set(count.value + step.by)
            }),
        },
        "count: ",
        count,
      )
    })

    // If the handler ran on the default runtime (no captured context), `yield* Step`
    // would fail and the count would never move — so this asserts context capture.
    const ui = await render(ServiceClicker(), StepLive)
    expect(ui.text(".btn")).toBe("count: 0")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 10")
    await ui.unmount()
  })

  it("still runs plain (non-Effect) imperative handlers", async () => {
    const Imperative = Effect.fn("Imperative")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: () => { count.set(count.value + 1) } },
        "count: ",
        count,
      )
    })

    const ui = await render(Imperative())
    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 1")
    await ui.unmount()
  })

  it("contains a failing handler — routed to the sink, app keeps working", async () => {
    // Capture the routed failure via a custom logger (the root sink logs the
    // Cause through Effect.logError on the captured context).
    const logged: Array<unknown> = []
    const CapturingLogger = Logger.layer([
      Logger.make(({ message }) => {
        logged.push(message)
      }),
    ])

    const Mixed = Effect.fn("Mixed")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "div",
        {},
        h("button", { class: "bad", onClick: () => Effect.fail("boom") }, "fail"),
        h(
          "button",
          { class: "good", onClick: () => Effect.sync(() => count.set(count.value + 1)) },
          "ok: ",
          count,
        ),
      )
    })

    const ui = await render(Mixed(), CapturingLogger)

    // A failing handler must not throw out of dispatch nor break the app.
    ui.click(".bad")
    await ui.tick()
    expect(logged.length).toBeGreaterThan(0) // the failure was routed, not swallowed

    // The app still works after a handler failure.
    ui.click(".good")
    await ui.tick()
    expect(ui.text(".good")).toBe("ok: 1")
    await ui.unmount()
  })
})
