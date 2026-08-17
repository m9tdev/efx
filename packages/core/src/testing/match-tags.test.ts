// @vitest-environment happy-dom
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Context, Data, Deferred, Effect, Option, Result } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { atom, Catch, h, MatchTags, type View } from "@verrex/core"
import { render } from "./index.ts"

// `<MatchTags on={x} Tag={…} />` — after compile:
// `MatchTags({ on: x, …})`. Pins: per-tag dispatch (missing
// tag → nothing), failure bubbling by default (typed residual to Catch),
// failure tag-map narrowing, function Failure = handled, interrupt-only
// dropped, plain values and atoms/refs as `on`, generic over Option/Result/
// AsyncResult/own unions, handler R/E fold.

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly ms: number
}> {}
type Err = NotFound | RateLimited

describe("MatchTags — dispatch", () => {
  it("renders the matching tag; a missing tag renders nothing; reacts to the atom", async () => {
    const sel = Atom.make<Option.Option<string>>(Option.none())
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        h(
          "span",
          { class: "out" },
          MatchTags({
            on: sel,
            Some: (o) => h("b", {}, o.value),
          }),
        ),
        h(
          "button",
          {
            class: "pick",
            onclick: () => registry.set(sel, Option.some("ada")),
          },
          "pick",
        ),
      )
    })
    const ui = await render(App())
    expect(ui.text(".out")).toBe("")
    ui.click(".pick")
    await ui.tick()
    expect(ui.text(".out")).toBe("ada")
    await ui.unmount()
  })

  it("works on a plain (non-atom) value and on any own tagged union", async () => {
    type State = { _tag: "Idle" } | { _tag: "Busy"; readonly n: number }
    const s: State = { _tag: "Busy", n: 3 }
    const App = Effect.fn(function* () {
      return yield* h(
        "p",
        { class: "out" },
        MatchTags({ on: s, Busy: (b) => `busy ${b.n}` }),
      )
    })
    const ui = await render(App())
    expect(ui.text(".out")).toBe("busy 3")
    await ui.unmount()
  })
})

describe("MatchTags — failures bubble by default", () => {
  it("an unhandled AsyncResult failure escalates to Catch; a tag map handles part and the rest bubbles", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const fetch: Effect.Effect<string, Err> = Effect.gen(function* () {
      yield* Deferred.await(gate)
      return yield* Effect.fail(new RateLimited({ ms: 500 }))
    })
    const App = Effect.fn(function* () {
      const user = yield* atom(fetch)
      const body = h(
        "div",
        {},
        MatchTags({
          on: user,
          Initial: () => h("p", { class: "loading" }, "loading"),
          Success: (s) => h("b", {}, s.value),
          Failure: {
            NotFound: (e) => h("p", { class: "leaf" }, `no ${e.id}`),
          },
        }),
      )
      // Type pin: only RateLimited is left to bubble.
      expectTypeOf(body).toMatchTypeOf<
        Effect.Effect<View<RateLimited>, never, any>
      >()
      return yield* Catch(body, {
        RateLimited: (e) => h("p", { class: "fallback" }, `retry in ${e.ms}`),
      })
    })
    const ui = await render(App())
    expect(ui.query(".loading")).not.toBeNull()
    Effect.runSync(Deferred.succeed(gate, void 0))
    await ui.waitFor(".fallback")
    expect(ui.text(".fallback")).toBe("retry in 500")
    await ui.unmount()
  })

  it("a matched failure tag renders at the leaf; a Result failure escalates too", async () => {
    const r = Atom.make<Result.Result<number, NotFound>>(
      Result.fail(new NotFound({ id: "9" })),
    )
    const App = Effect.fn(function* () {
      const body = h(
        "div",
        {},
        MatchTags({
          on: r,
          Success: (s) => h("b", {}, String(s.success)),
        }),
      )
      expectTypeOf(body).toMatchTypeOf<
        Effect.Effect<View<NotFound>, never, any>
      >()
      return yield* Catch(body, {
        NotFound: (e) => h("p", { class: "fb" }, `nf ${e.id}`),
      })
    })
    const ui = await render(App())
    await ui.waitFor(".fb")
    expect(ui.text(".fb")).toBe("nf 9")
    await ui.unmount()
  })

  it("Failure as a function handles everything (View<never>); interrupt-only causes render nothing", async () => {
    const r = Atom.make<AsyncResult.AsyncResult<number, NotFound>>(
      AsyncResult.failure<number, NotFound>(
        Cause.interrupt(1) as Cause.Cause<NotFound>,
      ),
    )
    const App = Effect.fn(function* () {
      const body = h(
        "p",
        { class: "out" },
        MatchTags({
          on: r,
          Success: (s) => String(s.value),
          Failure: (f) => `failed ${Cause.pretty(f.cause)}`,
        }),
      )
      expectTypeOf(body).toMatchTypeOf<Effect.Effect<View<never>, never, any>>()
      return yield* body
    })
    const ui = await render(App())
    // Function handler receives even the interrupt failure — it opted in to all.
    expect(ui.text(".out")).toMatch(/failed/)
    await ui.unmount()

    const r2 = Atom.make<AsyncResult.AsyncResult<number, NotFound>>(
      AsyncResult.failure<number, NotFound>(
        Cause.interrupt(1) as Cause.Cause<NotFound>,
      ),
    )
    const App2 = Effect.fn(function* () {
      return yield* Catch(
        h(
          "p",
          { class: "out2" },
          MatchTags({
            on: r2,
            Success: (s) => String(s.value),
          }),
        ),
        () => h("p", { class: "fb2" }, "escalated"),
      )
    })
    const ui2 = await render(App2())
    await ui2.tick()
    expect(ui2.query(".fb2")).toBeNull()
    expect(ui2.text(".out2")).toBe("")
    await ui2.unmount()
  })
})

