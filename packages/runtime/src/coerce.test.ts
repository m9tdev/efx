import { Chunk, Effect, Option, Result, Scope } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import { describe, expect, it } from "vitest"
import { coerceAsync, coerceSync, isAtomRef } from "./coerce.ts"
import { View } from "./View.ts"

// coerceAsync's signature is `(unknown) => Effect<View, any, any>` — the
// `any` in R doesn't satisfy `runPromise`'s `R = never` under strict mode,
// so we run via a typed helper.
const run = (e: Effect.Effect<View, any, any>): Promise<View> =>
  Effect.runPromise(e as Effect.Effect<View, never, never>)

describe("coerceAsync — primitives", () => {
  it("string → View.Text", async () => {
    const view = await run(coerceAsync("hi"))
    expect(view).toEqual(View.Text({ value: "hi" }))
  })

  it("number → View.Text via String()", async () => {
    const view = await run(coerceAsync(42))
    expect(view).toEqual(View.Text({ value: "42" }))
  })

  it("bigint → View.Text via String()", async () => {
    const view = await run(coerceAsync(7n))
    expect(view).toEqual(View.Text({ value: "7" }))
  })

  it.each([null, undefined, true, false])("%s → View.Empty", async (v) => {
    const view = await run(coerceAsync(v))
    expect(view).toEqual(View.Empty())
  })
})

describe("coerceAsync — already-built View pass-through", () => {
  it("returns the same View when given a View", async () => {
    const input = View.Text({ value: "already a view" })
    const view = await run(coerceAsync(input))
    expect(view).toEqual(input)
  })
})

describe("coerceAsync — container peeling", () => {
  it("Effect<string> → coerce the inner value", async () => {
    const view = await run(coerceAsync(Effect.succeed("from effect")))
    expect(view).toEqual(View.Text({ value: "from effect" }))
  })

  it("Effect<Effect<string>> → recursively unwrap", async () => {
    const view = await run(coerceAsync(Effect.succeed(Effect.succeed("nested"))))
    expect(view).toEqual(View.Text({ value: "nested" }))
  })

  it("Option.none → Empty", async () => {
    const view = await run(coerceAsync(Option.none()))
    expect(view).toEqual(View.Empty())
  })

  it("Option.some(x) → coerce x", async () => {
    const view = await run(coerceAsync(Option.some("inner")))
    expect(view).toEqual(View.Text({ value: "inner" }))
  })

  it("Result failure → Empty", async () => {
    const view = await run(coerceAsync(Result.fail("nope")))
    expect(view).toEqual(View.Empty())
  })

  it("Result success → coerce inner", async () => {
    const view = await run(coerceAsync(Result.succeed("ok")))
    expect(view).toEqual(View.Text({ value: "ok" }))
  })

  it("Array → Fragment of coerced children", async () => {
    const view = await run(coerceAsync(["a", 1, null]))
    expect(view).toEqual(
      View.Fragment({
        children: [
          View.Text({ value: "a" }),
          View.Text({ value: "1" }),
          View.Empty(),
        ],
      }),
    )
  })

  it("Chunk → Fragment of coerced children", async () => {
    const view = await run(coerceAsync(Chunk.fromIterable(["a", "b"])))
    expect(view).toEqual(
      View.Fragment({
        children: [View.Text({ value: "a" }), View.Text({ value: "b" })],
      }),
    )
  })
})

describe("coerceAsync — reactive sources", () => {
  it("AtomRef → View.Reactive carrying the ref", async () => {
    const ref = AtomRef.make("hello")
    const view = await run(coerceAsync(ref))
    expect(view).toEqual(View.Reactive({ source: ref }))
  })

  it("Atom → View.Reactive carrying the atom", async () => {
    const atom = Atom.make("hello")
    const view = await run(coerceAsync(atom))
    expect(view).toEqual(View.Reactive({ source: atom }))
  })
})

