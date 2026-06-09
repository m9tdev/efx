// @vitest-environment happy-dom
/**
 * Auto-tracking Async: `Async(() => client.get(userId.value), arms)` refetches
 * when userId changes — deps discovered, not declared. Emulates the compiler's
 * `.value`→h.read by calling read() inside the thunk.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Scope } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Async, h, type View } from "@verrex/core"
import { render } from "./index.ts"

class Users extends Context.Service<Users, {
  readonly get: (id: string) => Effect.Effect<string, GetErr>
}>()("at/Users") {}
class GetErr { readonly _tag = "GetErr"; constructor(readonly id: string) {} }
const db: Record<string, string> = { "42": "Ada", "7": "Grace" }
const UsersLive = Layer.succeed(Users, {
  get: (id) => (db[id] ? Effect.succeed(db[id]) : Effect.fail(new GetErr(id))),
})
const read = (h as unknown as { read: (r: unknown) => string }).read

// folding: a thunk whose effect has no R → Async is Effect<View, never, Scope>.
const _folds = (userId: AtomRef.AtomRef<string>, get: (id: string) => Effect.Effect<string, GetErr>) =>
  Async(() => get(read(userId)), {
    success: (n) => h("span", {}, n),
  }) satisfies Effect.Effect<View, never, Scope.Scope>
void _folds

const Page = (userId: AtomRef.AtomRef<string>) =>
  Effect.fn(function* () {
    const client = yield* Users
    return yield* h("div", { class: "page" },
      h("button", { class: "grace", onclick: () => userId.set("7") }, "Grace"),
      h("button", { class: "bad", onclick: () => userId.set("999") }, "Bad"),
      yield* Async(() => client.get(read(userId)), {
        initial: h("span", { class: "loading" }, "…"),
        success: (n) => h("span", { class: "ok" }, n),
        failure: () => h("span", { class: "err" }, "not found"),
      }),
    )
  })()

describe("auto-tracking Async", () => {
  it("fetches initial, then auto-refetches when the read ref changes", async () => {
    const userId = AtomRef.make("42")
    const ui = await render(Page(userId), UsersLive)
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    ui.click(".grace")
    const d = Date.now() + 1000
    while (ui.query(".ok")?.textContent?.trim() !== "Grace" && Date.now() < d) await ui.tick()
    expect(ui.query(".ok")?.textContent?.trim()).toBe("Grace")
    await ui.unmount()
  })

  it("refetches even when the thunk is extracted to a separate binding", async () => {
    // The gap the whole-body `.value`→h.read rewrite closes: a thunk lifted out
    // of the Async(...) call site. Post-compile it's `const get = () =>
    // client.get(h.read(userId))`, so the read still happens inside the thunk
    // Async runs under its tracker — and tracking works identically to inline.
    const userId = AtomRef.make("42")
    const ExtractedPage = Effect.fn(function* () {
      const client = yield* Users
      const get = () => client.get(read(userId)) // extracted thunk
      return yield* h("div", { class: "page" },
        h("button", { class: "grace", onclick: () => userId.set("7") }, "Grace"),
        yield* Async(get, {
          initial: h("span", { class: "loading" }, "…"),
          success: (n) => h("span", { class: "ok" }, n),
          failure: () => h("span", { class: "err" }, "not found"),
        }),
      )
    })
    const ui = await render(ExtractedPage(), UsersLive)
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    ui.click(".grace")
    const d = Date.now() + 1000
    while (ui.query(".ok")?.textContent?.trim() !== "Grace" && Date.now() < d) await ui.tick()
    expect(ui.query(".ok")?.textContent?.trim()).toBe("Grace")
    await ui.unmount()
  })

  it("auto-refetch shows the failure arm on a bad key", async () => {
    const userId = AtomRef.make("42")
    const ui = await render(Page(userId), UsersLive)
    await ui.waitFor(".ok")
    ui.click(".bad")
    expect((await ui.waitFor(".err")).textContent?.trim()).toBe("not found")
    await ui.unmount()
  })
})
