// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "@verrex/core/testing"

// Regression (found reviewing #153): moving `h.track` deriveds into the shared
// registry graph made a THROWING tracked thunk catastrophic. An exception
// escaping an `Atom` read aborts the registry's notify cascade mid-pass, so
// every other node depending on that ref misses the update — and the throwing
// node loses its dep subscriptions, so nothing ever wakes it again. One bad
// frame (`h.read(user)!.name` while `user` is briefly null) permanently froze
// the surrounding UI, silently, past every `Catch`.
//
// Before the registry move this was node-local and self-healing: the throw
// escaped `.set()` to its caller, the node kept its stale value, and the next
// change re-ran it. These pin that behaviour back.

describe("a tracked thunk that throws", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // The throw is reported, not swallowed — but it must not fail the test run.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  it("does not stop a sibling node on the same ref from updating", async () => {
    const dep = AtomRef.make(0)

    const app = h(
      "div",
      {},
      h(
        "span",
        { class: "bad" },
        h.track(() => {
          const v = h.read(dep)
          if (v === 1) throw new Error("boom")
          return `bad:${v}`
        }),
      ),
      h(
        "span",
        { class: "good" },
        h.track(() => `good:${h.read(dep)}`),
      ),
    )

    const ui = await render(app)
    expect(ui.text(".good")).toBe("good:0")

    dep.set(1) // the sibling throws during this propagation pass
    expect(ui.text(".good")).toBe("good:1") // …and this node still saw it

    dep.set(2)
    expect(ui.text(".good")).toBe("good:2")

    await ui.unmount()
  })

  it("keeps its last good value and recovers on the next change", async () => {
    const dep = AtomRef.make(0)
    const app = h(
      "div",
      { class: "solo" },
      h.track(() => {
        const v = h.read(dep)
        if (v === 1) throw new Error("boom")
        return `v:${v}`
      }),
    )

    const ui = await render(app)
    expect(ui.text(".solo")).toBe("v:0")

    dep.set(1) // throws
    expect(ui.text(".solo")).toBe("v:0") // holds the last good value

    dep.set(2) // still subscribed → re-runs → recovers
    expect(ui.text(".solo")).toBe("v:2")

    await ui.unmount()
  })

  it("reports the throw rather than swallowing it", async () => {
    const dep = AtomRef.make(0)
    const app = h(
      "div",
      { class: "r" },
      h.track(() => {
        const v = h.read(dep)
        if (v === 1) throw new Error("boom")
        return `v:${v}`
      }),
    )
    const ui = await render(app)
    expect(errorSpy).not.toHaveBeenCalled()

    dep.set(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[1])).toMatch(/boom/)

    await ui.unmount()
  })
})
