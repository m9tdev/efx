/**
 * `h.reader((get) => expr)` — the compiler's lowering of a JSX expression
 * that reads atoms/refs via `get(...)`. An `Atom.readable` under the hood:
 * `get` accepts an `Atom` (registry read) or an `AtomRef` (bridged inside
 * the reader's own read); a re-run that throws keeps the last value and
 * stays subscribed (node-local; a first-run throw rethrows).
 */
import { describe, expect, it, vi } from "@effect/vitest"
import { AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { h } from "./h.ts"

describe("h.reader", () => {
  it("reads atoms and refs and re-runs on change", () => {
    const registry = AtomRegistry.make()
    const a = Atom.make(1)
    const r = AtomRef.make(10)
    const sum = h.reader((get) => get(a) + get(r))
    const seen: Array<number> = []
    registry.subscribe(sum, (v) => seen.push(v), { immediate: true })
    registry.set(a, 2)
    r.set(20)
    expect(seen).toEqual([11, 12, 22])
  })

  it("a re-run that throws keeps the last value, stays subscribed, recovers", () => {
    const registry = AtomRegistry.make()
    const user = AtomRef.make<{ name: string } | null>({ name: "ada" })
    const name = h.reader((get) => get(user)!.name)
    const seen: Array<string> = []
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    registry.subscribe(name, (v) => seen.push(v), { immediate: true })
    user.set(null) // throws inside the reader → last value held, reported
    user.set({ name: "bob" }) // recovers
    expect(seen).toEqual(["ada", "bob"])
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it("a FIRST-run throw rethrows (fail loud at first paint)", () => {
    const registry = AtomRegistry.make()
    const user = AtomRef.make<{ name: string } | null>(null)
    const name = h.reader((get) => get(user)!.name)
    expect(() => registry.get(name)).toThrow()
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
