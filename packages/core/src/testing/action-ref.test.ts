// @vitest-environment happy-dom
/**
 * `actionRef` — the lazy sibling of `asyncRef` (#190): a typed seam over
 * Effect's `Atom.fn`. Pins: idle until `run`, `R` resolved from the mount's
 * Layer, an unmatched failure escalates through `Async` to `Catch`, `retry`
 * re-runs the LAST arguments, `run` is a `false` no-op after teardown, and
 * a mid-flight re-run interrupts the prior one (latest wins).
 */
import { describe, it, expect, expectTypeOf } from "vitest"
import { Cause, Effect } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import {
  actionRef,
  type ActionHandle,
  Async,
  Catch,
  h,
  type View,
} from "@verrex/core"
import { render } from "./index.ts"
import {
  makeUsersFixture,
  NotFound,
  type UsersError,
  waitForText,
} from "./fixtures.ts"

const { Users, usersWith } = makeUsersFixture("action")

describe("actionRef", () => {
  it("is idle until run; run resolves the service from the mount Layer", async () => {
    const calls: string[] = []
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const save = yield* actionRef((id: string) => client.get(id))
      expectTypeOf(save).toEqualTypeOf<
        ActionHandle<[id: string], string, UsersError>
      >()
      return yield* h(
        "div",
        {},
        h("button", { class: "run", onclick: () => save.run("7") }, "save"),
        yield* Async(save, {
          initial: h("span", { class: "out" }, "idle"),
          success: (n) => h("span", { class: "out" }, n),
          failure: () => h("span", { class: "out" }, "err"),
        }),
      )
    })()
    const ui = await render(
      Page,
      usersWith((id) => {
        calls.push(id)
        return Effect.succeed(`saved ${id}`)
      }),
    )
    try {
      expect(ui.text(".out")).toBe("idle")
      expect(calls).toEqual([]) // lazy: nothing ran at construction
      ui.click(".run")
      await waitForText(ui, "saved 7", ".out")
      expect(calls).toEqual(["7"])
    } finally {
      await ui.unmount()
    }
  })

  it("an unhandled failure rides View<E> to the nearest Catch; retry re-runs the last args", async () => {
    let fail = true
    const Page = Effect.fn(function* () {
      const client = yield* Users
      const save = yield* actionRef((id: string) => client.get(id))
      const body = h(
        "div",
        {},
        h("button", { class: "run", onclick: () => save.run("9") }, "save"),
        yield* Async(save, {
          initial: h("span", { class: "out" }, "idle"),
          success: (n) => h("span", { class: "out" }, n),
        }),
      )
      expectTypeOf(body).toEqualTypeOf<
        Effect.Effect<View<UsersError>, never, never>
      >()
      return yield* Catch(body, (cause, reset) =>
        h(
          "button",
          {
            class: "caught",
            onclick: () => {
              fail = false
              save.refetch() // re-runs the LAST args ("9")
              reset()
            },
          },
          Cause.squash(cause) instanceof NotFound ? "notfound" : "other",
        ),
      )
    })()
    const ui = await render(
      Page,
      usersWith((id) =>
        fail ? Effect.fail(new NotFound({ id })) : Effect.succeed(`ok ${id}`),
      ),
    )
    try {
      ui.click(".run")
      expect((await ui.waitFor(".caught")).textContent).toBe("notfound")
      ui.click(".caught")
      expect((await ui.waitFor(".out")).textContent).toBe("ok 9")
    } finally {
      await ui.unmount()
    }
  })

  it("refetch before any run is a false no-op; run after unmount is a false no-op", async () => {
    let handle!: ActionHandle<[string], string, UsersError>
    const Page = Effect.fn(function* () {
      const client = yield* Users
      handle = yield* actionRef((id: string) => client.get(id))
      return yield* h("div", {}, "x")
    })()
    const ui = await render(
      Page,
      usersWith((id) => Effect.succeed(id)),
    )
    expect(handle.refetch()).toBe(false)
    expect(AsyncResult.isInitial(handle.state.value)).toBe(true)
    await ui.unmount()
    expect(handle.run("1")).toBe(false)
  })

  it("a re-run while in flight interrupts the prior run (latest wins)", async () => {
    const started: string[] = []
    const settled: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let handle!: ActionHandle<[string], string, UsersError>
    const Page = Effect.fn(function* () {
      const client = yield* Users
      handle = yield* actionRef((id: string) => client.get(id))
      return yield* h(
        "span",
        { class: "out" },
        handle.state.map((s) =>
          s._tag === "Success" ? s.value : s.waiting ? "waiting" : "idle",
        ),
      )
    })()
    const ui = await render(
      Page,
      usersWith((id) =>
        Effect.gen(function* () {
          started.push(id)
          yield* Effect.promise(() => gate)
          settled.push(id)
          return id
        }),
      ),
    )
    try {
      handle.run("a")
      expect(ui.text(".out")).toBe("waiting") // flipped synchronously
      handle.run("b")
      release()
      await waitForText(ui, "b", ".out")
      expect(started).toEqual(["a", "b"])
      expect(settled).toEqual(["b"]) // "a" was interrupted at the gate
    } finally {
      await ui.unmount()
    }
  })
})
