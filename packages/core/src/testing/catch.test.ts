// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Data, Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Catch, h } from "@verrex/core"
import { render } from "./index.ts"

// `Catch` — the view-level error boundary. Two forms, picked by the 2nd arg:
//  - function → catch-all (discharges everything; cause is the full Cause)
//  - object   → tag-selective (handles a subset of tags; narrows the rest)
// Catches both construction and live failures; `reset` re-runs construction.

class BoomError extends Data.TaggedError("BoomError")<{ readonly why: string }> {}
class HttpError extends Data.TaggedError("HttpError")<{ readonly status: number }> {}
class ParseError extends Data.TaggedError("ParseError")<{ readonly message: string }> {}

// ─── catch-all (function handler) ───────────────────────────────────────
describe("Catch — catch-all (function)", () => {
  it("renders the child and never calls the handler on success", async () => {
    let calls = 0
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h("p", { class: "child" }, "hello")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (cause) => {
        calls++
        return h("p", { class: "fallback" }, Cause.pretty(cause))
      })
    })
    const ui = await render(App())
    expect(ui.text(".child")).toBe("hello")
    expect(ui.query(".fallback")).toBeNull()
    expect(calls).toBe(0)
    await ui.unmount()
  })

  it("renders the fallback with the cause on a construction failure", async () => {
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      yield* Effect.fail(new BoomError({ why: "construction" }))
      return yield* h("p", { class: "child" }, "unreachable")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (cause) => h("div", { class: "fallback" }, Cause.pretty(cause)))
    })
    const ui = await render(App())
    expect(ui.query(".child")).toBeNull()
    expect(ui.text(".fallback")).toContain("BoomError")
    await ui.unmount()
  })

  it("swaps to the fallback when an event-handler Effect fails (live)", async () => {
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        { class: "child" },
        h("button", { class: "boom", onClick: () => Effect.fail(new BoomError({ why: "click" })) }, "x"),
      )
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (cause) => h("div", { class: "fallback" }, Cause.pretty(cause)))
    })
    const ui = await render(App())
    ui.click(".boom")
    await ui.waitFor(".fallback")
    expect(ui.query(".child")).toBeNull()
    await ui.unmount()
  })

  it("swaps to the fallback when a reactive re-render Effect fails (live)", async () => {
    const trigger = AtomRef.make(false)
    const Child = Effect.fn("Child")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        { class: "child" },
        trigger.map((t) => (t ? Effect.fail(new BoomError({ why: "reactive" })) : "ok")),
      )
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (cause) => h("div", { class: "fallback" }, Cause.pretty(cause)))
    })
    const ui = await render(App())
    expect(ui.text(".child")).toBe("ok")
    trigger.set(true)
    await ui.waitFor(".fallback")
    await ui.unmount()
  })

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
      return yield* Catch(Child(), (_cause, reset) =>
        h("button", { class: "retry", onClick: reset }, "retry"),
      )
    })
    const ui = await render(App())
    expect(ui.query(".retry")).not.toBeNull()
    ui.click(".retry")
    await ui.waitFor(".child")
    expect(ui.text(".child")).toBe("recovered")
    await ui.unmount()
  })
})

// ─── tag-selective (object handler) ─────────────────────────────────────
describe("Catch — tag-selective (object)", () => {
  // Fails at construction with one of two tagged errors.
  const Child = Effect.fn("Child")(function* (props: { readonly fail: "http" | "parse" }) {
    if (props.fail === "http") yield* Effect.fail(new HttpError({ status: 503 }))
    else yield* Effect.fail(new ParseError({ message: "bad json" }))
    return yield* h("p", { class: "child" }, "ok")
  })

  it("dispatches to the handler for the failing tag, unwrapped", async () => {
    const make = (fail: "http" | "parse") =>
      Effect.fn("App")(function* (_props: {} = {}) {
        return yield* Catch(Child({ fail }), {
          HttpError: (e) => h("p", { class: "http" }, `http ${e.status}`),
          ParseError: (e) => h("p", { class: "parse" }, `parse ${e.message}`),
        })
      })()

    const a = await render(make("http"))
    expect(a.text(".http")).toBe("http 503")
    expect(a.query(".parse")).toBeNull()
    await a.unmount()

    const b = await render(make("parse"))
    expect(b.text(".parse")).toBe("parse bad json")
    await b.unmount()
  })

  it("passes an unhandled tag through to an outer catch-all", async () => {
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* Catch(
        Catch(Child({ fail: "parse" }), {
          HttpError: (e) => h("p", { class: "http" }, `http ${e.status}`),
        }),
        (cause) => h("p", { class: "outer" }, Cause.pretty(cause)),
      )
    })
    const ui = await render(App())
    expect(ui.query(".http")).toBeNull()
    expect(ui.text(".outer")).toContain("ParseError")
    await ui.unmount()
  })
})
