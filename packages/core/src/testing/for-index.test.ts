// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { For, h } from "@verrex/core"
import { render } from "./index.ts"

// Each row renders "<index>: <value>". `index` is the reactive ReadonlyRef the
// list hands the render fn; `item` is the row's value ref. Built with raw h()
// (no .vx compiler): both refs coerce to reactive text nodes.
const IndexedList = (coll: AtomRef.Collection<string>) =>
  Effect.gen(function* () {
    return yield* h(
      "ul",
      {},
      For({
        each: coll,
        children: [
          (item, index) => h("li", { class: "row" }, index, ": ", item),
        ],
      }),
    )
  })

describe("For reactive index", () => {
  it("updates shifted rows' indices on removal without rebuilding their DOM", async () => {
    const coll = AtomRef.collection<string>(["a", "b", "c"])
    const ui = await render(IndexedList(coll))

    expect(ui.all(".row").map((r) => r.textContent)).toEqual([
      "0: a",
      "1: b",
      "2: c",
    ])

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

  it("survives an empty → full → empty → full cycle", async () => {
    const coll = AtomRef.collection<string>(["a", "b"])
    const ui = await render(IndexedList(coll))
    expect(ui.all(".row").map((r) => r.textContent)).toEqual(["0: a", "1: b"])

    // Empty it — every row removed, `rendered`/`snapshot` reset.
    for (const ref of [...coll.value]) coll.remove(ref)
    await ui.tick()
    expect(ui.all(".row")).toEqual([])

    // Refill — fresh inserts off an empty snapshot, like an initial mount.
    coll.push("c")
    coll.push("d")
    await ui.tick()
    expect(ui.all(".row").map((r) => r.textContent)).toEqual(["0: c", "1: d"])
    await ui.unmount()
  })
})

describe("For row lifecycle", () => {
  // A row whose render returns an Effect with acquireRelease — the release
  // registers on the row's own scope (via coerceSync providing it), so it must
  // fire when THAT row is removed, not only on full unmount. The refactor moved
  // this teardown into the `remove` op + closeScope, so pin it here.
  const TrackedList = (coll: AtomRef.Collection<string>, log: string[]) =>
    Effect.gen(function* () {
      return yield* h(
        "ul",
        {},
        For({
          each: coll,
          children: [
            (item) =>
              Effect.gen(function* () {
                const id = item.value
                yield* Effect.acquireRelease(
                  Effect.sync(() => log.push(`acquire:${id}`)),
                  () => Effect.sync(() => log.push(`release:${id}`)),
                )
                return yield* h("li", { class: "row" }, id)
              }),
          ],
        }),
      )
    })

  it("fires a row's acquireRelease release when only that row is removed", async () => {
    const log: string[] = []
    const coll = AtomRef.collection<string>(["a", "b", "c"])
    const ui = await render(TrackedList(coll, log))
    expect(log).toEqual(["acquire:a", "acquire:b", "acquire:c"])

    // Remove just "b": its release fires; a and c stay live.
    coll.remove(coll.value[1]!)
    await ui.tick()
    expect(log).toEqual(["acquire:a", "acquire:b", "acquire:c", "release:b"])
    expect(ui.all(".row").map((r) => r.textContent)).toEqual(["a", "c"])

    // Unmount: the surviving rows' releases fire via the parent-fork cascade.
    await ui.unmount()
    expect(log.slice(3).sort()).toEqual(["release:a", "release:b", "release:c"])
  })
})
