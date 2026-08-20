// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { atom, fn, h } from "@verrex/core"
import { render } from "./index.ts"

// `atom` / `fn`. Pins:
// - the body runs with the COMPONENT's services (R rides to the root) but the
//   ATOM's own Scope (an atom-body resource dies with the atom, not the
//   component);
// - lifetime is mounted on the caller's Scope: closing it disposes the node
//   and interrupts an in-flight fiber (one dispatcher tick later);
// - a `fn` used only from a handler keeps its state between calls;
// - `fn` is callable, runs its body ONCE per call, and `interrupt`/`reset`
//   work; a Stream body exposes the latest emission;
// - the atom's span parent is the component.

class Svc extends Context.Service<
  Svc,
  { readonly greet: (n: string) => Effect.Effect<string> }
>()("test/atom-fn/Svc") {}
const svcLayer = Layer.succeed(Svc, { greet: (n) => Effect.succeed(`hi ${n}`) })

const runScoped = <A, E>(
  eff: Effect.Effect<A, E, AtomRegistry.AtomRegistry | Scope.Scope | Svc>,
) => {
  const registry = AtomRegistry.make()
  const scope = Effect.runSync(Scope.make())
  const run = eff.pipe(
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.provideService(Scope.Scope, scope),
    Effect.provide(svcLayer),
  )
  return {
    registry,
    scope,
    run,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
const tick = () => new Promise<void>((r) => setImmediate(r))

describe("atom", () => {
  it("runs with the caller's services; result is an AsyncResult atom", async () => {
    const { registry, run } = runScoped(
      Effect.gen(function* () {
        const a = yield* atom(Effect.andThen(Svc, (s) => s.greet("ada")))
        return a
      }),
    )
    const a = await Effect.runPromise(run)
    await tick()
    expect(AsyncResult.getOrElse(registry.get(a), () => "")).toBe("hi ada")
  })

  it("an atom-body resource lives in the ATOM's scope, not the component's", async () => {
    let released = 0
    const { registry, run } = runScoped(
      Effect.gen(function* () {
        const componentScope = yield* Effect.scope
        const a = yield* atom(
          Effect.gen(function* () {
            const own = yield* Effect.scope
            expect(own).not.toBe(componentScope)
            yield* Effect.addFinalizer(() => Effect.sync(() => void released++))
            return "ok"
          }),
        )
        return a
      }),
    )
    const a = await Effect.runPromise(run)
    await tick()
    expect(AsyncResult.isSuccess(registry.get(a))).toBe(true)
    expect(released).toBe(0)
    // Refresh rebuilds the atom's own scope: the previous resource releases.
    registry.refresh(a)
    await tick()
    expect(released).toBe(1)
  })

  it("closing the caller's Scope interrupts an in-flight body (one tick later)", async () => {
    let interrupted = false
    const gate = Deferred.makeUnsafe<void>()
    const { run, close } = runScoped(
      Effect.gen(function* () {
        return yield* atom(
          Deferred.await(gate).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => void (interrupted = true)),
            ),
          ),
        )
      }),
    )
    await Effect.runPromise(run)
    await tick()
    expect(interrupted).toBe(false)
    await close()
    await tick()
    expect(interrupted).toBe(true)
  })

  it("the atom body's parent span is the component's span", async () => {
    let parent = "none"
    // `Component.make` is `Effect.fn(name)` + a View gate; the span is what
    // matters here, so use the seam's substrate directly.
    const Comp = Effect.fn("Profile")(function* () {
      return yield* atom(
        Effect.gen(function* () {
          const span = yield* Effect.currentParentSpan
          parent = span._tag === "Span" ? span.name : "external"
          return "ok"
        }),
      )
    })
    const { registry, run } = runScoped(Comp())
    const a = await Effect.runPromise(run)
    await tick()
    expect(AsyncResult.isSuccess(registry.get(a))).toBe(true)
    expect(parent).toBe("Profile")
  })

  it("stream body: latest emission", async () => {
    const { registry, run } = runScoped(atom(Stream.make(1, 2, 3)))
    const a = await Effect.runPromise(run)
    await tick()
    expect(AsyncResult.getOrElse(registry.get(a), () => -1)).toBe(3)
  })
})

describe("fn", () => {
  it("is callable, runs the body once per call, exposes AsyncResult state", async () => {
    let runs = 0
    const { registry, run } = runScoped(
      fn((n: number) =>
        Effect.andThen(Svc, (s) => {
          runs++
          return s.greet(String(n))
        }),
      ),
    )
    const send = await Effect.runPromise(run)
    expect(Atom.isAtom(send)).toBe(true)
    expect(AsyncResult.isInitial(registry.get(send))).toBe(true)
    await Effect.runPromise(
      Effect.provideService(send(7), AtomRegistry.AtomRegistry, registry),
    )
    await tick()
    expect(runs).toBe(1)
    expect(AsyncResult.getOrElse(registry.get(send), () => "")).toBe("hi 7")
    await Effect.runPromise(
      Effect.provideService(send.reset, AtomRegistry.AtomRegistry, registry),
    )
    expect(AsyncResult.isInitial(registry.get(send))).toBe(true)
  })

  it("interrupt stops an in-flight call", async () => {
    let interrupted = false
    const gate = Deferred.makeUnsafe<void>()
    const { registry, run } = runScoped(
      fn((_: void) =>
        Deferred.await(gate).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => void (interrupted = true)),
          ),
        ),
      ),
    )
    const go = await Effect.runPromise(run)
    await Effect.runPromise(
      Effect.provideService(go(), AtomRegistry.AtomRegistry, registry),
    )
    expect(AsyncResult.isWaiting(registry.get(go))).toBe(true)
    await Effect.runPromise(
      Effect.provideService(go.interrupt, AtomRegistry.AtomRegistry, registry),
    )
    await tick()
    expect(interrupted).toBe(true)
    expect(AsyncResult.isInterrupted(registry.get(go))).toBe(true)
  })

  it("stream body: latest emission", async () => {
    const { registry, run } = runScoped(
      fn((n: number) => Stream.make(n, n + 1)),
    )
    const go = await Effect.runPromise(run)
    await Effect.runPromise(
      Effect.provideService(go(5), AtomRegistry.AtomRegistry, registry),
    )
    await tick()
    expect(AsyncResult.getOrElse(registry.get(go), () => -1)).toBe(6)
  })

  it("in a component: a handler-only fn keeps state; unmount disposes it", async () => {
    let interrupted = false
    const gate = Deferred.makeUnsafe<void>()
    const App = Effect.fn(function* () {
      const go = yield* fn((_: void) =>
        Deferred.await(gate).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => void (interrupted = true)),
          ),
        ),
      )
      return yield* h(
        "div",
        {},
        h("button", { class: "go", onclick: () => go() }, "go"),
        h(
          "span",
          { class: "s" },
          Atom.map(go, (r) => (AsyncResult.isWaiting(r) ? "busy" : "idle")),
        ),
      )
    })
    const ui = await render(App())
    expect(ui.text(".s")).toBe("idle")
    ui.click(".go")
    await ui.tick()
    expect(ui.text(".s")).toBe("busy")
    await ui.unmount()
    await tick()
    expect(interrupted).toBe(true)
  })
})
