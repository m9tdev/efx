// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Data, Effect } from "effect"
import { catchCause, catchTag, catchTags, h } from "@verrex/core"
import { render } from "./index.ts"

// PR4: tag-selective boundaries. `catchTag`/`catchTags` mirror Effect's — handle
// specific tagged errors, NARROW the channels by the handled tags, and pass the
// rest through to an outer boundary. `tag`/keys are constrained to the child's
// actual error tags (a typo is a compile error). These exercise construction
// errors (the typed ones); event-handler/reactive errors stay untyped and use
// `catchCause`.

class HttpError extends Data.TaggedError("HttpError")<{ readonly status: number }> {}
class ParseError extends Data.TaggedError("ParseError")<{ readonly message: string }> {}

// A child that fails (at construction) with one of two tagged errors.
const Child = Effect.fn("Child")(function* (props: { readonly fail: "http" | "parse" }) {
  if (props.fail === "http") yield* Effect.fail(new HttpError({ status: 503 }))
  else yield* Effect.fail(new ParseError({ message: "bad json" }))
  return yield* h("p", { class: "child" }, "ok")
})

describe("catchTag", () => {
  it("catches the matching tag and hands the handler the unwrapped error", async () => {
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchTag(Child({ fail: "http" }), "HttpError", (e) =>
        h("p", { class: "http-fallback" }, `http ${e.status}`),
      )
    })
    const ui = await render(App())
    expect(ui.text(".http-fallback")).toBe("http 503")
    expect(ui.query(".child")).toBeNull()
    await ui.unmount()
  })

  it("passes a non-matching tag through to an outer catchCause", async () => {
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      // inner handles HttpError only; the child fails with ParseError → re-raised
      // (residual) and caught by the outer catch-all.
      return yield* catchCause(
        catchTag(Child({ fail: "parse" }), "HttpError", () => h("p", { class: "http" }, "http")),
        (cause) => h("p", { class: "outer" }, Cause.pretty(cause)),
      )
    })
    const ui = await render(App())
    expect(ui.query(".http")).toBeNull()
    expect(ui.text(".outer")).toContain("ParseError")
    await ui.unmount()
  })

  it("reset() re-runs construction", async () => {
    let attempt = 0
    const Flaky = Effect.fn("Flaky")(function* (_props: {} = {}) {
      attempt++
      if (attempt === 1) yield* Effect.fail(new HttpError({ status: 500 }))
      return yield* h("p", { class: "child" }, "recovered")
    })
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      return yield* catchTag(Flaky(), "HttpError", (_e, reset) =>
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

describe("catchTags", () => {
  it("dispatches to the handler for the failing tag", async () => {
    const make = (fail: "http" | "parse") =>
      Effect.fn("App")(function* (_props: {} = {}) {
        return yield* catchTags(Child({ fail }), {
          HttpError: (e) => h("p", { class: "http" }, `http ${e.status}`),
          ParseError: (e) => h("p", { class: "parse" }, `parse ${e.message}`),
        })
      })()

    const httpUi = await render(make("http"))
    expect(httpUi.text(".http")).toBe("http 503")
    expect(httpUi.query(".parse")).toBeNull()
    await httpUi.unmount()

    const parseUi = await render(make("parse"))
    expect(parseUi.text(".parse")).toBe("parse bad json")
    expect(parseUi.query(".http")).toBeNull()
    await parseUi.unmount()
  })

  it("passes an unhandled tag through to an outer boundary", async () => {
    const App = Effect.fn("App")(function* (_props: {} = {}) {
      // handles only HttpError; the child fails with ParseError → outer catches.
      return yield* catchCause(
        catchTags(Child({ fail: "parse" }), {
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
