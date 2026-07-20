// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Catch, h, list } from "@verrex/core"
import { Step, stepClick, stepLayer } from "./fixtures.ts"
import { render } from "./index.ts"

// THE runtime pins for per-NODE context capture (#72, runtime/AGENTS.md
// "Per-NODE context capture"): every path that runs user code after
// construction — handlers, reactive rebuilds, list rows, Catch fallbacks —
// must run it on the context that was ambient where the node was
// CONSTRUCTED, or a mid-tree Effect.provide becomes a type-level lie (the
// fold discharges R that the runtime then can't resolve). One test per
// capture-consuming path in the variant matrix, plus the handler-scope
// lifetime pin.

// Shared rows fixture: identical UI for the two list tests — they differ
// ONLY in where the Step layer is applied (mid-tree provide vs render root).
const makeRows = (
  coll: AtomRef.Collection<string>,
  count: AtomRef.AtomRef<number>,
) =>
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
      }),
    ),
    h("span", { class: "total" }, "total: ", count),
  )

describe("per-node context capture", () => {
  it("a mid-tree Effect.provide reaches a static element's handler", async () => {
    // FoldPropsR puts the handler's R on the construction Effect, which
    // Effect.provide discharges mid-tree. The runtime must agree: h()
    // captures the ambient context at construction and runHandlerEffect runs
    // on it — NOT on the root context, which never saw this Layer. render()
    // is called WITHOUT the layer (the type allows it: R = never after the
    // provide).
    const Provided = Effect.fn("Provided")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      const btn = h(
        "button",
        { class: "btn", onClick: stepClick(count) },
        "count: ",
        count,
      )
      return yield* h("div", {}, Effect.provide(btn, stepLayer(7)))
    })

    const ui = await render(Provided())
    ui.click(".btn")
    await ui.tick()
    expect(ui.text(".btn")).toBe("count: 7")
    await ui.unmount()
  })

  it("a mid-tree Effect.provide reaches LIST ROWS — construction and handler", async () => {
    // list() captures its construction context (ViewList.context) and every
    // row builds on it — without the capture, rows materialize at reconcile
    // time on mount's ROOT context and this whole test type-checks but dies
    // at runtime (the round-2 review hole).
    const coll = AtomRef.collection<string>(["a"])
    const Provided = Effect.fn("ProvidedRows")(function* (_props: {} = {}) {
      const count = AtomRef.make(0)
      return yield* h(
        "div",
        {},
        Effect.provide(makeRows(coll, count), stepLayer(3)),
      )
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
    ui.all(".row-btn")[1]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    )
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 6")
    await ui.unmount()
  })

  it("list rows see a ROOT-provided layer too (the fallback half of the contract)", async () => {
    // Same fixture; the Step layer comes from render's root. (The post-mount
    // insert path is pinned by the mid-tree test above — the insert code
    // path is identical regardless of which context the node captured.)
    const coll = AtomRef.collection<string>(["a"])
    const count = AtomRef.make(0)
    const Rows = () =>
      Effect.gen(function* () {
        return yield* makeRows(coll, count)
      })

    const ui = await render(Rows(), stepLayer(5))
    ui.click(".row-btn")
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 5")

    // A row inserted post-mount resolves its construction `yield* Step` and
    // handler against the ROOT-provided context too (not only mid-tree).
    coll.push("b")
    await ui.tick()
    ui.all(".row-btn")[1]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    )
    await ui.tick()
    expect(ui.text(".total")).toBe("total: 10")
    await ui.unmount()
  })

  it("a mid-tree Effect.provide reaches reactive REBUILDS", async () => {
    // The Reactive node captures its construction context, so a subtree
    // swapped in long after mount still builds (and captures for its
    // handlers) the mid-tree-provided context — not just the first paint.
    const count = AtomRef.make(0)
    const makeBtn = () =>
      h("button", { class: "btn", onClick: stepClick(count) }, "go")
    const slot = AtomRef.make<unknown>(makeBtn())

    const Provided = Effect.fn("ProvidedReactive")(function* (_props: {} = {}) {
      return yield* h(
        "div",
        {},
        Effect.provide(
          h(
            "section",
            {},
            slot as AtomRef.AtomRef<Effect.Effect<unknown, never, Step>>,
          ),
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

  it("a mid-tree Effect.provide reaches CATCH FALLBACKS", async () => {
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
        h("button", { class: "retry", onClick: stepClick(count) }, "retry"),
      )
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

  it("a handler's acquireRelease releases when a DYNAMIC node is removed", async () => {
    // runHandlerEffect provides the enclosing build scope INTO the handler
    // effect (mirroring coerceSync). Here the button lives in an AtomRef slot
    // — a Reactive node, which forks a scope of its OWN — so the release binds
    // to that node's lifetime. Note this is the dynamic case; the static case
    // below has no per-element scope and behaves differently.
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
      return yield* h(
        "div",
        {},
        slot as AtomRef.AtomRef<Effect.Effect<unknown, never, never>>,
      )
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

  it("a STATIC element's handler finalizers ride the enclosing scope (#160)", async () => {
    // The counterpart to the test above, and the case it structurally cannot
    // reach: a static element forks NO scope of its own, so the handler's
    // finalizers register on the scope the element was BUILT in — here the
    // mount root. They therefore accumulate per dispatch and release only at
    // app teardown, NOT per click.
    //
    // This pins CURRENT behavior, not desired behavior: it is why FoldPropsR's
    // Scope exclusion is sound-but-lifetime-surprising. #160 tracks giving each
    // dispatch its own scope; when that lands, this test flips to expecting a
    // release per click and the comments in mount.ts/Fold.ts move with it.
    const log: string[] = []
    const App = Effect.fn("StaticScopedHandler")(function* (_props: {} = {}) {
      return yield* h(
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
    })

    const ui = await render(App())
    ui.click(".btn")
    await ui.tick()
    ui.click(".btn")
    await ui.tick()
    // Two acquisitions, ZERO releases — nothing has torn down yet.
    expect(log).toEqual(["acquire", "acquire"])

    // Only app teardown closes the scope they registered against.
    await ui.unmount()
    expect(log).toEqual(["acquire", "acquire", "release", "release"])
  })
})