describe("MatchTags — waiting failure", () => {
  it("an unhandled failure with a retry in flight renders nothing instead of re-escalating", async () => {
    const r = Atom.make<AsyncResult.AsyncResult<number, NotFound>>(
      AsyncResult.failure<number, NotFound>(
        Cause.fail(new NotFound({ id: "1" })),
        { waiting: true },
      ),
    )
    const App = Effect.fn(function* () {
      return yield* Catch(
        h(
          "p",
          { class: "out" },
          MatchTags({ on: r, Success: (s) => String(s.value) }),
        ),
        () => h("p", { class: "fb" }, "escalated"),
      )
    })
    const ui = await render(App())
    await ui.tick()
    expect(ui.query(".fb")).toBeNull()
    expect(ui.text(".out")).toBe("")
    await ui.unmount()
  })
})

describe("MatchTags — Waiting arm", () => {
  it("Waiting wins over the tag arms while waiting (initial fetch and retry alike)", async () => {
    const r = Atom.make<AsyncResult.AsyncResult<number, NotFound>>(
      AsyncResult.initial(true),
    )
    const App = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        h(
          "p",
          { class: "out" },
          MatchTags({
            on: r,
            Waiting: () => "…",
            Success: (s) => String(s.value),
            Failure: () => "failed",
          }),
        ),
        h(
          "button",
          {
            class: "retry",
            onclick: () =>
              registry.set(
                r,
                AsyncResult.failure<number, NotFound>(
                  Cause.fail(new NotFound({ id: "1" })),
                  { waiting: true },
                ),
              ),
          },
          "retry",
        ),
        h(
          "button",
          {
            class: "ok",
            onclick: () => registry.set(r, AsyncResult.success(7)),
          },
          "ok",
        ),
      )
    })
    const ui = await render(App())
    expect(ui.text(".out")).toBe("…")
    ui.click(".ok")
    await ui.tick()
    expect(ui.text(".out")).toBe("7")
    ui.click(".retry")
    await ui.tick()
    expect(ui.text(".out")).toBe("…")
    await ui.unmount()
  })
})

describe("MatchTags — types", () => {
  it("handlers are optional, Failure is a fn or a tag map, residual narrows, extra keys rejected", () => {
    const user = Atom.make<AsyncResult.AsyncResult<string, Err>>(
      AsyncResult.initial(),
    )
    const all = MatchTags({ on: user })
    expectTypeOf(all).toEqualTypeOf<Effect.Effect<View<Err>, never, never>>()
    const part = MatchTags({
      on: user,
      Failure: { NotFound: () => null },
    })
    expectTypeOf(part).toEqualTypeOf<
      Effect.Effect<View<RateLimited>, never, never>
    >()
    const none = MatchTags({ on: user, Failure: () => null })
    expectTypeOf(none).toEqualTypeOf<Effect.Effect<View<never>, never, never>>()
    // Option: no failure variant → nothing bubbles
    const opt = MatchTags({
      on: Option.some(1),
      Some: (o) => o.value,
    })
    expectTypeOf(opt).toEqualTypeOf<Effect.Effect<View<never>, never, never>>()
    // @ts-expect-error unknown tag
    MatchTags({ on: user, Nope: () => 1 })
    // handler R/E fold: an Effect-returning handler's E is live, R folds
    class Svc extends Context.Service<Svc, { readonly x: number }>()(
      "test/mt/Svc",
    ) {}
    const eff = MatchTags({
      on: user,
      Success: () =>
        Effect.andThen(Svc, () => Effect.fail(new NotFound({ id: "x" }))),
      Failure: () => null,
    })
    expectTypeOf(eff).toEqualTypeOf<Effect.Effect<View<NotFound>, never, Svc>>()
  })
})
