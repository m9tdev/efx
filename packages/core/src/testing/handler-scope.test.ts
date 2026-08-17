// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Data, Deferred, Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Catch, For, h } from "@verrex/core"
import { Step, stepLayer } from "./fixtures.ts"
import { render, untracked } from "./index.ts"

// The dispatch-scope pins (#160/#161, runtime/AGENTS.md "Handler-scope
// semantics" under "mount internals — invariants"): every dispatch runs in its own child scope forked from the
// OWNER scope — the scope of the dynamic node that ran the element's
// construction — so (a) finalizers release per dispatch, (b) a handler whose
// own ref write re-renders its subtree SURVIVES that re-render, and (c) the
// owning subtree's teardown still interrupts an in-flight handler. The
// per-node teardown discriminator lives in context-capture.test.ts; this file
// pins the dispatch semantics.

const openGate = (gate: Deferred.Deferred<void>): void => {
  Effect.runSync(Deferred.succeed(gate, void 0))
}

describe("per-dispatch handler scope", () => {
  it("a handler survives the re-render its own write triggers (#161)", async () => {
    // The pending→run→settle mutation pattern: the handler's FIRST action
    // swaps its own subtree (hiding the button it was dispatched from), then
    // awaits async work, then settles. Pre-#161 the swap closed the build
    // scope the fiber was forked into — everything after the first suspension
    // was silently dropped. Now the owner (the Reactive NODE's scope)
    // survives the emit, so the work completes. `sinkCauses` must stay EMPTY
    // throughout: an interrupted handler now reaches the sink (#186), so this
    // is the direct assertion that the continuation ran — not just that the
    // first write landed.
    const gate = Deferred.makeUnsafe<void>()
    const done = AtomRef.make("no")
    const slot = AtomRef.make<unknown>(null)
    const makeButton = () =>
      h(
        "button",
        {
          class: "save",
          onClick: () =>
            Effect.gen(function* () {
              slot.set(h("span", { class: "busy" }, "saving…"))
              yield* Deferred.await(gate)
              done.set("yes")
              slot.set(h("span", { class: "idle" }, "saved"))
            }),
        },
        "save",
      )
    slot.set(makeButton())

    const App = Effect.fn("Optimistic")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        {},
        slot as AtomRef.AtomRef<Effect.Effect<unknown, never, never>>,
      )
    })

    const ui = await render(App())
    ui.click(".save")
    await ui.tick()
    // The optimistic write landed (button replaced) and the handler is parked.
    expect(ui.query(".busy")).not.toBeNull()
    expect(done.value).toBe("no")

    openGate(gate)
    await ui.tick()
    // The post-suspension half ran: the confirm write landed and the UI
    // settled back to idle.
    expect(done.value).toBe("yes")
    expect(ui.text(".idle")).toBe("saved")
    expect(ui.sinkCauses).toEqual([])
    await ui.unmount()
  })

  it("a handler's typed failure reaches Catch even after its own re-render (#161)", async () => {
    // The error-channel corollary: a handler that first re-renders its own
    // subtree and THEN fails must still deliver that failure to the enclosing
    // boundary. Pre-#161 the interrupt won the race and the boundary never
    // fired — the user declared the error, added the boundary, and got
    // silence.
    class SaveError extends Data.TaggedError("SaveError") {}
    const gate = Deferred.makeUnsafe<void>()
    const slot = AtomRef.make<unknown>(null)
    slot.set(
      h(
        "button",
        {
          class: "save",
          onClick: () =>
            Effect.gen(function* () {
              slot.set(h("span", { class: "busy" }, "saving…"))
              yield* Deferred.await(gate)
              return yield* Effect.fail(new SaveError())
            }),
        },
        "save",
      ),
    )

    const Child = Effect.fn("FailingSave")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        {},
        slot as AtomRef.AtomRef<Effect.Effect<unknown, never, never>>,
      )
    })
    const App = Effect.fn("Bounded")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (_cause) =>
        h("p", { class: "fallback" }, "save failed"),
      )
    })

    const ui = await render(App())
    ui.click(".save")
    await ui.tick()
    expect(ui.query(".busy")).not.toBeNull()

    openGate(gate)
    await ui.waitFor(".fallback")
    expect(ui.text(".fallback")).toBe("save failed")
    await ui.unmount()
  })

  it("the continuation after a self-triggered re-render still runs on the captured context (#72 × #161)", async () => {
    // Per-node context capture must extend past the re-render: the handler's
    // post-suspension half resolves Step on the context ambient where its
    // element was CONSTRUCTED — even though that element's build scope is
    // gone by then.
    const gate = Deferred.makeUnsafe<void>()
    const count = AtomRef.make(0)
    const slot = AtomRef.make<unknown>(null)
    const makeButton = () =>
      h(
        "button",
        {
          class: "save",
          onClick: () =>
            Effect.gen(function* () {
              slot.set(h("span", { class: "busy" }, "…"))
              yield* Deferred.await(gate)
              const step = yield* Step
              count.set(step.by)
            }),
        },
        "save",
      )

    const Provided = Effect.fn("ProvidedContinuation")(function* (
      _props: {} = {},
    ) {
      // Mid-tree provide: the slot's Reactive node captures the provided
      // context, so the button (evaluated by the node at render time)
      // constructs — and its handler runs — with Step, which the render root
      // never has.
      slot.set(makeButton())
      return yield* h(
        "div",
        {},
        Effect.provide(
          h(
            "div",
            {},
            slot as AtomRef.AtomRef<Effect.Effect<unknown, never, never>>,
          ),
          stepLayer(7),
        ),
        h("span", { class: "total" }, "total: ", count),
      )
    })

    const ui = await render(Provided())
    ui.click(".save")
    await ui.tick()
    openGate(gate)
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 7")
    await ui.unmount()
  })

  it("a FAILING handler still releases its per-dispatch finalizers (#160)", async () => {
    // The close rides the dispatch's exit — success and failure alike.
    const log: string[] = []
    const App = Effect.fn("FailRelease")(function* (_props: {} = {}) {
      return yield* h(
        "button",
        {
          class: "bad",
          onClick: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push("acquire")),
                () => Effect.sync(() => log.push("release")),
              )
              return yield* Effect.fail("boom")
            }),
        },
        "fail",
      )
    })

    // `untracked`: the typed failing handler has no boundary — the sanctioned
    // hatch for sink-containment shapes.
    const ui = await render(untracked(App()))
    ui.click(".bad")
    await ui.tick()
    expect(log).toEqual(["acquire", "release"])
    await ui.unmount()
    expect(log).toEqual(["acquire", "release"])
  })

  it("rapid re-dispatches get independent scopes (#160)", async () => {
    // Two in-flight dispatches of the SAME handler: each parks on its own
    // gate; settling one releases only its own finalizer.
    const log: string[] = []
    const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
    let n = 0
    const App = Effect.fn("Rapid")(function* (_props: {} = {}) {
      return yield* h(
        "button",
        {
          class: "btn",
          onClick: () => {
            const i = n++
            return Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push(`acquire${i}`)),
                () => Effect.sync(() => log.push(`release${i}`)),
              )
              yield* Deferred.await(gates[i]!)
            })
          },
        },
        "go",
      )
    })

    const ui = await render(App())
    ui.click(".btn")
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["acquire0", "acquire1"])

    // Settle the SECOND dispatch first — only its scope closes.
    openGate(gates[1]!)
    await ui.tick()
    expect(log).toEqual(["acquire0", "acquire1", "release1"])

    openGate(gates[0]!)
    await ui.tick()
    expect(log).toEqual(["acquire0", "acquire1", "release1", "release0"])
    await ui.unmount()
  })

  it("app unmount interrupts an in-flight handler and releases exactly once — visibly (#186)", async () => {
    // Also pins the interrupt routing: a teardown interrupt is NOT an error,
    // but it DOES reach the sink as an interrupt-only cause, so a test (or a
    // dev-mode log) can see the handler never completed.
    const log: string[] = []
    const gate = Deferred.makeUnsafe<void>()
    const App = Effect.fn("UnmountInterrupt")(function* (_props: {} = {}) {
      return yield* h(
        "button",
        {
          class: "btn",
          onClick: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push("acquire")),
                () => Effect.sync(() => log.push("release")),
              )
              yield* Deferred.await(gate)
              log.push("done") // must never run
            }),
        },
        "go",
      )
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["acquire"])

    await ui.unmount()
    expect(log).toEqual(["acquire", "release"])

    // A late gate open must be a no-op — the fiber is gone.
    openGate(gate)
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual(["acquire", "release"])
    expect(ui.sinkCauses).toHaveLength(1)
    expect(Cause.hasInterruptsOnly(ui.sinkCauses[0]!)).toBe(true)
  })

  it("a handler that interrupts ITSELF still releases, and the interrupt is visible (#160, #186)", async () => {
    // Pins two things the owner-teardown tests can't (there the owner→child
    // cascade would close the dispatch scope anyway): (1) the dispatch-scope
    // close (`Scope.use`, onExit-based) runs on an INTERRUPT exit too — the
    // owner stays alive here, so nothing else could fire the release; (2) the
    // interrupt-only cause reaches the sink AS an interrupt, not an error.
    const log: string[] = []
    const App = Effect.fn("SelfInterrupt")(function* (_props: {} = {}) {
      return yield* h(
        "button",
        {
          class: "btn",
          onClick: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push("acquire")),
                () => Effect.sync(() => log.push("release")),
              )
              yield* Effect.interrupt
              log.push("unreachable")
            }),
        },
        "go",
      )
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["acquire", "release"])
    expect(ui.sinkCauses).toHaveLength(1)
    expect(Cause.hasInterruptsOnly(ui.sinkCauses[0]!)).toBe(true)
    await ui.unmount()
    expect(log).toEqual(["acquire", "release"])
  })

  it("a handler interrupted under a Catch still reaches the root sink (#186)", async () => {
    // Catch.report must not swallow the interrupt: it is not an error (the
    // boundary must not flip), but "the handler never finished" has to stay
    // observable through a boundary — else `sinkCauses` lies for any app
    // with a root Catch.
    const gate = Deferred.makeUnsafe<void>()
    const log: string[] = []
    const App = Effect.fn("CatchInterrupt")(function* (_props: {} = {}) {
      return yield* Catch(
        h(
          "button",
          {
            class: "btn",
            onClick: () =>
              Effect.gen(function* () {
                log.push("start")
                yield* Deferred.await(gate)
                log.push("done")
              }),
          },
          "go",
        ),
        () => h("p", { class: "fallback" }, "failed"),
      )
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["start"])
    expect(ui.sinkCauses).toEqual([])

    await ui.unmount()
    expect(log).toEqual(["start"])
    expect(ui.sinkCauses).toHaveLength(1)
    expect(Cause.hasInterruptsOnly(ui.sinkCauses[0]!)).toBe(true)
    // The boundary did not flip on the interrupt.
    expect(ui.query(".fallback")).toBeNull()
  })

  it("re-binding a REACTIVE handler prop does not interrupt an in-flight dispatch", async () => {
    // An AtomRef-valued `onClick` re-applies under a rolling child scope: the
    // LISTENER is swapped per binding, but a dispatch is owned by the node,
    // not the binding — so a handler already in flight when the prop re-binds
    // runs to completion, while new clicks go to the new handler. (Pre-#161
    // the re-bind interrupted it.)
    const gate = Deferred.makeUnsafe<void>()
    const log: string[] = []
    const first = () =>
      Effect.gen(function* () {
        log.push("first:start")
        yield* Deferred.await(gate)
        log.push("first:done")
      })
    const second = () => Effect.sync(() => log.push("second"))
    const handler = AtomRef.make<() => Effect.Effect<void>>(first)

    const App = Effect.fn("Rebind")(function* (_props: {} = {}) {
      return yield* h("button", { class: "btn", onClick: handler }, "go")
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["first:start"])

    handler.set(second)
    await ui.tick()
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["first:start", "second"])

    openGate(gate)
    await ui.tick()
    expect(log).toEqual(["first:start", "second", "first:done"])
    await ui.unmount()
  })

  it("the handler's Scope is DISPATCH-lifetime: forkScoped work dies at settle; forkIn a captured scope survives", async () => {
    // Corollary of per-dispatch scopes: `Effect.forkScoped` (and an
    // `asyncRef`/`streamRef` created inside a handler — same mechanism) attach
    // to the dispatch scope and are torn down the moment the handler returns.
    // Work that must outlive the click forks INTO a scope captured at
    // construction. Documented in runtime/AGENTS.md "Handler-scope semantics".
    let scopedTicks = 0
    let capturedTicks = 0
    const App = Effect.fn("PollOnClick")(function* (_props: {} = {}) {
      const s = yield* Effect.scope // construction-time capture
      const poll = (bump: () => void) =>
        Effect.forever(Effect.delay(Effect.sync(bump), 1))
      return yield* h(
        "div",
        {},
        h(
          "button",
          {
            class: "scoped",
            onClick: () => Effect.forkScoped(poll(() => scopedTicks++)),
          },
          "poll (dispatch scope)",
        ),
        h(
          "button",
          {
            class: "captured",
            onClick: () =>
              Effect.forkIn(
                poll(() => capturedTicks++),
                s,
              ),
          },
          "poll (captured scope)",
        ),
      )
    })

    const ui = await render(App())
    ui.click(".scoped")
    ui.click(".captured")
    await new Promise((r) => setTimeout(r, 30))
    expect(scopedTicks).toBe(0) // dispatch settled → scope closed → poll dead
    expect(capturedTicks).toBeGreaterThan(0)

    await ui.unmount()
    const atUnmount = capturedTicks
    await new Promise((r) => setTimeout(r, 30))
    expect(capturedTicks).toBe(atUnmount) // captured scope died with the app
  })

  it("a row handler survives a REORDER but is interrupted by row REMOVAL", async () => {
    // rowScope is the owner: `move` ops only reparent DOM (the scope lives
    // on), `remove` closes it — so an in-flight row handler survives
    // reordering and dies with its row.
    const log: string[] = []
    const gate = Deferred.makeUnsafe<void>()
    const coll = AtomRef.collection<string>(["a"])
    const refA = coll.value[0]!

    const App = Effect.fn("Rows")(function* (_props: {} = {}) {
      return yield* h(
        "ul",
        {},
        For({
          each: coll,
          children: [
            (item) =>
              h(
                "li",
                {},
                h(
                  "button",
                  {
                    class: "row-btn",
                    onClick: () =>
                      Effect.gen(function* () {
                        yield* Effect.acquireRelease(
                          Effect.sync(() => log.push("acquire")),
                          () => Effect.sync(() => log.push("release")),
                        )
                        yield* Deferred.await(gate)
                        log.push("done") // must never run
                      }),
                  },
                  item,
                ),
              ),
          ],
        }),
      )
    })

    const ui = await render(App())
    ui.click(".row-btn")
    await ui.tick()
    expect(log).toEqual(["acquire"])

    // Insert before row "a" — "a" gets a move op; its scope must survive.
    coll.insertAt(0, "b")
    await ui.tick()
    expect(ui.all(".row-btn").length).toBe(2)
    expect(log).toEqual(["acquire"])

    // Remove row "a" — its rowScope closes, interrupting the handler.
    coll.remove(refA)
    await ui.tick()
    expect(log).toEqual(["acquire", "release"])
    await ui.unmount()
    expect(log).toEqual(["acquire", "release"])
  })

  it("a boundary flip interrupts prior-generation handlers — no stale failure after reset", async () => {
    // Boundary content is owned by the per-FLIP content scope. A handler
    // dispatched from generation-1 content and still in flight when the
    // boundary errors is interrupted by the flip — so after a reset it cannot
    // write into (or fail into) the new generation. Without per-flip
    // ownership, the parked handler would survive the flip and its late
    // failure would re-flip the freshly reset boundary.
    class BoomError extends Data.TaggedError("BoomError") {}
    const log: string[] = []
    const gate = Deferred.makeUnsafe<void>()
    const done = AtomRef.make("no")

    const Child = Effect.fn("BoundaryContent")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        {},
        h(
          "button",
          {
            class: "work",
            onClick: () =>
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  Effect.sync(() => log.push("acquire")),
                  () => Effect.sync(() => log.push("release")),
                )
                yield* Deferred.await(gate)
                done.set("stale") // must never run
              }),
          },
          "work",
        ),
        h(
          "button",
          { class: "boom", onClick: () => Effect.fail(new BoomError()) },
          "boom",
        ),
      )
    })
    const App = Effect.fn("ResetBoundary")(function* (_props: {} = {}) {
      return yield* Catch(Child(), (_cause, reset) =>
        h("button", { class: "retry", onClick: reset }, "retry"),
      )
    })

    const ui = await render(App())
    ui.click(".work")
    await ui.tick()
    expect(log).toEqual(["acquire"])

    // Error the boundary: the flip closes the content scope — the parked
    // work handler is interrupted and releases.
    ui.click(".boom")
    await ui.waitFor(".retry")
    expect(log).toEqual(["acquire", "release"])

    // Reset back to ok content, then open the gate: the old handler is gone,
    // nothing stale lands.
    ui.click(".retry")
    await ui.waitFor(".work")
    openGate(gate)
    await ui.tick()
    expect(done.value).toBe("no")
    expect(ui.query(".work")).not.toBeNull()
    await ui.unmount()
  })
})
