// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { h, list } from "@verrex/core"
import { render } from "./index.ts"

// Each row renders "<index>: <value>". `index` is the reactive ReadonlyRef the
// list hands the render fn; `item` is the row's value ref. Built with raw h()
// (no .vx compiler): both refs coerce to reactive text nodes.
const IndexedList = (coll: AtomRef.Collection<string>) =>
  Effect.gen(function* () {
    return yield* h(
      "ul",
      {},
      list(coll, (item, index) => h("li", { class: "row" }, index, ": ", item)),
    )
  })

describe("list() reactive index", () => {
  it("updates shifted rows' indices on removal without rebuilding their DOM", async () => {
    const coll = AtomRef.collection<string>(["a", "b", "c"])
    const ui = await render(IndexedList(coll))

    expect(ui.all(".row").map((r) => r.textContent)).toEqual(["0: a", "1: b", "2: c"])

    // Capture the b and c row nodes so we can prove they aren't rebuilt.
    const [, bNode, cNode] = ui.all(".row")

    // Remove the head. b and c don't move, but their indices shift 1→0, 2→1.
    coll.remove(coll.value[0]!)
    await ui.tick()

    const rows = ui.all(".row")
    expect(rows.map((r) => r.textContent)).toEqual(["0: b", "1: c"])
    // Same DOM objects — shifted, not re-rendered.
    expect(rows[0]).toBe(bNode)
    expect(rows[1]).toBe(cNode)
  })

  it("renumbers following rows when a row is inserted in the middle", async () => {
    const coll = AtomRef.collection<string>(["a", "b", "c"])
    const ui = await render(IndexedList(coll))

    coll.insertAt(1, "x")
    await ui.tick()

    expect(ui.all(".row").map((r) => r.textContent)).toEqual([
      "0: a",
      "1: x",
      "2: b",
      "3: c",
    ])
    await ui.unmount()
  })
})
