/**
 * `h.reader(() => expr)` — the compiler's lowering of a JSX expression
 * that reads atoms/refs via `get(...)`. An `Atom.readable` under the hood:
 * `get` accepts an `Atom` (registry read) or an `AtomRef` (bridged inside
 * the reader's own read); a re-run that throws keeps the last value and
 * stays subscribed (node-local; a first-run throw becomes `Effect.die`).
 */
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { get, h } from "./h.ts"

describe("h.reader", () => {
  it("reads atoms and refs and re-runs on change", () => {
    const registry = AtomRegistry.make()
    const a = Atom.make(1)
    const r = AtomRef.make(10)
    const sum = h.reader(() => get(a) + get(r))
    const seen: Array<number> = []
    registry.subscribe(sum, (v) => seen.push(v), { immediate: true })
    registry.set(a, 2)
    r.set(20)
    expect(seen).toEqual([11, 12, 22])
  })

  it("a re-run that throws keeps the last value, stays subscribed, recovers", () => {
    const registry = AtomRegistry.make()
    const user = AtomRef.make<{ name: string } | null>({ name: "ada" })
    const name = h.reader(() => get(user)!.name)
    const seen: Array<string> = []
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    registry.subscribe(name, (v) => seen.push(v), { immediate: true })
    user.set(null) // throws inside the reader → last value held, reported
    user.set({ name: "bob" }) // recovers
    expect(seen).toEqual(["ada", "bob"])
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it("get() outside a reader throws with a clear message", () => {
    const a = Atom.make(1)
    expect(() => get(a)).toThrow(/outside a reactive expression/)
  })

  it("a FIRST-run throw becomes Effect.die (never escapes the registry)", () => {
    const registry = AtomRegistry.make()
    const user = AtomRef.make<{ name: string } | null>(null)
    const name = h.reader(() => get(user)!.name)
    const v = registry.get(name)
    expect(Effect.isEffect(v)).toBe(true)
    // ...and a sibling on the same dep keeps updating: the throw did not
    // abort the notify cascade.
    const show = Atom.make(false)
    const inner = h.reader(() =>
      get(show) ? h.reader(() => get(user)!.name) : null,
    )
    const sibling = h.reader(() => String(get(show)))
    const seen: Array<string> = []
    registry.subscribe(sibling, (x) => seen.push(x), { immediate: true })
    registry.subscribe(inner, () => {}, { immediate: true })
    registry.set(show, true)
    expect(seen).toEqual(["false", "true"])
  })

  it("nested readers each track their own deps (small ambient stack)", () => {
    const registry = AtomRegistry.make()
    const a = Atom.make(1)
    const b = Atom.make(10)
    const inner = h.reader(() => get(b) * 2)
    const outer = h.reader(() => get(a) + get(inner))
    const seen: Array<number> = []
    registry.subscribe(outer, (v) => seen.push(v), { immediate: true })
    registry.set(b, 20)
    registry.set(a, 2)
    expect(seen).toEqual([21, 41, 42])
  })

  it("get() inside a source's own read (Atom.map body) throws instead of mis-tracking", () => {
    const registry = AtomRegistry.make()
    const a = Atom.make(1)
    const b = Atom.make(10)
    const m = Atom.map(a, (v) => v + get(b)) // wrong: get() outside a reader
    const out = h.reader(() => get(m))
    const v = registry.get(out) // first-run throw → Effect.die
    expect(Effect.isEffect(v)).toBe(true)
  })
})

describe("h() rejects function tags (post-#71 migration guard)", () => {
  it("throws a TypeError naming the direct-call migration", () => {
    const fakeComponent = () => "not a real component"
    expect(() =>
      (h as unknown as (...args: ReadonlyArray<unknown>) => unknown)(
        fakeComponent,
        {},
      ),
    ).toThrowError(/direct calls since #71/)
  })
})
