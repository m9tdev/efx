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
})
