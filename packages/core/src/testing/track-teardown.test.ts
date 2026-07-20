// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "@verrex/core/testing"

// Regression: a reactive expression compiles to `h.track(() => …)`, which
// returns a demand-driven derived Atom over whatever refs the thunk reads.
// When the mounting subtree tears down, the registry must drop the derived
// and its ref bridges — otherwise the thunk keeps re-running (and the
// derived stays retained) for the life of the underlying ref, every time
// it changes.

describe("h.track subscription teardown", () => {
  it("stops re-running the tracked thunk after the subtree unmounts", async () => {
    const dep = AtomRef.make(0)
    let runs = 0

    // <div>{ String(dep.value) }</div>, hand-compiled. `h()` already returns
    // an Effect<View>, which is exactly what `render` takes.
    const app = h(
      "div",
      {},
      h.track(() => {
        runs++
        return String(h.read(dep))
      }),
    )

    const ui = await render(app)
    // Run-count invariant (runtime/AGENTS.md): exactly two runs before first
    // paint — the creation-time classification run (result discarded) and the
    // first registry read. A change to this count must be deliberate.
    expect(runs).toBe(2)
    const afterMount = runs

    // Live update while mounted: the thunk re-runs.
    dep.set(1)
    expect(runs).toBe(afterMount + 1)

    await ui.unmount()
    const afterUnmount = runs

    // After teardown, changing the underlying ref must NOT re-run the thunk.
    dep.set(2)
    dep.set(3)
    expect(runs).toBe(afterUnmount)
  })

  it("stops re-running an inner thunk when a reactive rebuild drops its subtree", async () => {
    // Subtree CHURN (not full unmount): an outer tracked ternary whose "on"
    // branch contains its own tracked expression. Flipping the outer off
    // closes the old subtree's scope; the inner derived loses its last
    // subscriber and the registry reaps it — asynchronously (orphan removal
    // is scheduled), hence the tick before asserting.
    const cond = AtomRef.make(true)
    const inner = AtomRef.make(0)
    let innerRuns = 0

    const app = h(
      "div",
      {},
      h.track(() =>
        h.read(cond)
          ? h(
              "span",
              {},
              h.track(() => {
                innerRuns++
                return String(h.read(inner))
              }),
            )
          : "off",
      ),
    )

    const ui = await render(app)
    inner.set(1)
    const whileMounted = innerRuns
    expect(whileMounted).toBeGreaterThan(0)

    cond.set(false) // rebuild: the span subtree (and its derived) is dropped
    await ui.tick() // scheduled orphan removal runs

    inner.set(2)
    inner.set(3)
    expect(innerRuns).toBe(whileMounted)

    await ui.unmount()
  })

  it("drops the unused ref's bridge when one derived switches dep branches", async () => {
    // Branch SWITCH within a single derived (no subtree churn): the same
    // tracked ternary reads refA on one branch and refB on the other. After
    // flipping to the refB branch, refA's bridge must fall out of the
    // derived's dep set — the PR's "dep switching drops the unused bridge"
    // claim, which otherwise rests only on effect's registry semantics.
    // Observable purely by run counts: a write to the dropped ref must not
    // re-run the thunk; a write to the live one must. Orphaned-bridge
    // disposal is scheduled, hence the tick after the switch.
    const cond = AtomRef.make(true)
    const refA = AtomRef.make("a0")
    const refB = AtomRef.make("b0")
    let runs = 0

    const app = h(
      "div",
      {},
      h.track(() => {
        runs++
        return h.read(cond) ? h.read(refA) : h.read(refB)
      }),
    )

    const ui = await render(app)
    expect(ui.text("div")).toBe("a0")

    // While on the refA branch: refA re-runs, refB is not a dep.
    const before = runs
    refA.set("a1")
    expect(runs).toBe(before + 1)
    refB.set("b1")
    expect(runs).toBe(before + 1)
    expect(ui.text("div")).toBe("a1")

    cond.set(false) // switch branches: the recompute reads refB, not refA
    await ui.tick() // scheduled orphan removal drops refA's bridge
    expect(ui.text("div")).toBe("b1")

    const afterSwitch = runs
    refA.set("a2") // dropped dep: must NOT re-run the thunk
    expect(runs).toBe(afterSwitch)
    refB.set("b2") // live dep: must re-run and re-render
    expect(runs).toBe(afterSwitch + 1)
    expect(ui.text("div")).toBe("b2")

    await ui.unmount()
  })
})