describe("coerceAsync — unknown fallback", () => {
  it("plain object → View.Text via String()", async () => {
    const view = await run(coerceAsync({ toString: () => "obj!" }))
    expect(view).toEqual(View.Text({ value: "obj!" }))
  })
})

describe("coerceSync — primitives + View pass-through", () => {
  it("string → View.Text", () => {
    expect(coerceSync("hi")).toEqual(View.Text({ value: "hi" }))
  })

  it("number → View.Text via String()", () => {
    expect(coerceSync(42)).toEqual(View.Text({ value: "42" }))
  })

  it("bigint → View.Text via String()", () => {
    expect(coerceSync(7n)).toEqual(View.Text({ value: "7" }))
  })

  it.each([null, undefined, true, false])("%s → View.Empty", (v) => {
    expect(coerceSync(v)).toEqual(View.Empty())
  })

  it("View → pass through", () => {
    const input = View.Text({ value: "v" })
    expect(coerceSync(input)).toEqual(input)
  })
})

describe("coerceSync — Effect handling", () => {
  it("Effect.succeed(string) → coerce inner synchronously", () => {
    expect(coerceSync(Effect.succeed("ok"))).toEqual(View.Text({ value: "ok" }))
  })

  it("Effect that requires Scope: runs with provided scope", () => {
    const scope = Scope.makeUnsafe()
    const eff = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.void)
      return "scoped"
    })
    expect(coerceSync(eff, scope)).toEqual(View.Text({ value: "scoped" }))
  })

  it("Effect that fails synchronously → View.Text with `[effect failed:` prefix", () => {
    const result = coerceSync(Effect.fail("boom"))
    expect(result._tag).toBe("Text")
    expect((result as { value: string }).value).toMatch(/^\[effect failed:/)
  })
})

describe("coerceSync — Array → Fragment", () => {
  it("array of primitives", () => {
    expect(coerceSync(["a", 1, null])).toEqual(
      View.Fragment({
        children: [
          View.Text({ value: "a" }),
          View.Text({ value: "1" }),
          View.Empty(),
        ],
      }),
    )
  })
})

describe("coerceSync — unknown fallback (String())", () => {
  it("plain object → View.Text via String()", () => {
    expect(coerceSync({ toString: () => "obj!" })).toEqual(
      View.Text({ value: "obj!" }),
    )
  })
})

describe("coerceSync — asymmetry (does NOT peel async-only containers)", () => {
  // These tests pin the design decision: sync mode handles only the shapes
  // that can be emitted from a Reactive source at render-time. Containers
  // like Option/Result/Atom/AtomRef would require subscribing or unwrapping
  // an Effect, neither of which is appropriate inside the sync render path.

  it("Option.some(x) → String() fallback, not unwrap", () => {
    const result = coerceSync(Option.some("inner"))
    expect(result._tag).toBe("Text")
    expect((result as { value: string }).value).not.toBe("inner")
  })

  it("Result.succeed(x) → String() fallback, not unwrap", () => {
    const result = coerceSync(Result.succeed("inner"))
    expect(result._tag).toBe("Text")
    expect((result as { value: string }).value).not.toBe("inner")
  })

  it("AtomRef → String() fallback, not View.Reactive", () => {
    const ref = AtomRef.make("x")
    const result = coerceSync(ref)
    expect(result._tag).toBe("Text")
  })

  it("Chunk → String() fallback, not Fragment", () => {
    const result = coerceSync(Chunk.fromIterable(["a", "b"]))
    expect(result._tag).toBe("Text")
  })
})

describe("isAtomRef predicate", () => {
  it("returns true for AtomRef.make()", () => {
    expect(isAtomRef(AtomRef.make(0))).toBe(true)
  })

  it("returns false for plain objects, null, primitives", () => {
    expect(isAtomRef(null)).toBe(false)
    expect(isAtomRef({})).toBe(false)
    expect(isAtomRef("x")).toBe(false)
    expect(isAtomRef(0)).toBe(false)
  })
})
