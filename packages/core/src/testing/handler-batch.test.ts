// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "./index.ts"

// Handler dispatch runs its synchronous prefix inside `Atom.batch`
// (docs/reactivity-migration.md step 1). Pin: a diamond `a → b, a → c,
// d = b + c` written from a handler recomputes `d` ONCE per click. Without
// the batch (or without `startImmediately`) the registry pushes `b` and `c`
// eagerly and `d` runs twice, the first time with an inconsistent pair.

const diamond = () => {
  const a = Atom.make(1)
  const b = Atom.map(a, (n) => n * 10)
  const c = Atom.map(a, (n) => n + 1)
  let dRuns = 0
  const seen: Array<number> = []
  const d = Atom.readable((get) => {
    dRuns++
    const v = get(b) + get(c)
    seen.push(v)
    return v
  })
  return { a, d, runs: () => dRuns, seen }
}

describe("handler writes are batched", () => {
  it("a diamond recomputes once per handler write", async () => {
    const { a, d, runs, seen } = diamond()
    const App = Effect.fn(function* () {
      return yield* h(
        "div",
        {},
        h("button", { class: "go", onclick: () => Atom.set(a, 2) }, "go"),
        h("span", { class: "d" }, d),
      )
    })
    const ui = await render(App())
    expect(ui.text(".d")).toBe("12")
    const before = runs()

    ui.click(".go")
    await ui.tick()
    expect(ui.text(".d")).toBe("23")
    // Exactly one recompute for the click, and never a glitch value: with
    // a = 2, b = 20 and c = 3; the unbatched interleaving shows 20 + 2 = 22.
    expect(runs() - before).toBe(1)
    expect(seen).not.toContain(22)
    await ui.unmount()
  })

  it("a handler dispatched inside an open batch still lands (guard path)", async () => {
    // When a batch is already open we must NOT open our own (nested-commit
    // corruption in `Registry.batch`); the outer batch collects the write.
    const { a, d } = diamond()
    const App = Effect.fn(function* () {
      return yield* h(
        "div",
        {},
        h("button", { class: "go", onclick: () => Atom.set(a, 3) }, "go"),
        h("span", { class: "d" }, d),
      )
    })
    const ui = await render(App())
    Atom.batch(() => ui.click(".go"))
    await ui.tick()
    expect(ui.text(".d")).toBe("34")
    await ui.unmount()
  })
})
