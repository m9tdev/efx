// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Context, Effect, Layer, Logger } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Catch, h, list } from "@verrex/core"
import { render, untracked } from "./index.ts"

// One Step service for every context test below — each test builds its own
// Layer with the increment it expects (the fixtures.ts factory pattern; a
// fresh tag per test buys nothing since each render gets an isolated context).
class Step extends Context.Service<Step, { readonly by: number }>()("test/Step") {}
const stepLayer = (by: number) => Layer.succeed(Step, { by })
const stepClick = (count: AtomRef.AtomRef<number>) => () =>
  Effect.gen(function* () {
    const step = yield* Step
    count.set(count.value + step.by)
  })

// Shared rows fixture for the two list-context tests below: identical UI —
// the tests differ ONLY in where the Step layer is applied (mid-tree
// Effect.provide vs render's root layer).
const makeRows = (coll: AtomRef.Collection<string>, count: AtomRef.AtomRef<number>) =>
  h(
    "ul",
    {},
    list(coll, (item) =>
      Effect.gen(function* () {
        yield* Step // construction-time read — must resolve in rows
        return yield* h(
          "li",
          {},
          h("button", { class: "row-btn", onClick: stepClick(count) }, item),
        )
      })),
    h("span", { class: "total" }, "total: ", count),
  )

// PR1 fix: an event handler that returns an Effect used to be added as a raw DOM
// listener and the returned Effect was DROPPED unexecuted. Now applyProp detects
// an Effect return and forks it on the mount's captured context, routing failures
// to the error sink. These tests pin: it runs, it sees the app's services, plain
// imperative handlers still work, and a failing handler is contained (not thrown
// out of the DOM dispatch). The reactive-render sink routing is unit-tested in
// runtime/coerce.test.ts; both paths share the same sink + interrupt guard.

