// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AsyncResult, AtomRef } from "effect/unstable/reactivity"
import { asyncRef, h } from "@verrex/core"
import { render } from "./index.ts"
import { makeUsersFixture, NotFound } from "./fixtures.ts"

const { Users: Api, usersWith } = makeUsersFixture("async")

const ApiLive = usersWith((id) =>
  Effect.gen(function* () {
    yield* Effect.sleep("1 milli") // ensure a visible loading window
    if (id === "bad") return yield* new NotFound({ id })
    return `user-${id}`
  }),
)

// Build with raw h(): `data.state.map(AsyncResult.match(...))` is a ReadonlyRef<string>
// → coerces to a reactive node. No compiler needed.
const Widget = (id: AtomRef.AtomRef<string>) =>
  Effect.fn(function* () {
    const api = yield* Api
    // h.read(id) is what the .vx compiler emits for `id.value` — it records the
    // dep so Async refetches when id changes. (Raw .ts test → call it directly.)
    const data = yield* asyncRef(() => api.get(h.read(id))) // reactive on id; Api folds into R
    return yield* h(
      "div",
      { class: "out" },
      data.state.map((r) =>
        AsyncResult.match(r, {
          onInitial: () => "loading",
          onFailure: () => "error",
          onSuccess: (s) => s.value,
        }),
      ),
    )
  })

const settle = () => new Promise<void>((r) => setTimeout(r, 30))

describe("Async — reactive AsyncResult", () => {
  it("renders loading → success, refetches on dep change, surfaces failure", async () => {
    const id = AtomRef.make("42")
    const ui = await render(Widget(id)(), ApiLive)

    expect(ui.text(".out")).toBe("loading")
    await settle()
    expect(ui.text(".out")).toBe("user-42")

    // reactive refetch: changing id re-runs the effect
    id.set("7")
    await settle()
    expect(ui.text(".out")).toBe("user-7")

    // failure is a value (Failure variant), matched at the use site
    id.set("bad")
    await settle()
    expect(ui.text(".out")).toContain("error")

    // and it recovers on the next good value
    id.set("99")
    await settle()
    expect(ui.text(".out")).toBe("user-99")

    await ui.unmount()
  })
})
