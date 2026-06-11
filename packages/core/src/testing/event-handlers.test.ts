// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Context, Effect, Layer, Logger } from "effect"
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
      Logger.make((options) => {
        logged.push(options)
      }),
    ])

    const Mixed = Effect.fn("Mixed")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      // The cast models an UNTRACKED live failure — a handler that lies about
      // its channels. Since #72 a typed failing handler stamps `View<E>` and
      // can't reach `render`/`mount` at all (pinned in channels.test-d.ts);
      // the runtime containment below must hold regardless of what the types
      // claimed, so this test deliberately drops the `E` on the floor.
      return yield* h(
        "div",
        {},
        h(
          "button",
          { class: "bad", onClick: () => Effect.fail("boom-marker") as unknown as Effect.Effect<void> },
          "fail",
        ),
        h(
          "button",
          { class: "good", onClick: () => Effect.sync(() => count.set(count.value + 1)) },
          "ok: ",
          count,
        ),
      )
    })

    const ui = await render(Mixed(), CapturingLogger)

    // A failing handler must not throw out of dispatch nor break the app, and the
    // ACTUAL cause must reach the sink (not just "something logged"). The sink logs
    // the Cause via Effect.logError, so it surfaces in the logger options' message
    // and/or cause field.
    ui.click(".bad")
    await ui.tick()
    const mentionsMarker = (v: unknown): boolean =>
      Cause.isCause(v)
        ? Cause.pretty(v).includes("boom-marker")
        : typeof v === "string"
          ? v.includes("boom-marker")
          : Array.isArray(v)
            ? v.some(mentionsMarker)
            : false
    const found = logged.some((o) => {
      const opts = o as { readonly message?: unknown; readonly cause?: unknown }
      return mentionsMarker(opts.message) || mentionsMarker(opts.cause)
    })
    expect(found).toBe(true)

    // The app still works after a handler failure.
    ui.click(".good")
    await ui.tick()
    expect(ui.text(".good")).toBe("ok: 1")
    await ui.unmount()
  })
})