describe("event handlers — Effect-returning", () => {
  it("runs the returned Effect (counter increments on click)", async () => {
    const Clicker = Effect.fn("Clicker")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: () => Effect.sync(() => count.set(count.value + 1)) },
        "count: ",
        count,
      )
    })

    const ui = await render(Clicker())
    expect(ui.text(".btn")).toBe("count: 0")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 1")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 2")
    await ui.unmount()
  })

  it("runs on the captured context — handler Effect can yield* a service", async () => {
    const ServiceClicker = Effect.fn("ServiceClicker")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: stepClick(count) },
        "count: ",
        count,
      )
    })

    // If the handler ran on the default runtime (no captured context), `yield* Step`
    // would fail and the count would never move — so this asserts context capture.
    const ui = await render(ServiceClicker(), stepLayer(10))
    expect(ui.text(".btn")).toBe("count: 0")

    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 10")
    await ui.unmount()
  })

  it("still runs plain (non-Effect) imperative handlers", async () => {
    const Imperative = Effect.fn("Imperative")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "button",
        { class: "btn", onClick: () => { count.set(count.value + 1) } },
        "count: ",
        count,
      )
    })

    const ui = await render(Imperative())
    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 1")
    await ui.unmount()
  })

  it("honors a mid-tree Effect.provide — the handler runs on the element's construction context", async () => {
    // FoldPropsR puts the handler's R on the construction Effect, which
    // Effect.provide discharges mid-tree. The runtime must agree: h() captures
    // the ambient context at construction and runHandlerEffect runs on it —
    // NOT on the root context, which never saw this Layer. render() is called
    // WITHOUT the layer (the type allows it: R = never after the provide).
    const Provided = Effect.fn("Provided")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      const btn = h("button", { class: "btn", onClick: stepClick(count) }, "count: ", count)
      return yield* h("div", {}, Effect.provide(btn, stepLayer(7)))
    })

    const ui = await render(Provided())
    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 7")
    await ui.unmount()
  })

  it("a mid-tree Effect.provide reaches LIST ROWS — construction and handler (#110 round 2)", async () => {
    // list() captures its construction context (ViewList.context) and every
    // row builds on it — without the capture, rows materialize at reconcile
    // time on mount's ROOT context and this whole test type-checks but dies
    // at runtime (the hole the round-2 review found).
    const coll = AtomRef.collection<string>(["a"])
    const Provided = Effect.fn("ProvidedRows")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h("div", {}, Effect.provide(makeRows(coll, count), stepLayer(3)))
    })

    const ui = await render(Provided())
    expect(ui.all(".row-btn").length).toBe(1) // construction yield* Step resolved
    ui.click(".row-btn")
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 3")

    // A row inserted AFTER mount builds on the same captured context.
    coll.push("b")
    await ui.tick()
    expect(ui.all(".row-btn").length).toBe(2)
    ui.all(".row-btn")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 6")
    await ui.unmount()
  })

  it("a mid-tree Effect.provide reaches reactive REBUILDS (#110 round 2)", async () => {
    // The Reactive node captures its construction context, so a subtree swapped
    // in long after mount still builds (and captures for its handlers) the
    // mid-tree-provided context — not just the first paint.
    const count = AtomRef.make(0)
    const makeBtn = () => h("button", { class: "btn", onClick: stepClick(count) }, "go")
    const slot = AtomRef.make<unknown>(makeBtn())

    const Provided = Effect.fn("ProvidedReactive")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        {},
        Effect.provide(
          h("section", {}, slot as AtomRef.AtomRef<Effect.Effect<unknown, never, Step>>),
          stepLayer(4),
        ),
        h("span", { class: "total" }, "total: ", count),
      )
    })

    const ui = await render(Provided())
    // REBUILD the slot post-mount, then click the rebuilt button.
    slot.set(makeBtn())
    await ui.tick()
    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 4")
    await ui.unmount()
  })

  it("a mid-tree Effect.provide reaches CATCH FALLBACKS (#110 round 3)", async () => {
    // The boundary captures its construction context (ViewBoundary.context)
    // and the fallback builds on it — without the capture, the fallback's
    // handler ran on mount's root context and died with ServiceNotFound,
    // while the same handler in the ok content (or an Async arm) worked.
    const count = AtomRef.make(0)
    const Failing = Effect.fn("Failing")(function* (_props: {} = {}) {
      return yield* Effect.fail(new Error("construction boom"))
    })

    const Provided = Effect.fn("ProvidedFallback")(function* (_props: {} = {}) {
      const guarded = Catch(Failing(), (_cause, _reset) =>
        h("button", { class: "retry", onClick: stepClick(count) }, "retry"))
      return yield* h(
        "div",
        {},
        Effect.provide(guarded, stepLayer(9)),
        h("span", { class: "total" }, "total: ", count),
      )
    })

    const ui = await render(Provided())
    await ui.tick() // boundary renders the fallback
    ui.click(".retry")
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 9")
    await ui.unmount()
  })

  it("a handler's acquireRelease releases when the element is removed (#110 round 2)", async () => {
    // runHandlerEffect provides the element's DOM scope INTO the handler
    // effect (mirroring coerceSync), so Effect.addFinalizer/acquireRelease
    // bind to the element's lifetime — not the app's.
    const log: string[] = []
    const makeView = (on: boolean) =>
      on
        ? h(
          "button",
          {
            class: "btn",
            onClick: () =>
              Effect.acquireRelease(
                Effect.sync(() => log.push("acquire")),
                () => Effect.sync(() => log.push("release")),
              ),
          },
          "go",
        )
        : h("p", {}, "gone")
    const slot = AtomRef.make<unknown>(makeView(true))

    const App = Effect.fn("ScopedHandler")(function* (_props: {} = {}) {
      return yield* h("div", {}, slot as AtomRef.AtomRef<Effect.Effect<unknown, never, never>>)
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    expect(log).toEqual(["acquire"])

    // Swap the button away — its render scope closes, the release must fire.
    slot.set(makeView(false))
    await ui.tick()
    expect(log).toEqual(["acquire", "release"])
    await ui.unmount()
  })

  it("list rows see the app context — a row handler's service resolves (construction too)", async () => {
    // Same fixture as the mid-tree test above; here the Step layer comes from
    // render's ROOT instead — the capture must be equivalent in both homes.
    const coll = AtomRef.collection<string>(["a"])
    const count = AtomRef.make(0)
    const Rows = () => Effect.gen(function* () {
      return yield* makeRows(coll, count)
    })

    const ui = await render(Rows(), stepLayer(5))
    ui.click(".row-btn")
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 5")

    // A row inserted AFTER mount builds through the same context-threaded path.
    coll.push("b")
    await ui.tick()
    ui.all(".row-btn")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 10")
    await ui.unmount()
  })

  it("contains a failing handler — routed to the sink, app keeps working", async () => {
    // Capture the routed failure via a custom logger (the root sink logs the
    // Cause through Effect.logError on the captured context).
    const logged: Array<unknown> = []
    const CapturingLogger = Logger.layer([
      Logger.make((options) => {
        logged.push(options)
      }),
    ])

    const Mixed = Effect.fn("Mixed")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      // The handler is typed HONESTLY (it fails with a string, so this
      // component stamps View<string>); `untracked` below is the harness's
      // sanctioned hatch for mounting it — since #72 a typed failing handler
      // can't reach `render`/`mount` otherwise (pinned in channels.test-d.ts).
      // The runtime containment must hold regardless of what the types track.
      return yield* h(
        "div",
        {},
        h(
          "button",
          { class: "bad", onClick: () => Effect.fail("boom-marker") },
          "fail",
        ),
        h(
          "button",
          { class: "good", onClick: () => Effect.sync(() => count.set(count.value + 1)) },
          "ok: ",
          count,
        ),
      )
    })

    const ui = await render(untracked(Mixed()), CapturingLogger)

    // A failing handler must not throw out of dispatch nor break the app, and the
    // ACTUAL cause must reach the sink (not just "something logged"). The sink logs
    // the Cause via Effect.logError, so it surfaces in the logger options' message
    // and/or cause field.
    ui.click(".bad")
    await ui.tick()
    const mentionsMarker = (v: unknown): boolean =>
      Cause.isCause(v)
        ? Cause.pretty(v).includes("boom-marker")
        : typeof v === "string"
          ? v.includes("boom-marker")
          : Array.isArray(v)
            ? v.some(mentionsMarker)
            : false
    const found = logged.some((o) => {
      const opts = o as { readonly message?: unknown; readonly cause?: unknown }
      return mentionsMarker(opts.message) || mentionsMarker(opts.cause)
    })
    expect(found).toBe(true)

    // The app still works after a handler failure.
    ui.click(".good")
    await ui.tick()
    expect(ui.text(".good")).toBe("ok: 1")
    await ui.unmount()
  })
})
