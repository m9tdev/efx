/**
 * `h.read` is a faithful, transparent wrapper for `.value`: byte-for-byte
 * `obj.value` for any non-AtomRef (including throwing on null, NO `?.` swallow),
 * and for a branded AtomRef it additionally records a dependency iff a tracker
 * is active. This faithfulness is what lets the compiler rewrite *every* `.value`
 * read in a component body to `h.read` with no compile-time atom analysis.
 */
import { describe, expect, it } from "@effect/vitest"
import { AtomRef } from "effect/unstable/reactivity"
import { h } from "./h.ts"
import { trackDeps } from "./coerce.ts"

// Untyped escape hatch for the faithfulness edge cases (null / non-HasValue)
// that the typed overloads correctly reject at compile time.
const readUnsafe = h.read as (obj: unknown) => unknown

describe("h.read — AtomRef branch", () => {
  it("returns the ref's value", () => {
    const ref = AtomRef.make(7)
    expect(h.read(ref)).toBe(7)
  })

  it("records the ref as a dependency when read under a tracker", () => {
    const ref = AtomRef.make("x")
    const { result, deps } = trackDeps(() => h.read(ref))
    expect(result).toBe("x")
    expect(deps.has(ref)).toBe(true)
  })

  it("records NO dependency when read outside any tracker", () => {
    const ref = AtomRef.make("x")
    // No trackDeps scope active — must not throw, must return the value.
    expect(h.read(ref)).toBe("x")
  })
})

describe("h.read — non-AtomRef branch (faithful .value)", () => {
  it("returns `.value` of a plain object, identical to direct access", () => {
    const domLike = { value: "typed" }
    expect(h.read(domLike)).toBe("typed")
  })

  it("records NO dependency for a non-AtomRef, even under a tracker", () => {
    const domLike = { value: "typed" }
    const { result, deps } = trackDeps(() => h.read(domLike))
    expect(result).toBe("typed")
    expect(deps.size).toBe(0)
  })

  it("throws on null exactly like `null.value` would (no `?.` swallow)", () => {
    expect(() => readUnsafe(null)).toThrow()
    expect(() => readUnsafe(undefined)).toThrow()
  })
})

describe("h() rejects function tags (post-#71 migration guard)", () => {
  it("throws a TypeError naming the direct-call migration", () => {
    const fakeComponent = () => "not a real component"
    expect(() => (h as unknown as (...args: ReadonlyArray<unknown>) => unknown)(fakeComponent, {}))
      .toThrowError(/direct calls since #71/)
  })
})
