// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Data, Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { catchCause, h } from "@verrex/core"
import { render } from "./index.ts"

// PR2: `catchCause(child, (cause, reset) => fallback)` — the catch-all view
// boundary. Mirrors `Effect.catchCause`: recover the failure side of a subtree,
// pass success through. Catches BOTH phases (construction + live) and offers a
// `reset` that re-runs construction. Cause is `Cause<unknown>` (typed discharge
// is a later pass).

class BoomError extends Data.TaggedError("BoomError")<{ readonly why: string }> {}

describe("catchCause — success", () => {
  it("renders the child and never calls the handler", async () => {
    let handlerCalls = 0
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h("p", { class: "child" }, "hello")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause) => {
        handlerCalls++
        return h("p", { class: "fallback" }, Cause.pretty(cause))
      })
    })

    const ui = await render(App())
    expect(ui.text(".child")).toBe("hello")
    expect(ui.query(".fallback")).toBeNull()
    expect(handlerCalls).toBe(0)
    await ui.unmount()
  })
})

describe("catchCause — construction failure", () => {
  it("renders the fallback with the cause when the child build Effect fails", async () => {
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      yield* Effect.fail(new BoomError({ why: "construction" }))
      return yield* h("p", { class: "child" }, "unreachable")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause) =>
        h("div", { class: "fallback" }, Cause.pretty(cause)),
      )
    })

    const ui = await render(App())
    expect(ui.query(".child")).toBeNull()
    expect(ui.query(".fallback")).not.toBeNull()
    expect(ui.text(".fallback")).toContain("BoomError")
    await ui.unmount()
  })
})

describe("catchCause — live failures", () => {
  it("swaps to the fallback when an event-handler Effect in the child fails", async () => {
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        { class: "child" },
        h("button", { class: "boom", onClick: () => Effect.fail(new BoomError({ why: "click" })) }, "explode"),
      )
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause) =>
        h("div", { class: "fallback" }, Cause.pretty(cause)),
      )
    })

    const ui = await render(App())
    expect(ui.query(".child")).not.toBeNull()

    ui.click(".boom")
    await ui.waitFor(".fallback")
    expect(ui.query(".child")).toBeNull()
    expect(ui.text(".fallback")).toContain("BoomError")
    await ui.unmount()
  })

  it("swaps to the fallback when a reactive re-render Effect fails", async () => {
    const trigger = AtomRef.make(false)
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        { class: "child" },
        // Reactive child: emits "ok" until `trigger` flips, then emits a failing
        // Effect — coerceSync runs it, the failure routes to the boundary sink.
        trigger.map((t) => (t ? Effect.fail(new BoomError({ why: "reactive" })) : "ok")),
      )
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause) =>
        h("div", { class: "fallback" }, Cause.pretty(cause)),
      )
    })

    const ui = await render(App())
    expect(ui.text(".child")).toBe("ok")

    trigger.set(true)
    await ui.waitFor(".fallback")
    expect(ui.query(".child")).toBeNull()
    expect(ui.text(".fallback")).toContain("BoomError")
    await ui.unmount()
  })
})

describe("catchCause — reset", () => {
  it("reset() re-runs construction and brings the child back", async () => {
    let shouldFail = true
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      if (shouldFail) {
        shouldFail = false
        yield* Effect.fail(new BoomError({ why: "first build" }))
      }
      return yield* h("p", { class: "child" }, "recovered")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause, reset) =>
        h(
          "div",
          { class: "fallback" },
          Cause.pretty(cause),
          h("button", { class: "retry", onClick: reset }, "retry"),
        ),
      )
    })

    const ui = await render(App())
    // First construction failed → fallback.
    expect(ui.query(".fallback")).not.toBeNull()
    expect(ui.query(".child")).toBeNull()

    // reset → re-run construction (now succeeds) → child returns.
    ui.click(".retry")
    await ui.waitFor(".child")
    expect(ui.text(".child")).toBe("recovered")
    expect(ui.query(".fallback")).toBeNull()
    await ui.unmount()
  })

  it("reset() after a live failure rebuilds a fresh child subtree", async () => {
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        { class: "child" },
        h("button", { class: "boom", onClick: () => Effect.fail(new BoomError({ why: "click" })) }, "explode"),
      )
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchCause(Child(), (cause, reset) =>
        h("div", { class: "fallback" }, h("button", { class: "retry", onClick: reset }, "retry")),
      )
    })

    const ui = await render(App())
    ui.click(".boom")
    await ui.waitFor(".fallback")

    ui.click(".retry")
    await ui.waitFor(".child")
    expect(ui.query(".fallback")).toBeNull()
    // The fresh child still works (its button is wired again).
    ui.click(".boom")
    await ui.waitFor(".fallback")
    await ui.unmount()
  })
})
