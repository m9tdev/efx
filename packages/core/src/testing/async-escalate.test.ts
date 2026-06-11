// @vitest-environment happy-dom
/**
 * Async without a `failure` arm — the open form. The failure is not handled at
 * the leaf; it rides the live channel (`View<E>`) to the nearest `Catch`: both
 * an initial-fetch failure and a refetch failure flip the boundary to its
 * fallback, and the boundary's `reset` re-runs construction → a fresh fetch.
 * (The handled form — `failure` provided — is covered by async-boundary.test.ts.)
 */
import { describe, it, expect } from "vitest"
import { Cause, Effect, type Scope } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Async, Catch, h, type View } from "@verrex/core"
import { render } from "./index.ts"
import { makeUsersFixture, NotFound } from "./fixtures.ts"

const { Users, UsersLive } = makeUsersFixture("esc")

// A page-level catch-all boundary around content that fetches via the open
// form. The id-switching button lives OUTSIDE the boundary so it survives the
// fallback swap.
const Page = (userId: AtomRef.AtomRef<string>) =>
  Effect.fn(function* () {
    const client = yield* Users
    return yield* h("div", { class: "page" },
      h("button", { class: "bad", onclick: () => userId.set("999") }, "bad"),
      yield* Catch(
        h("section", { class: "content" },
          Async(() => client.get(h.read(userId)), {
            initial: h("span", { class: "loading" }, "…"),
            success: (n) => h("span", { class: "ok" }, n),
          }),
        ),
        (cause, reset) =>
          h("div", { class: "fallback" },
            h("pre", { class: "caught" }, Cause.pretty(cause)),
            h("button", { class: "retry", onclick: reset }, "retry"),
          ),
      ),
    )
  })()

describe("Async without failure arm → nearest Catch", () => {
  it("routes an initial-fetch failure to the boundary fallback (cause included)", async () => {
    const ui = await render(Page(AtomRef.make("999")), UsersLive)
    const fallback = await ui.waitFor(".fallback")
    expect(fallback.querySelector(".caught")?.textContent).toContain("NotFound")
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })

  it("routes a REFETCH failure to the boundary — content already rendered", async () => {
    const userId = AtomRef.make("42")
    const ui = await render(Page(userId), UsersLive)
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    ui.click(".bad") // userId → "999": tracked refetch fails post-mount
    await ui.waitFor(".fallback")
    expect(ui.query(".ok")).toBeNull()
    await ui.unmount()
  })

  it("reset re-runs construction → a fresh fetch that can succeed", async () => {
    const userId = AtomRef.make("999")
    const ui = await render(Page(userId), UsersLive)
    await ui.waitFor(".fallback")
    userId.set("42") // fix the input, then retry
    ui.click(".retry")
    expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("Ada")
    expect(ui.query(".fallback")).toBeNull()
    await ui.unmount()
  })

  it("a tag-map Catch routes on the failure's tag and unwraps it", async () => {
    const TagPage = Effect.fn(function* () {
      const client = yield* Users
      return yield* Catch(
        h("section", {},
          Async(() => client.get("999"), {
            success: (n) => h("span", { class: "ok" }, n),
          }),
        ),
        {
          NotFound: (e, _reset) => h("p", { class: "tagged" }, `missing user ${e.id}`),
          // Never fires here — present to fully discharge the fixture's error union.
          Timeout: () => h("p", { class: "tagged" }, "timed out"),
        },
      )
    })()
    const ui = await render(TagPage, UsersLive)
    expect((await ui.waitFor(".tagged")).textContent?.trim()).toBe("missing user 999")
    await ui.unmount()
  })

  it("the open form still types R (service folds) and stamps View<E>", () => {
    // Compile-time pin, kept next to the runtime proof: omitting `failure`
    // stamps E on the View channel; providing it discharges to View<never>.
    const open = (get: (id: string) => Effect.Effect<string, NotFound>) =>
      Async(() => get("42"), {
        success: (n) => h("span", {}, n),
      }) satisfies Effect.Effect<View<NotFound>, never, Scope.Scope>
    const handled = (get: (id: string) => Effect.Effect<string, NotFound>) =>
      Async(() => get("42"), {
        success: (n) => h("span", {}, n),
        failure: () => h("span", {}, "nope"),
      }) satisfies Effect.Effect<View, never, Scope.Scope>
    expect(typeof open).toBe("function")
    expect(typeof handled).toBe("function")
  })
})
