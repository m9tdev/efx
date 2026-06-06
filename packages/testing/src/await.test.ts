/**
 * F1: async render boundary (Await), run-once form. `Await(effect, arms)` runs
 * the effect on the mount fiber and renders pending → success/error.
 * Proves: channel folding (R reflects the effect, E handled by onError → never,
 * no cast) and runtime behavior in-process.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Scope } from "effect"
import { Await, h, type View } from "@efx/runtime"
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

// ② folding (no cast): R = Greeter folds through; E handled by onError → never.
const _folds = Await(() => greeting, {
  pending: h("span", { class: "p" }, "…"),
  onSuccess: (msg) => h("span", { class: "ok" }, msg),
  onError: () => h("span", { class: "err" }, "boom"),
}) satisfies Effect.Effect<View, never, Greeter | Scope.Scope>
void _folds

const page = (effect: Effect.Effect<string, GreetError, Greeter>) =>
  Effect.fn(function* () {
    return yield* h(
      "div",
      { class: "page" },
      yield* Await(() => effect, {
        pending: h("span", { class: "loading" }, "loading"),
        onSuccess: (msg) => h("span", { class: "ok" }, msg),
        onError: () => h("span", { class: "err" }, "failed"),
      }),
    )
  })()

describe("Await (once)", () => {
  it("renders pending immediately, running the effect in the provided context", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
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

  it("renders the error arm when the effect fails", async () => {
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
        yield* Await(() => Effect.never as Effect.Effect<string, never, never>, {
          pending: h("span", { class: "loading" }, "…"),
          onSuccess: () => h("span", {}, "x"),
        }),
      )
    })()
    const ui = await render(Never)
    expect(ui.query(".loading")).not.toBeNull()
    await ui.unmount()
    expect(document.body.contains(ui.container)).toBe(false)
  })
})
