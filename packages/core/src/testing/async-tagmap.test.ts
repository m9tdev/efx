// @vitest-environment happy-dom
/**
 * Async with a tag-map `failure` arm — `failure: { Tag: handler }`. A matched
 * tag renders locally while the asyncRef STAYS LIVE: a dep change still
 * refetches, so the view recovers with no boundary `reset` — the semantic a
 * leaf `Catch` can't express (an accepted failure swaps the subtree and closes
 * its build scope, tearing down the supervisor). An unmatched tag rides the
 * live channel to the nearest `Catch`, exactly like the open form
 * (async-escalate.test.ts).
 */
import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, type Scope } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Async, Catch, h, type View } from "@verrex/core"
import { render } from "./index.ts"

class Users extends Context.Service<Users, {
  readonly get: (id: string) => Effect.Effect<string, NotFound | Timeout>
}>()("tagmap/Users") {}
class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly id: string) {}
}
class Timeout {
  readonly _tag = "Timeout"
}
const db: Record<string, string> = { "42": "Ada", "7": "Grace" }
const UsersLive = Layer.succeed(Users, {
  get: (id) =>
    id === "slow"
      ? Effect.fail(new Timeout())
      : db[id]
        ? Effect.succeed(db[id])
        : Effect.fail(new NotFound(id)),
})
const read = (h as unknown as { read: (r: unknown) => string }).read

// NotFound is handled at the leaf; Timeout is not — it escalates to the
// page-level catch-all.
const Page = (userId: AtomRef.AtomRef<string>) =>
  Effect.fn(function* () {
    const client = yield* Users
    return yield* h("div", { class: "page" },
      yield* Catch(
        h("section", { class: "content" },
          Async(() => client.get(read(userId)), {
            initial: h("span", { class: "loading" }, "…"),
            success: (n) => h("span", { class: "ok" }, n),
            failure: {
              NotFound: (e) => h("span", { class: "missing" }, `no user ${e.id}`),
            },
          }),
        ),
        (_cause, reset) =>
          h("div", { class: "fallback" },
            h("button", { class: "retry", onclick: reset }, "retry"),
          ),
      ),
    )
  })()

describe("Async tag-map failure arm", () => {
  it("renders a matched tag's handler in place (unwrapped error), boundary untouched", async () => {
    const ui = await render(Page(AtomRef.make("999")), UsersLive)
    expect((await ui.waitFor(".missing")).textContent?.trim()).toBe("no user 999")
    expect(ui.query(".fallback")).toBeNull()
    expect(ui.query(".content")).not.toBeNull()
    await ui.unmount()
  })

  it("matched failure keeps the fetch loop live: a dep change refetches and recovers, no reset", async () => {
    const userId = AtomRef.make("999")
    const ui = await render(Page(userId), UsersLive)
    await ui.waitFor(".missing")
    userId.set("42") // fix the input — the tracked thunk re-runs by itself
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    expect(ui.query(".missing")).toBeNull()
    expect(ui.query(".fallback")).toBeNull()
    await ui.unmount()
  })

  it("a REFETCH failure after success renders the matched handler in place", async () => {
    const userId = AtomRef.make("42")
    const ui = await render(Page(userId), UsersLive)
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    userId.set("999")
    await ui.waitFor(".missing")
    expect(ui.query(".ok")).toBeNull()
    expect(ui.query(".fallback")).toBeNull()
    await ui.unmount()
  })

  it("an UNMATCHED tag escalates to the nearest Catch, like the open form", async () => {
    const ui = await render(Page(AtomRef.make("slow")), UsersLive)
    await ui.waitFor(".fallback")
    expect(ui.query(".missing")).toBeNull()
    expect(ui.query(".content")).toBeNull()
    await ui.unmount()
  })

  it("a nullish failure arm smuggled past the types degrades to the open form, not a crash", async () => {
    // Regression pin: the impl guards with truthiness, so `failure: null`
    // (reachable only via JS or a cast) behaves like the omitted arm —
    // the cause rides to the boundary instead of throwing in Object.hasOwn.
    const NullPage = Effect.fn(function* () {
      const client = yield* Users
      return yield* Catch(
        h("section", {},
          Async(() => client.get("999"), {
            success: (n) => h("span", { class: "ok" }, n),
            failure: null as never,
          }),
        ),
        () => h("div", { class: "fallback" }, "caught"),
      )
    })()
    const ui = await render(NullPage, UsersLive)
    await ui.waitFor(".fallback")
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })

  it("types: matched tags are excluded from the live channel", () => {
    // Compile-time pin, kept next to the runtime proof: a partial tag map
    // narrows by Exclude; a full map discharges to View<never>.
    const partial = (get: (id: string) => Effect.Effect<string, NotFound | Timeout>) =>
      Async(() => get("42"), {
        success: (n) => h("span", {}, n),
        failure: { NotFound: (e) => h("span", {}, e.id) },
      }) satisfies Effect.Effect<View<Timeout>, never, Scope.Scope>
    const full = (get: (id: string) => Effect.Effect<string, NotFound | Timeout>) =>
      Async(() => get("42"), {
        success: (n) => h("span", {}, n),
        failure: {
          NotFound: (e) => h("span", {}, e.id),
          Timeout: () => h("span", {}, "slow"),
        },
      }) satisfies Effect.Effect<View, never, Scope.Scope>
    expect(typeof partial).toBe("function")
    expect(typeof full).toBe("function")
  })
})
