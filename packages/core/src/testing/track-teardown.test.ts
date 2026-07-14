// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "@verrex/core/testing"

// Regression: a reactive expression compiles to `h.track(() => …)`, which
// returns a derived AtomRef subscribed to whatever refs the thunk reads. When
// the mounting subtree tears down, those derived→underlying-ref subscriptions
// must be disposed too — not just the mount→derived one. Otherwise the thunk
// keeps re-running (and the derived stays retained) for the life of the
// underlying ref, every time it changes.

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
})
