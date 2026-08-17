// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "./index.ts"

// Reactive props (docs/reactivity-migration.md step 3): ANY prop may be an
// `Atom` or `AtomRef` — attributes, form props and typed lowercase `on*`
// handlers alike. `applyProp` subscribes and re-applies the current value.
// The Atom-attr and AtomRef-handler (`onClick`) cases were already pinned
// (atom-attr.test.ts, handler-scope.test.ts); this file pins the two shapes
// that were type-rejected before: an AtomRef attribute and an Atom-valued
// typed handler key.

describe("reactive props", () => {
  it("an AtomRef-valued attribute re-applies on set", async () => {
    const cls = AtomRef.make("a")
    const App = Effect.fn(function* () {
      return yield* h("div", { id: "t", class: cls })
    })
    const ui = await render(App())
    expect(ui.get("#t").getAttribute("class")).toBe("a")
    cls.set("b")
    expect(ui.get("#t").getAttribute("class")).toBe("b")
    await ui.unmount()
  })

  it("an Atom-valued typed handler (`onclick`) runs the CURRENT function", async () => {
    const log: Array<string> = []
    // `Atom.make(fn)` reads a bare function as a `create` reader, so a stored
    // handler lives in a cell and is mapped out — that mapped Atom is what
    // the typed slot receives.
    const cell = Atom.make({ run: (_e: MouseEvent) => void log.push("first") })
    const handler = Atom.map(cell, (c) => c.run)
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        h("button", { class: "go", onclick: handler }, "go"),
        h(
          "button",
          {
            class: "swap",
            onclick: () =>
              registry.set(cell, { run: () => void log.push("second") }),
          },
          "swap",
        ),
      )
    })
    const ui = await render(App())
    ui.click(".go")
    ui.click(".swap")
    await ui.tick()
    ui.click(".go")
    expect(log).toEqual(["first", "second"])
    await ui.unmount()
  })
})
