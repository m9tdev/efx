// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { h, mount } from "@verrex/core"

// Regression pins for #167: `mount` owns its AtomRegistry.
//
// Before this change the registry rode `mount`'s R, and the natural
// `mount(...).pipe(Effect.provide(VerrexLive))` scoped the layer to the
// mount effect — which completes as soon as the DOM attaches, disposing the
// registry out from under the live UI. Everything rendered once, then
// silently froze. Now mount creates, provides, and disposes the registry
// itself, so the footgun shape is a no-op and NO registry provision is
// needed at all.

const trackedSpan = (dep: AtomRef.AtomRef<string>) =>
  Effect.gen(function* () {
    return yield* h(
      "span",
      {},
      h.reader((get) => get(dep)),
    )
  })

// Mount under a held-open scope (as a real app's long-lived scope would),
// returning a close function for teardown.
const mountHeld = async <R>(
  app: Effect.Effect<void, never, R>,
): Promise<() => Promise<void>> => {
  const scope = Scope.makeUnsafe()
  await Effect.runPromise(
    Scope.provide(app as Effect.Effect<void, never, never>, scope),
  )
  return () => Effect.runPromise(Scope.close(scope, Exit.void))
}

describe("mount owns the AtomRegistry (#167)", () => {
  it("mounts and stays reactive with no registry provided", async () => {
    const dep = AtomRef.make("a")
    const el = document.createElement("div")
    const close = await mountHeld(mount(trackedSpan(dep), el))
    expect(el.querySelector("span")!.textContent).toBe("a")
    dep.set("b")
    expect(el.querySelector("span")!.textContent).toBe("b")
    await close()
  })

  it("a component's `yield* AtomRegistry` resolves to the mount's own live registry", async () => {
    const el = document.createElement("div")
    let seen: AtomRegistry.AtomRegistry | undefined
    const close = await mountHeld(
      mount(
        Effect.gen(function* () {
          seen = yield* AtomRegistry.AtomRegistry
          return yield* h("span", {}, "x")
        }),
        el,
      ),
    )
    expect(seen).toBeDefined()
    // It is live — usable for reads — not a disposed layer instance.
    const atom = Atom.make(1)
    expect(() => seen!.get(atom)).not.toThrow()
    expect(seen!.get(atom)).toBe(1)
    await close()
  })

  it("closing the mount scope detaches the DOM and disposes the registry together", async () => {
    const dep = AtomRef.make("a")
    const el = document.createElement("div")
    document.body.appendChild(el)
    let registry: AtomRegistry.AtomRegistry | undefined
    const close = await mountHeld(
      mount(
        Effect.gen(function* () {
          registry = yield* AtomRegistry.AtomRegistry
          return yield* h(
            "span",
            {},
            h.reader((get) => get(dep)),
          )
        }),
        el,
      ),
    )
    expect(el.querySelector("span")!.textContent).toBe("a")
    await close()
    expect(el.querySelector("span")).toBeNull()
    // The registry is disposed: touching it now is a loud error, not a
    // silent freeze of a still-visible UI (the UI is gone).
    expect(() => registry!.get(Atom.make(1))).toThrow(/disposed/i)
    el.remove()
  })
})
