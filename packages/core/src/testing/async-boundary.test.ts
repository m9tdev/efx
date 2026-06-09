// @vitest-environment happy-dom
/**
 * Async render boundary, run-once form. `Async(from, arms)` runs the effect on
 * the mount fiber and renders the three AsyncResult states (initial → success /
 * failure). Proves: channel folding (R reflects the effect, failure handled by
 * the `failure` arm → E never, no cast) and runtime behavior in-process.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Scope } from "effect"
import { Async, h, type View } from "@verrex/core"
import { render } from "./index.ts"

class Greeter extends Context.Service<Greeter, {
  readonly greet: (name: string) => Effect.Effect<string, GreetError>
}>()("spike/Greeter") {}

class GreetError {
  readonly _tag = "GreetError"
  constructor(readonly who: string) {}
}

const GreeterOk: Layer.Layer<Greeter> = Layer.succeed(Greeter, {
  greet: (name) => Effect.succeed(`hello ${name}`),
})
const GreeterBoom: Layer.Layer<Greeter> = Layer.succeed(Greeter, {
  greet: (name) => Effect.fail(new GreetError(name)),
})

const greeting = Effect.gen(function* () {
  const g = yield* Greeter
  return yield* g.greet("ada")
})

// folding (no cast): R = Greeter folds through; failure handled → E never.
const _folds = Async(() => greeting, {
  initial: h("span", { class: "p" }, "…"),
  success: (msg) => h("span", { class: "ok" }, msg),
  failure: () => h("span", { class: "err" }, "boom"),
}) satisfies Effect.Effect<View, never, Greeter | Scope.Scope>
void _folds

const page = (effect: Effect.Effect<string, GreetError, Greeter>) =>
  Effect.fn(function* () {
    return yield* h(
      "div",
      { class: "page" },
      yield* Async(() => effect, {
        initial: h("span", { class: "loading" }, "loading"),
        success: (msg) => h("span", { class: "ok" }, msg),
        failure: () => h("span", { class: "err" }, "failed"),
      }),
    )
  })()

describe("Async (once)", () => {
  it("renders initial immediately, running the effect in the provided context", async () => {
    const gate = new Promise<void>(() => {}) // never resolves
    const gated = Effect.gen(function* () {
      const g = yield* Greeter
      yield* Effect.promise(() => gate)
      return yield* g.greet("ada")
    })
    const ui = await render(page(gated), GreeterOk)
    expect(ui.text(".loading")).toBe("loading")
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })

  it("renders the success arm after a suspended effect resolves", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const gated = Effect.gen(function* () {
      const g = yield* Greeter
      yield* Effect.promise(() => gate)
      return yield* g.greet("ada")
    })
    const ui = await render(page(gated), GreeterOk)
    release()
    const ok = await ui.waitFor(".ok")
    expect(ok.textContent?.trim()).toBe("hello ada")
    await ui.unmount()
  })

  it("renders the failure arm when the effect fails", async () => {
    const ui = await render(page(greeting), GreeterBoom)
    const err = await ui.waitFor(".err")
    expect(err.textContent?.trim()).toBe("failed")
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })

  it("interrupts the in-flight fiber on unmount (never-resolving effect)", async () => {
    const Never = Effect.fn(function* () {
      return yield* h(
        "div",
        {},
        yield* Async(() => Effect.never as Effect.Effect<string, never, never>, {
          initial: h("span", { class: "loading" }, "…"),
          success: () => h("span", {}, "x"),
        }),
      )
    })()
    const ui = await render(Never)
    expect(ui.query(".loading")).not.toBeNull()
    await ui.unmount()
    expect(document.body.contains(ui.container)).toBe(false)
  })
})
