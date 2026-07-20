// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "@verrex/core/testing"

// Two behaviours #153 documents at length and leans on architecturally, but
// which no test exercised — both survived deletion with the whole suite green.

describe("bridgeAtom memoization", () => {
  it("shares ONE ref subscription across every derived reading that ref", async () => {
    // The linchpin of "multi-site is just refcount": the reactive graph keys
    // deps by atom identity, so every derived reading a given ref must `get`
    // the SAME bridge. Return a fresh bridge per call and each derived
    // subscribes independently — correct-looking (both still update) but the
    // refcount story is gone, so this counts subscriptions rather than output.
    const ref = AtomRef.make(0)
    let live = 0
    const realSubscribe = ref.subscribe.bind(ref)
    ;(ref as { subscribe: unknown }).subscribe = (f: (v: number) => void) => {
      live++
      const unsub = realSubscribe(f)
      return () => {
        live--
        unsub()
      }
    }

    const app = h(
      "div",
      {},
      h(
        "span",
        { class: "a" },
        h.track(() => `a:${h.read(ref)}`),
      ),
      h(
        "span",
        { class: "b" },
        h.track(() => `b:${h.read(ref)}`),
      ),
    )

    const ui = await render(app)
    expect(ui.text(".a")).toBe("a:0")
    expect(ui.text(".b")).toBe("b:0")
    expect(live).toBe(1) // ONE bridge, shared — not one per derived

    ref.set(1)
    expect(ui.text(".a")).toBe("a:1")
    expect(ui.text(".b")).toBe("b:1")
    expect(live).toBe(1)

    await ui.unmount()
    expect(live).toBe(0) // and the shared bridge is released exactly once
  })
})

describe("static/reactive classification", () => {
  it("returns the raw value — no Atom — when the thunk reads no ref", () => {
    // The empty-deps early return is what keeps a static attr's static type
    // (and costs no registry node). Delete it and everything becomes an Atom:
    // still renders, so no rendering test notices.
    const staticResult = h.track(() => "plain")
    expect(Atom.isAtom(staticResult)).toBe(false)
    expect(staticResult).toBe("plain")

    const ref = AtomRef.make(1)
    const reactiveResult = h.track(() => h.read(ref))
    expect(Atom.isAtom(reactiveResult)).toBe(true)
  })
})
