// @vitest-environment happy-dom
/**
 * The `retry` callback every Async failure handler receives (catch-all and
 * tag-map) — re-runs the thunk with a fresh dep snapshot, the leaf analog of
 * `Catch`'s `reset` (which re-runs construction). Distinct from dep-driven
 * recovery (async-tagmap.test.ts): retry re-runs with the SAME inputs after
 * the world changes (backend recovered), no ref write involved.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { Async, h } from "@verrex/core"
import { render } from "./index.ts"

class Users extends Context.Service<Users, {
  readonly get: (id: string) => Effect.Effect<string, NotFound>
}>()("retry/Users") {}
class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly id: string) {}
}
// Mutable backend: tests flip an id from missing to present, then retry.
const db: Record<string, string> = { "42": "Ada" }
const UsersLive = Layer.succeed(Users, {
  get: (id) => (db[id] ? Effect.succeed(db[id]) : Effect.fail(new NotFound(id))),
})

describe("Async failure retry", () => {
  it("catch-all arm: retry re-runs the thunk in place", async () => {
    const Page = Effect.fn(function* () {
      const client = yield* Users
      return yield* h("div", {},
        yield* Async(() => client.get("7"), {
          success: (n) => h("span", { class: "ok" }, n),
          failure: (_cause, retry) =>
            h("button", { class: "retry", onclick: () => retry() }, "retry"),
        }),
      )
    })()
    const ui = await render(Page, UsersLive)
    await ui.waitFor(".retry")
    db["7"] = "Grace" // backend recovers, same input
    try {
      ui.click(".retry")
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Grace")
      expect(ui.query(".retry")).toBeNull()
    } finally {
      delete db["7"]
      await ui.unmount()
    }
  })

  it("tag-map arm: the matched handler's retry re-runs the thunk in place", async () => {
    const Page = Effect.fn(function* () {
      const client = yield* Users
      return yield* h("div", {},
        yield* Async(() => client.get("9"), {
          success: (n) => h("span", { class: "ok" }, n),
          failure: {
            NotFound: (e, retry) =>
              h("button", { class: "retry", onclick: () => retry() }, `missing ${e.id}`),
          },
        }),
      )
    })()
    const ui = await render(Page, UsersLive)
    expect((await ui.waitFor(".retry")).textContent?.trim()).toBe("missing 9")
    db["9"] = "Nia"
    try {
      ui.click(".retry")
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Nia")
    } finally {
      delete db["9"]
      await ui.unmount()
    }
  })

  it("a failed retry renders the failure arm again (still retryable)", async () => {
    let attempts = 0
    const Counting = Layer.succeed(Users, {
      get: (id) => {
        attempts++
        return db[id] ? Effect.succeed(db[id]) : Effect.fail(new NotFound(id))
      },
    })
    const Page = Effect.fn(function* () {
      const client = yield* Users
      return yield* h("div", {},
        yield* Async(() => client.get("404"), {
          success: (n) => h("span", { class: "ok" }, n),
          failure: (_cause, retry) =>
            h("button", { class: "retry", onclick: () => retry() }, "retry"),
        }),
      )
    })()
    const ui = await render(Page, Counting)
    await ui.waitFor(".retry")
    const before = attempts
    ui.click(".retry")
    await ui.waitFor(".retry")
    expect(attempts).toBe(before + 1)
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })
})
