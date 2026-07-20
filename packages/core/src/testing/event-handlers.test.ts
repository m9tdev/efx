// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Effect, Logger } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { stepClick, stepLayer } from "./fixtures.ts"
import { render, untracked } from "./index.ts"

// PR1 fix: an event handler that returns an Effect used to be added as a raw DOM
// listener and the returned Effect was DROPPED unexecuted. Now applyProp detects
// an Effect return and forks it on the mount's captured context, routing failures
// to the error sink. These tests pin DISPATCH: it runs, it sees the app's
// services, plain imperative handlers still work, and a failing handler is
// contained (not thrown out of the DOM dispatch). The per-node context-capture
// and handler-scope pins live in context-capture.test.ts; the reactive-render
// sink routing is unit-tested in runtime/coerce.test.ts.

describe("event handlers — Effect-returning", () => {
  it("runs the returned Effect (counter increments on click)", async () => {
    const Clicker = Effect.fn("Clicker")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        {
          class: "btn",
          onClick: () => Effect.sync(() => count.set(count.value + 1)),
        },
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
    const ServiceClicker = Effect.fn("ServiceClicker")(function* (
      _props: {} = {},
    ) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: stepClick(count) },
        "count: ",
        count,
      )
    })

    // If the handler ran on the default runtime (no captured context), `yield* Step`
    // would fail and the count would never move — so this asserts context capture.
    const ui = await render(ServiceClicker(), stepLayer(10))
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
        {
          class: "btn",
          onClick: () => {
            count.set(count.value + 1)
          },
        },
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
      // The handler is typed HONESTLY (it fails with a string, so this
      // component stamps View<string>); `untracked` below is the harness's
      // sanctioned hatch for mounting it — since #72 a typed failing handler
      // can't reach `render`/`mount` otherwise (pinned in channels.test-d.ts).
      // The runtime containment must hold regardless of what the types track.
      return yield* h(
        "div",
        {},
        h(
          "button",
          { class: "bad", onClick: () => Effect.fail("boom-marker") },
          "fail",
        ),
        h(
          "button",
          {
            class: "good",
            onClick: () => Effect.sync(() => count.set(count.value + 1)),
          },
          "ok: ",
          count,
        ),
      )
    })

    const ui = await render(untracked(Mixed()), CapturingLogger)

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
      const opts = o as {
        readonly message?: unknown
        readonly cause?: unknown
      }
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
