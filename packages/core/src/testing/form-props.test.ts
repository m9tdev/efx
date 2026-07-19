// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "./index.ts"

// Form-control binding: `value`/`checked`/`selected`/`indeterminate` must be
// written as DOM properties (post-dirty-flag, attributes stop mirroring), falsy
// props must remove their attribute, and property writes must land after
// children exist (`select.value` before its <option>s is a silent no-op).
//
// happy-dom implements the dirty value flag (a direct `.value` property write
// makes later `setAttribute("value", …)` calls stop updating the property),
// so the divergence scenario is provable in-process — see the
// "user-edited input" test below.

describe("form-control props", () => {
  it("disabled true → false removes the attribute", async () => {
    const disabled = AtomRef.make<boolean>(true)
    const App = Effect.fn(function* () {
      return yield* h("button", { class: "b", disabled })
    })

    const ui = await render(App())
    const btn = ui.get(".b") as HTMLButtonElement
    expect(btn.hasAttribute("disabled")).toBe(true)

    disabled.set(false)
    await ui.tick()
    expect(btn.hasAttribute("disabled")).toBe(false)

    disabled.set(true)
    await ui.tick()
    expect(btn.hasAttribute("disabled")).toBe(true)
    await ui.unmount()
  })

  it("checked toggles the property in both directions", async () => {
    const checked = AtomRef.make<boolean>(false)
    const App = Effect.fn(function* () {
      return yield* h("input", { class: "c", type: "checkbox", checked })
    })

    const ui = await render(App())
    const box = ui.get(".c") as HTMLInputElement
    expect(box.checked).toBe(false)

    checked.set(true)
    await ui.tick()
    expect(box.checked).toBe(true)

    checked.set(false)
    await ui.tick()
    expect(box.checked).toBe(false)
    await ui.unmount()
  })

  // happy-dom has no option-selectedness dirtiness (an attribute write moves
  // the selection even after a user pick), so this pins toggling behavior
  // only; the property-vs-attribute write path needs a real browser to prove.
  it("selected on an option drives the select's value both directions", async () => {
    const preferB = AtomRef.make<boolean>(false)
    const App = Effect.fn(function* () {
      return yield* h(
        "select",
        { class: "sel" },
        h("option", { value: "a" }, "A"),
        h("option", { class: "ob", value: "b", selected: preferB }, "B"),
      )
    })

    const ui = await render(App())
    const sel = ui.get(".sel") as HTMLSelectElement
    const optB = ui.get(".ob") as HTMLOptionElement
    expect(optB.selected).toBe(false)
    expect(sel.value).toBe("a")

    preferB.set(true)
    await ui.tick()
    expect(optB.selected).toBe(true)
    expect(sel.value).toBe("b")

    preferB.set(false)
    await ui.tick()
    expect(optB.selected).toBe(false)
    expect(sel.value).toBe("a")
    await ui.unmount()
  })

  it("select value applies after children exist (initial build ordering)", async () => {
    const country = AtomRef.make("nl")
    const App = Effect.fn(function* () {
      return yield* h(
        "select",
        { class: "s", value: country },
        h("option", { value: "be" }, "Belgium"),
        h("option", { value: "nl" }, "Netherlands"),
        h("option", { value: "de" }, "Germany"),
      )
    })

    const ui = await render(App())
    const sel = ui.get(".s") as HTMLSelectElement
    // Applied before the <option>s existed, this assignment would have
    // silently no-opped and the select would sit on its default ("be").
    expect(sel.value).toBe("nl")

    country.set("de")
    await ui.tick()
    expect(sel.value).toBe("de")
    await ui.unmount()
  })

  it("skips the property write when unchanged, preserving the caret", async () => {
    const text = AtomRef.make("hello")
    const App = Effect.fn(function* () {
      return yield* h("input", { class: "t", value: text })
    })

    const ui = await render(App())
    const input = ui.get(".t") as HTMLInputElement
    expect(input.value).toBe("hello")

    // Simulate the echo path: the user edits (property already holds the new
    // string, caret mid-string), then the model catches up via oninput.
    input.value = "hexllo"
    input.setSelectionRange(3, 3)
    text.set("hexllo")
    await ui.tick()
    expect(input.value).toBe("hexllo")
    // An unguarded `input.value = ...` write would have jumped this to 6.
    expect(input.selectionStart).toBe(3)
    await ui.unmount()
  })

  it("model change reaches a user-edited input (dirty value flag)", async () => {
    const text = AtomRef.make("initial")
    const App = Effect.fn(function* () {
      return yield* h("input", { class: "d", value: text })
    })

    const ui = await render(App())
    const input = ui.get(".d") as HTMLInputElement
    expect(input.value).toBe("initial")

    // A direct property write sets the dirty value flag — from here on,
    // attribute writes no longer reach the property, so an implementation
    // that regressed to setAttribute fails this assertion.
    input.value = "user-edited"
    // The model must change from OUTSIDE the input (a button, a direct set):
    // mutating it from an oninput echo would leave the property already
    // correct and mask a broken write path.
    text.set("")
    await ui.tick()
    expect(input.value).toBe("")
    await ui.unmount()
  })

  it("indeterminate applies as a property (attribute form doesn't exist)", async () => {
    const ind = AtomRef.make<boolean>(true)
    const App = Effect.fn(function* () {
      return yield* h("input", {
        class: "i",
        type: "checkbox",
        indeterminate: ind,
      })
    })

    const ui = await render(App())
    const box = ui.get(".i") as HTMLInputElement
    expect(box.indeterminate).toBe(true)

    ind.set(false)
    await ui.tick()
    expect(box.indeterminate).toBe(false)
    await ui.unmount()
  })

  it("textarea value wins over its children (which are only the default)", async () => {
    // A textarea's children are its DEFAULT value; the deferred property
    // write lands after them and must control the live value.
    const text = AtomRef.make("bound")
    const App = Effect.fn(function* () {
      return yield* h("textarea", { class: "ta", value: text }, "default-child")
    })

    const ui = await render(App())
    const ta = ui.get(".ta") as HTMLTextAreaElement
    expect(ta.value).toBe("bound")

    text.set("updated")
    await ui.tick()
    expect(ta.value).toBe("updated")
    await ui.unmount()
  })

  // #156: options arriving AFTER the value write (async/reactive lists) —
  // the select silently resets to its first option and nothing re-asserts.
  // Executable statement of the defect; flip to `it` when #156 lands.
  it.fails("select keeps its bound value when options arrive later (#156)", async () => {
    const country = AtomRef.make("nl")
    const options = AtomRef.make<ReadonlyArray<string>>([])
    const App = Effect.fn(function* () {
      return yield* h(
        "select",
        { class: "late", value: country },
        options.map((vs) => vs.map((v) => h("option", { value: v }, v))),
      )
    })

    const ui = await render(App())
    options.set(["be", "nl", "de"])
    await ui.tick()
    const sel = ui.get(".late") as HTMLSelectElement
    expect(sel.value).toBe("nl")
    await ui.unmount()
  })

  it("value={false} renders empty, not the string 'false'", async () => {
    const text = AtomRef.make<string | false>(false)
    const App = Effect.fn(function* () {
      return yield* h("input", { class: "f", value: text })
    })

    const ui = await render(App())
    const input = ui.get(".f") as HTMLInputElement
    expect(input.value).toBe("")

    text.set("real")
    await ui.tick()
    expect(input.value).toBe("real")

    text.set(false)
    await ui.tick()
    expect(input.value).toBe("")
    await ui.unmount()
  })

  it("value on a non-form tag stays an attribute (numeric IDL not clobbered)", async () => {
    const App = Effect.fn(function* () {
      return yield* h("li", { class: "li", value: "3" }, "third")
    })

    const ui = await render(App())
    const li = ui.get(".li")
    expect(li.getAttribute("value")).toBe("3")
    await ui.unmount()
  })

  it("type applies before value regardless of prop order", async () => {
    // `type` goes eagerly as an attribute; `value` is a deferred property
    // write — so even with value listed first, the input is already
    // type="number" when the value lands (a text-typed write to a number
    // input can be dropped or mis-parsed).
    const App = Effect.fn(function* () {
      return yield* h("input", { class: "n", value: "42", type: "number" })
    })

    const ui = await render(App())
    const input = ui.get(".n") as HTMLInputElement
    expect(input.getAttribute("type")).toBe("number")
    expect(input.value).toBe("42")
    await ui.unmount()
  })

  it("class={null} removes the class attribute via the generic path", async () => {
    const cls = AtomRef.make<string | null>("on")
    const App = Effect.fn(function* () {
      return yield* h("div", { class: cls })
    })

    const ui = await render(App())
    const div = ui.get("div")
    expect(div.getAttribute("class")).toBe("on")

    cls.set(null)
    await ui.tick()
    expect(div.hasAttribute("class")).toBe(false)
    await ui.unmount()
  })
})
