import { describe, expect, it } from "vitest"
import { plan, type ReconcileOp } from "./reconcile.ts"

// Oracle: apply a plan to a plain array of keys the same way the DOM
// interpreter would (remove / insert-before / move-before / keep), so we can
// assert the plan actually produces `next` from `prev` — no DOM needed.
const applyToArray = <K>(
  prev: ReadonlyArray<K>,
  ops: ReadonlyArray<ReconcileOp<K>>,
): K[] => {
  const arr = [...prev]
  const drop = (k: K) => {
    const i = arr.indexOf(k)
    if (i !== -1) arr.splice(i, 1)
  }
  const insertBefore = (k: K, before: K | null) => {
    drop(k)
    if (before === null) arr.push(k)
    else arr.splice(arr.indexOf(before), 0, k)
  }
  for (const op of ops) {
    switch (op.op) {
      case "remove":
        drop(op.key)
        break
      case "insert":
      case "move":
        insertBefore(op.key, op.before)
        break
      case "keep":
        break
    }
  }
  return arr
}

// The DOM-affecting ops (everything except `keep`) are the mutations the
// interpreter performs. Project to them.
const domOps = <K>(ops: ReadonlyArray<ReconcileOp<K>>) =>
  ops.filter((o) => o.op !== "keep")

describe("plan() — produces `next` from `prev`", () => {
  const cases: ReadonlyArray<{ name: string; prev: string[]; next: string[] }> =
    [
      { name: "no-op", prev: ["a", "b", "c"], next: ["a", "b", "c"] },
      { name: "initial mount (empty → full)", prev: [], next: ["a", "b", "c"] },
      { name: "clear (full → empty)", prev: ["a", "b", "c"], next: [] },
      { name: "append", prev: ["a"], next: ["a", "b"] },
      { name: "prepend", prev: ["b", "c"], next: ["a", "b", "c"] },
      { name: "insert middle", prev: ["a", "b"], next: ["a", "c", "b"] },
      { name: "remove middle", prev: ["a", "b", "c"], next: ["a", "c"] },
      { name: "reverse", prev: ["a", "b", "c"], next: ["c", "b", "a"] },
      { name: "rotate left", prev: ["a", "b", "c"], next: ["b", "c", "a"] },
      {
        name: "move tail to head",
        prev: ["a", "b", "c", "d"],
        next: ["d", "a", "b", "c"],
      },
      {
        name: "swap ends",
        prev: ["a", "b", "c", "d"],
        next: ["d", "b", "c", "a"],
      },
      {
        name: "interleave new + reorder",
        prev: ["a", "b", "c"],
        next: ["x", "c", "a", "y", "b"],
      },
      { name: "full replace", prev: ["a", "b"], next: ["c", "d"] },
    ]

  for (const { name, prev, next } of cases) {
    it(name, () => {
      expect(applyToArray(prev, plan(prev, next))).toEqual(next)
    })
  }
})

describe("plan() — op shapes", () => {
  it("no-op emits only keeps, no DOM mutations", () => {
    const ops = plan(["a", "b", "c"], ["a", "b", "c"])
    expect(domOps(ops)).toEqual([])
    expect(ops).toEqual([
      { op: "keep", key: "a", index: 0 },
      { op: "keep", key: "b", index: 1 },
      { op: "keep", key: "c", index: 2 },
    ])
  })

  it("move tail to head is a single move", () => {
    const ops = plan(["a", "b", "c", "d"], ["d", "a", "b", "c"])
    expect(domOps(ops)).toEqual([
      { op: "move", key: "d", before: "a", index: 0 },
    ])
  })

  it("reverse is two moves before the settled tail", () => {
    const ops = plan(["a", "b", "c"], ["c", "b", "a"])
    expect(domOps(ops)).toEqual([
      { op: "move", key: "c", before: "a", index: 0 },
      { op: "move", key: "b", before: "a", index: 1 },
    ])
  })

  it("new rows are inserts; reused rows are moves/keeps", () => {
    const ops = plan(["a", "b"], ["a", "c", "b"])
    expect(ops).toEqual([
      { op: "keep", key: "a", index: 0 },
      { op: "insert", key: "c", before: "b", index: 1 },
      { op: "keep", key: "b", index: 2 },
    ])
  })

  it("removals come first, then placement", () => {
    const ops = plan(["a", "b", "c"], ["c", "a"])
    expect(ops[0]).toEqual({ op: "remove", key: "b" })
    expect(ops.slice(1).every((o) => o.op !== "remove")).toBe(true)
  })
})

describe("plan() — index updates", () => {
  it("a shifted-but-unmoved row gets a fresh index via keep", () => {
    // Remove the head: b and c don't move, but their indices change 1→0, 2→1.
    const ops = plan(["a", "b", "c"], ["b", "c"])
    expect(ops).toEqual([
      { op: "remove", key: "a" },
      { op: "keep", key: "b", index: 0 },
      { op: "keep", key: "c", index: 1 },
    ])
  })

  it("every retained row carries its next-order index", () => {
    const next = ["c", "a", "b"]
    const ops = plan(["a", "b", "c"], next)
    for (const op of ops) {
      if (op.op !== "remove") {
        expect(op.index).toBe(next.indexOf(op.key))
      }
    }
  })
})
