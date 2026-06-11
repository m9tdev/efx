// @vitest-environment happy-dom
/**
 * The `retry` callback every Async failure handler receives (catch-all and
 * tag-map) — re-runs the thunk with a fresh dep snapshot, the leaf analog of
 * `Catch`'s `reset` (which re-runs construction). Distinct from dep-driven
 * recovery (async-tagmap.test.ts): retry re-runs with the SAME inputs after
 * the world changes (backend recovered), no ref write involved. While the
 * re-run is in flight the `initial` arm renders (failure-waiting is not
 * stale-while-revalidate — a stale error isn't content); that transition is
 * pinned by the gated test below.
 */
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { Async, h } from "@verrex/core"
import { render } from "./index.ts"
import { makeUsersFixture, NotFound } from "./fixtures.ts"

// Each test builds its own layer (usersWith) over test-local state — nothing
// shared to leak between tests.
const { Users, usersWith } = makeUsersFixture("retry")

// Catch-all page, shared by tests 1 and 3.
const CatchAllPage = Effect.fn(function* () {
  const client = yield* Users
  return yield* h("div", {},
    yield* Async(() => client.get("7"), {
      initial: h("span", { class: "loading" }, "…"),
      success: (n) => h("span", { class: "ok" }, n),
      failure: (_cause, retry) =>
        h("button", { class: "retry", onclick: () => retry() }, "retry"),
    }),
  )
})

describe("Async failure retry", () => {
  it("catch-all arm: retry re-runs the thunk in place", async () => {
    let recovered = false
    const ui = await render(
      CatchAllPage(),
      usersWith((id) => (recovered ? Effect.succeed(`hi ${id}`) : Effect.fail(new NotFound({ id })))),
    )
    try {
      await ui.waitFor(".retry")
      recovered = true // backend recovers, same input
      ui.click(".retry")
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("hi 7")
      expect(ui.query(".retry")).toBeNull()
    } finally {
      await ui.unmount()
    }
  })

  it("tag-map arm: the matched handler's retry re-runs the thunk in place", async () => {
    let recovered = false
    const Page = Effect.fn(function* () {
      const client = yield* Users
      return yield* h("div", {},
        yield* Async(() => client.get("9"), {
          success: (n) => h("span", { class: "ok" }, n),
          failure: {
            NotFound: (e, retry) =>
              h("button", { class: "retry", onclick: () => retry() }, `missing ${e.id}`),
            // Never fires here — present to fully discharge the fixture's error union.
            Timeout: () => h("span", {}, "timed out"),
          },
        }),
      )
    })()
    const ui = await render(
      Page,
      usersWith((id) => (recovered ? Effect.succeed(`hi ${id}`) : Effect.fail(new NotFound({ id })))),
    )
    try {
      expect((await ui.waitFor(".retry")).textContent?.trim()).toBe("missing 9")
      recovered = true
      ui.click(".retry")
      expect((await ui.waitFor(".ok")).textContent?.trim()).toBe("hi 9")
    } finally {
      await ui.unmount()
    }
  })

  it("a failed retry shows the initial arm in flight, then renders the failure arm again", async () => {
    // The retry run is gated so the in-flight window is deterministic: the
    // initial arm must render while the re-run is pending (failure-waiting →
    // initial, the testable retry observable), and the failure arm must come
    // back — still retryable — when the re-run fails too.
    let attempts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ui = await render(
      CatchAllPage(),
      usersWith((id) =>
        Effect.gen(function* () {
          attempts++
          if (attempts > 1) yield* Effect.promise(() => gate)
          return yield* Effect.fail(new NotFound({ id }))
        }),
      ),
    )
    try {
      await ui.waitFor(".retry")
      expect(attempts).toBe(1)
      ui.click(".retry")
      await ui.waitFor(".loading") // waiting: initial arm, not the stale error
      expect(ui.query(".retry")).toBeNull()
      release() // the gated re-run completes — still failing
      await ui.waitFor(".retry") // arm is back and live
      expect(attempts).toBe(2) // the EFFECT executed, not just the thunk
      expect(ui.query(".ok")).toBeNull()
    } finally {
      await ui.unmount()
    }
  })
})
