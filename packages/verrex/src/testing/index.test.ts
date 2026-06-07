// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "verrex"
import { render } from "./index.ts"

// Components are built with raw `h()` calls (no `.vx` compiler needed in the
// unit test) — an AtomRef passed as a child coerces to a reactive node.

describe("render() harness", () => {
  it("mounts a component and reflects a reactive update from a click", async () => {
    const Counter = Effect.fn(function* () {
      const count = AtomRef.make(0)
      return yield* h(
        "div",
        { class: "counter" },
        h("button", { class: "inc", onclick: () => count.update((n) => n + 1) }, "+"),
        h("span", { class: "n" }, count),
      )
    })

    const ui = await render(Counter())
    expect(ui.text(".n")).toBe("0")

    ui.click(".inc")
    await ui.tick()
    expect(ui.text(".n")).toBe("1")

    ui.click(".inc")
    await ui.tick()
    expect(ui.text(".n")).toBe("2")

    await ui.unmount()
    expect(document.body.contains(ui.container)).toBe(false)
  })

  it("fires scope finalizers on unmount", async () => {
    const log: string[] = []
    const Resource = Effect.fn(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => log.push("acquire")),
        () => Effect.sync(() => log.push("release")),
      )
      return yield* h("div", { class: "res" }, "live")
    })

    const ui = await render(Resource())
    expect(ui.text(".res")).toBe("live")
    expect(log).toEqual(["acquire"])

    await ui.unmount()
    expect(log).toEqual(["acquire", "release"])
  })

  it("renders a component once its required service is provided via layer", async () => {
    class Greeter extends Context.Service<Greeter, {
      readonly hello: (name: string) => string
    }>()("test/Greeter") {}

    const GreeterTest: Layer.Layer<Greeter> = Layer.succeed(Greeter, {
      hello: (name) => `hi ${name}`,
    })

    const Hello = Effect.fn(function* () {
      const greeter = yield* Greeter
      return yield* h("p", { class: "msg" }, greeter.hello("ada"))
    })

    // `render` requires a layer covering Greeter — omitting it is a compile
    // error (the channel is not swallowed). Provide the test layer:
    const ui = await render(Hello(), GreeterTest)
    expect(ui.text(".msg")).toBe("hi ada")
    await ui.unmount()
  })
})
