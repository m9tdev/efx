// @vitest-environment happy-dom
/**
 * `AsyncHandle` — the `{ state, refetch }` pair `asyncRef` returns, and
 * `Async`'s handle-accepting form. The handle decouples the fetch loop from
 * the rendering subtree: external code can refetch, two consumers can share
 * one loop, and a `Catch` swapping the view away does not kill the data.
 * Boundary `reset` over a handle re-renders CURRENT state (no refetch) — the
 * documented composition is `() => { handle.refetch(); reset() }`.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, type Scope } from "effect"
import { Async, asyncRef, h, Catch, type AsyncHandle, type View } from "@verrex/core"
import { render } from "./index.ts"

class Users extends Context.Service<Users, {
  readonly get: (id: string) => Effect.Effect<string, NotFound>
}>()("handle/Users") {}
class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly id: string) {}
}
const usersWith = (get: (id: string) => Effect.Effect<string, NotFound>) =>
  Layer.succeed(Users, { get })

describe("AsyncHandle", () => {
  it("Async accepts a handle: renders its state, arms' retry is the handle's refetch", async () => {
    let recovered = false
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const user = yield* asyncRef(() => client.get("7"))
      return yield* h("div", {},
        h("button", { class: "external", onclick: user.refetch }, "refresh"),
        yield* Async(user, {
          initial: h("span", { class: "loading" }, "…"),
          success: (n) => h("span", { class: "ok" }, n),
          failure: (_cause, retry) =>
            h("button", { class: "retry", onclick: () => retry() }, "retry"),
        }),
      )
    })()
    const ui = await render(Page, usersWith((id) =>
      recovered ? Effect.succeed(`hi ${id}`) : Effect.fail(new NotFound(id))))
    try {
      await ui.waitFor(".retry")
      recovered = true
      ui.click(".retry") // the arm's retry IS handle.refetch
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("hi 7")
    } finally {
      await ui.unmount()
    }
  })

  it("an EXTERNAL refetch (outside the Async subtree) re-runs the fetch", async () => {
    let version = 0
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const user = yield* asyncRef(() => client.get("7"))
      return yield* h("div", {},
        h("button", { class: "external", onclick: user.refetch }, "refresh"),
        yield* Async(user, {
          success: (n) => h("span", { class: "ok" }, n),
          failure: () => h("span", { class: "err" }, "fail"),
        }),
      )
    })()
    const ui = await render(Page, usersWith((id) => Effect.succeed(`v${++version} ${id}`)))
    try {
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("v1 7")
      ui.click(".external")
      const deadline = Date.now() + 1000
      while (ui.query(".ok")?.textContent?.trim() !== "v2 7") {
        if (Date.now() > deadline) throw new Error("timed out waiting for v2")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(version).toBe(2)
    } finally {
      await ui.unmount()
    }
  })

  it("one handle, two consumers: both render the shared fetch loop", async () => {
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const user = yield* asyncRef(() => client.get("7"))
      return yield* h("div", {},
        yield* Async(user, {
          success: (n) => h("span", { class: "a" }, n),
          failure: () => h("span", {}, "fail"),
        }),
        yield* Async(user, {
          success: (n) => h("strong", { class: "b" }, n),
          failure: () => h("span", {}, "fail"),
        }),
      )
    })()
    let calls = 0
    const ui = await render(Page, usersWith((id) => {
      calls++
      return Effect.succeed(`hi ${id}`)
    }))
    try {
      expect((await ui.waitFor(".a")).textContent?.trim()).toBe("hi 7")
      expect((await ui.waitFor(".b")).textContent?.trim()).toBe("hi 7")
      expect(calls).toBe(1) // one loop, not one per consumer
    } finally {
      await ui.unmount()
    }
  })

  it("the handle outlives a boundary swap: refetch + reset recovers an escalated view", async () => {
    let recovered = false
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const user = yield* asyncRef(() => client.get("9"))
      return yield* h("div", {},
        yield* Catch(
          h("section", {}, Async(user, { success: (n) => h("span", { class: "ok" }, n) })),
          (_cause, reset) =>
            h("button", { class: "boundary-retry", onclick: () => { user.refetch(); reset() } },
              "retry"),
        ),
      )
    })()
    const ui = await render(Page, usersWith((id) =>
      recovered ? Effect.succeed(`hi ${id}`) : Effect.fail(new NotFound(id))))
    try {
      await ui.waitFor(".boundary-retry") // open form escalated to the boundary
      recovered = true
      ui.click(".boundary-retry") // refetch + reset composed
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("hi 9")
    } finally {
      await ui.unmount()
    }
  })

  it("refetch after the creating scope closed is a silent no-op returning false", async () => {
    let captured!: AsyncHandle<string, NotFound>
    let thunkRuns = 0
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const user = yield* asyncRef(() => {
        thunkRuns++
        return client.get("7")
      })
      captured = user
      return yield* h("div", {},
        yield* Async(user, {
          success: (n) => h("span", { class: "ok" }, n),
          failure: () => h("span", {}, "fail"),
        }),
      )
    })()
    const ui = await render(Page, usersWith((id) => Effect.succeed(`hi ${id}`)))
    await ui.waitFor(".ok")
    expect(captured.refetch()).toBe(true) // alive: scheduled
    await ui.unmount()
    const runsAtClose = thunkRuns
    expect(captured.refetch()).toBe(false) // dead: dropped, signalled
    expect(thunkRuns).toBe(runsAtClose) // and the thunk did NOT re-run
  })
})

// Compile-time pins (no runtime component — `satisfies` does the work):
// handle-based Async contributes only Scope to R; E homes work as with a thunk.
const _openPin = (user: AsyncHandle<string, NotFound>) =>
  Async(user, {
    success: (n) => h("span", {}, n),
  }) satisfies Effect.Effect<View<NotFound>, never, Scope.Scope>
const _tagMapPin = (user: AsyncHandle<string, NotFound>) =>
  Async(user, {
    success: (n) => h("span", {}, n),
    failure: { NotFound: (e, retry) => h("button", { onclick: retry }, e.id) },
  }) satisfies Effect.Effect<View, never, Scope.Scope>
void _openPin
void _tagMapPin
