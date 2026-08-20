// @vitest-environment happy-dom
import { describe, expect, expectTypeOf, it } from "vitest"
import { Context, Data, Effect, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { For, h, type View } from "@verrex/core"
import { render } from "./index.ts"

// `<For>` — one keyed list, two
// sources. After compile `<For each={x} key={k}>{fn}</For>` is
// `For({ each: x, key: k, children: [fn] })`, which is what these tests call.

interface User {
  readonly id: string
  readonly name: string
}
class UserEq extends Data.Class<{
  readonly id: string
  readonly name: string
}> {}

describe("For — Atom<ReadonlyArray<T>> source", () => {
  it("renders rows, keyed insert/move/remove keep DOM identity", async () => {
    const users = Atom.make<ReadonlyArray<User>>([
      { id: "a", name: "Ada" },
      { id: "b", name: "Bob" },
    ])
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        h(
          "ul",
          {},
          For({
            each: users,
            key: (u) => u.id,
            children: [
              (u, i) =>
                h(
                  "li",
                  { class: "row" },
                  i,
                  ":",
                  Atom.map(u, (x) => x.name),
                ),
            ],
          }),
        ),
        h(
          "button",
          {
            class: "shuffle",
            onclick: () =>
              registry.set(users, [
                { id: "c", name: "Cy" },
                { id: "b", name: "Bob" },
                { id: "a", name: "Ada" },
              ]),
          },
          "go",
        ),
        h(
          "button",
          {
            class: "drop",
            onclick: () => registry.set(users, [{ id: "b", name: "Bob" }]),
          },
          "drop",
        ),
      )
    })
    const ui = await render(App())
    const rows = () => ui.all(".row")
    expect(rows().map((r) => r.textContent)).toEqual(["0:Ada", "1:Bob"])
    const [adaNode, bobNode] = rows()

    ui.click(".shuffle")
    await ui.tick()
    expect(rows().map((r) => r.textContent)).toEqual(["0:Cy", "1:Bob", "2:Ada"])
    expect(rows()[1]).toBe(bobNode)
    expect(rows()[2]).toBe(adaNode)

    ui.click(".drop")
    await ui.tick()
    expect(rows().map((r) => r.textContent)).toEqual(["0:Bob"])
    expect(rows()[0]).toBe(bobNode)
    await ui.unmount()
  })

  it("an unchanged (Equal) item is not re-rendered; a changed one updates only its cell", async () => {
    const users = Atom.make<ReadonlyArray<UserEq>>([
      new UserEq({ id: "a", name: "Ada" }),
      new UserEq({ id: "b", name: "Bob" }),
    ])
    let cellRuns = 0
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        For({
          each: users,
          key: (u) => u.id,
          children: [
            (u) =>
              h(
                "p",
                { class: "row" },
                Atom.map(u, (x) => {
                  cellRuns++
                  return x.name
                }),
              ),
          ],
        }),
        h(
          "button",
          {
            class: "rename",
            onclick: () =>
              registry.set(users, [
                new UserEq({ id: "a", name: "Ada" }), // Equal → no update
                new UserEq({ id: "b", name: "Bobby" }),
              ]),
          },
          "rename",
        ),
      )
    })
    const ui = await render(App())
    const [adaP, bobP] = ui.all(".row")
    const runsAfterMount = cellRuns
    ui.click(".rename")
    await ui.tick()
    expect(ui.all(".row").map((r) => r.textContent)).toEqual(["Ada", "Bobby"])
    // Same DOM nodes (structure unchanged); only Bob's cell recomputed.
    expect(ui.all(".row")[0]).toBe(adaP)
    expect(ui.all(".row")[1]).toBe(bobP)
    expect(cellRuns - runsAfterMount).toBe(1)
    await ui.unmount()
  })

  it("removing a row closes its Scope", async () => {
    const users = Atom.make<ReadonlyArray<User>>([{ id: "a", name: "Ada" }])
    let released = 0
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        For({
          each: users,
          key: (u) => u.id,
          children: [
            (u) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => void released++),
                )
                return yield* h(
                  "p",
                  { class: "row" },
                  Atom.map(u, (x) => x.name),
                )
              }),
          ],
        }),
        h(
          "button",
          { class: "clear", onclick: () => registry.set(users, []) },
          "clear",
        ),
      )
    })
    const ui = await render(App())
    expect(ui.all(".row").length).toBe(1)
    ui.click(".clear")
    await ui.tick()
    expect(ui.all(".row").length).toBe(0)
    expect(released).toBe(1)
    await ui.unmount()
  })
})

describe("For — AtomRef.Collection source", () => {
  it("rows are the collection's refs; per-cell updates; index is live", async () => {
    const todos = AtomRef.collection<{ title: string; done: boolean }>([
      { title: "a", done: false },
      { title: "b", done: false },
    ])
    const App = Effect.fn(function* () {
      return yield* h(
        "ul",
        {},
        For({
          each: todos,
          children: [
            (todo, i) =>
              h(
                "li",
                { class: "row" },
                i,
                ":",
                todo.prop("title"),
                todo.map((t) => (t.done ? "✓" : "·")),
              ),
          ],
        }),
      )
    })
    const ui = await render(App())
    const rows = () => ui.all(".row").map((r) => r.textContent)
    expect(rows()).toEqual(["0:a·", "1:b·"])
    const [first, second] = todos.value as [
      AtomRef.AtomRef<{ title: string; done: boolean }>,
      AtomRef.AtomRef<{ title: string; done: boolean }>,
    ]
    second.update((t) => ({ ...t, done: true }))
    expect(rows()).toEqual(["0:a·", "1:b✓"])
    todos.remove(first)
    expect(rows()).toEqual(["0:b✓"])
    await ui.unmount()
  })
})

describe("For — channel pins", () => {
  class Svc extends Context.Service<Svc, { readonly x: number }>()(
    "test/for/Svc",
  ) {}
  class Boom extends Data.TaggedError("Boom") {}
  it("a row's Effect E and View<E> are LIVE; row R (minus Scope) folds; no construction E", () => {
    const users = Atom.make<ReadonlyArray<User>>([])
    const eff = For({
      each: users,
      key: (u) => u.id,
      children: [
        (u) =>
          Effect.gen(function* () {
            yield* Svc
            yield* Effect.scope
            if (Math.random() > 2) return yield* Effect.fail(new Boom())
            return yield* h(
              "li",
              { onclick: () => Effect.fail(new Boom()) },
              Atom.map(u, (x) => x.name),
            )
          }),
      ],
    })
    expectTypeOf(eff).toEqualTypeOf<Effect.Effect<View<Boom>, never, Svc>>()
    const scopeOnly = For({
      each: users,
      key: (u) => u.id,
      children: [
        (u) =>
          h(
            "li",
            {},
            Atom.map(u, (x) => x.id),
          ),
      ],
    })
    expectTypeOf(scopeOnly).toEqualTypeOf<
      Effect.Effect<View<never>, never, never>
    >()
    // Collection overload infers the row as AtomRef<T>
    const coll = AtomRef.collection<User>([])
    For({
      each: coll,
      children: [
        (row) => {
          expectTypeOf(row).toEqualTypeOf<AtomRef.AtomRef<User>>()
          return h("li", {})
        },
      ],
    })
    void Scope
  })
})
