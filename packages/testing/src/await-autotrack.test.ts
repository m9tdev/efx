/**
 * Auto-tracking Await: `Await(() => client.get(userId.value), arms)` refetches
 * when userId changes — deps discovered, not declared. Emulates the compiler's
 * `.value`→h.read by calling read() inside the thunk.
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Scope } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Await, h, type View } from "@efx/runtime"
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

// ② folding: a thunk whose effect has no R → Await is Effect<View, never, Scope>.
const _folds = (userId: AtomRef.AtomRef<string>, get: (id: string) => Effect.Effect<string, GetErr>) =>
  Await(() => get(read(userId)), {
    onSuccess: (n) => h("span", {}, n),
  }) satisfies Effect.Effect<View, never, Scope.Scope>
void _folds

const Page = (userId: AtomRef.AtomRef<string>) =>
  Effect.fn(function* () {
    const client = yield* Users
    return yield* h("div", { class: "page" },
      h("button", { class: "grace", onclick: () => userId.set("7") }, "Grace"),
      h("button", { class: "bad", onclick: () => userId.set("999") }, "Bad"),
      yield* Await(() => client.get(read(userId)), {
        pending: h("span", { class: "loading" }, "…"),
        onSuccess: (n) => h("span", { class: "ok" }, n),
        onError: () => h("span", { class: "err" }, "not found"),
      }),
    )
  })()

describe("auto-tracking Await", () => {
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

  it("auto-refetch shows the error arm on a bad key", async () => {
    const userId = AtomRef.make("42")
    const ui = await render(Page(userId), UsersLive)
    await ui.waitFor(".ok")
    ui.click(".bad")
    expect((await ui.waitFor(".err")).textContent?.trim()).toBe("not found")
    await ui.unmount()
  })
})
