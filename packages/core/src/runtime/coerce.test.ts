import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Context, Effect, Option, Result } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import {
  coerceAsync,
  coerceSync,
  type ErrorSink,
  isAtomRef,
  isHandlerKey,
} from "./coerce.ts"
import { View } from "./View.ts"

// A no-op sink for the success/primitive paths (the sink never fires there).
// The routing tests below pass their own collecting sink.
const sink: ErrorSink = () => {}

// The `SyncRunner` every `coerceSync` call needs. These suites exercise the
// coercion itself, not context propagation, so one empty-context runner serves
// them all (the per-node runners are pinned in testing/context-capture.test.ts).
const runSync = Effect.runSyncExitWith(Context.empty())

// `it.effect` wraps each test body in an `Effect.scoped`, so an ambient
// `Scope.Scope` is available via `yield* Effect.scope`. That's exactly what
// `coerceSync` requires — no manual `Scope.makeUnsafe` / `closeUnsafe` dance
// in the test source.

describe("coerceAsync — primitives", () => {
  it.effect("string → View.Text", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync("hi")
      expect(view).toEqual(View.Text({ value: "hi" }))
    }),
  )

  it.effect("number → View.Text via String()", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(42)
      expect(view).toEqual(View.Text({ value: "42" }))
    }),
  )

  it.effect("bigint → View.Text via String()", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(7n)
      expect(view).toEqual(View.Text({ value: "7" }))
    }),
  )

  it.effect.each([null, undefined, true, false])("%s → View.Empty", (v) =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(v)
      expect(view).toEqual(View.Empty())
    }),
  )
})

describe("coerceAsync — already-built View pass-through", () => {
  it.effect("returns the same View when given a View", () =>
    Effect.gen(function* () {
      const input = View.Text({ value: "already a view" })
      const view = yield* coerceAsync(input)
      expect(view).toEqual(input)
    }),
  )
})

describe("coerceAsync — container peeling", () => {
  it.effect("Effect<string> → coerce the inner value", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Effect.succeed("from effect"))
      expect(view).toEqual(View.Text({ value: "from effect" }))
    }),
  )

  it.effect("Effect<Effect<string>> → recursively unwrap", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Effect.succeed(Effect.succeed("nested")))
      expect(view).toEqual(View.Text({ value: "nested" }))
    }),
  )

  it.effect("Option.none → Empty", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Option.none())
      expect(view).toEqual(View.Empty())
    }),
  )

  it.effect("Option.some(x) → coerce x", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Option.some("inner"))
      expect(view).toEqual(View.Text({ value: "inner" }))
    }),
  )

  it.effect("Result failure → Empty", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Result.fail("nope"))
      expect(view).toEqual(View.Empty())
    }),
  )

  it.effect("Result success → coerce inner", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Result.succeed("ok"))
      expect(view).toEqual(View.Text({ value: "ok" }))
    }),
  )

  it.effect("Array → Fragment of coerced children", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(["a", 1, null])
      expect(view).toEqual(
        View.Fragment({
          children: [
            View.Text({ value: "a" }),
            View.Text({ value: "1" }),
            View.Empty(),
          ],
        }),
      )
    }),
  )

  it.effect("Chunk → Fragment of coerced children", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync(Chunk.fromIterable(["a", "b"]))
      expect(view).toEqual(
        View.Fragment({
          children: [View.Text({ value: "a" }), View.Text({ value: "b" })],
        }),
      )
    }),
  )
})

describe("coerceAsync — reactive sources", () => {
  // Reactive nodes also capture the ambient context (for re-renders under a
  // mid-tree provide), so assert the tag + source rather than deep equality.
  it.effect("AtomRef → View.Reactive carrying the ref", () =>
    Effect.gen(function* () {
      const ref = AtomRef.make("hello")
      const view = yield* coerceAsync(ref)
      expect(view._tag).toBe("Reactive")
      expect((view as View & { _tag: "Reactive" }).source).toBe(ref)
      expect((view as View & { _tag: "Reactive" }).context).toBeDefined()
    }),
  )

  it.effect(
    "Atom → View.Reactive carrying the atom (and the context capture)",
    () =>
      Effect.gen(function* () {
        const atom = Atom.make("hello")
        const view = yield* coerceAsync(atom)
        expect(view._tag).toBe("Reactive")
        expect((view as View & { _tag: "Reactive" }).source).toBe(atom)
        // Pin the capture on the Atom branch too — dropping it would pass the
        // rest of the suite (the mid-tree rebuild test uses an AtomRef slot)
        // while Atom-sourced subtrees silently rebuilt on the root context.
        expect((view as View & { _tag: "Reactive" }).context).toBeDefined()
      }),
  )
})

describe("coerceAsync — unknown fallback", () => {
  it.effect("plain object → View.Text via String()", () =>
    Effect.gen(function* () {
      const view = yield* coerceAsync({ toString: () => "obj!" })
      expect(view).toEqual(View.Text({ value: "obj!" }))
    }),
  )
})

describe("isHandlerKey — runtime side of the key-gate parity matrix", () => {
  // The type side lives in types/Fold.test-d.ts (cases 22/24): the fold's
  // `on${string}` minus bare "on" must accept/reject exactly what this
  // predicate does. If either side changes, both tables must move together.
  it("matches on* keys of length > 2, rejects everything else", () => {
    expect(isHandlerKey("onclick")).toBe(true)
    expect(isHandlerKey("onx")).toBe(true) // minimum handler key: three chars
    expect(isHandlerKey("onCustomSave")).toBe(true)
    expect(isHandlerKey("on")).toBe(false) // bare "on" — type fold excludes it too
    expect(isHandlerKey("o")).toBe(false)
    expect(isHandlerKey("click")).toBe(false)
    expect(isHandlerKey("once")).toBe(true) // on* shape — folds AND attaches (parity, even if odd)
  })
})

describe("coerceSync — primitives + View pass-through", () => {
  it.effect("string → View.Text", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync("hi", scope, sink, runSync)).toEqual(
        View.Text({ value: "hi" }),
      )
    }),
  )

  it.effect("number → View.Text via String()", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync(42, scope, sink, runSync)).toEqual(
        View.Text({ value: "42" }),
      )
    }),
  )

  it.effect("bigint → View.Text via String()", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync(7n, scope, sink, runSync)).toEqual(
        View.Text({ value: "7" }),
      )
    }),
  )

  it.effect.each([null, undefined, true, false])("%s → View.Empty", (v) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync(v, scope, sink, runSync)).toEqual(View.Empty())
    }),
  )

  it.effect("View → pass through", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const input = View.Text({ value: "v" })
      expect(coerceSync(input, scope, sink, runSync)).toEqual(input)
    }),
  )
})

describe("coerceSync — Effect handling", () => {
  it.effect("Effect.succeed(string) → coerce inner synchronously", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync(Effect.succeed("ok"), scope, sink, runSync)).toEqual(
        View.Text({ value: "ok" }),
      )
    }),
  )

  it.effect("Effect that requires Scope: runs with provided scope", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const eff = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.void)
        return "scoped"
      })
      expect(coerceSync(eff, scope, sink, runSync)).toEqual(
        View.Text({ value: "scoped" }),
      )
    }),
  )

  it.effect(
    "Effect that fails synchronously → routes Cause to sink, renders Empty",
    () =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const caught: Array<Cause.Cause<unknown>> = []
        const result = coerceSync(
          Effect.fail("boom"),
          scope,
          (c) => caught.push(c),
          runSync,
        )
        // No longer stringified into the DOM as `[effect failed: …]`.
        expect(result).toEqual(View.Empty())
        expect(caught).toHaveLength(1)
        expect(Cause.squash(caught[0]!)).toBe("boom")
      }),
  )

  it.effect("interrupted Effect (teardown) → NOT routed, renders Empty", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const caught: Array<Cause.Cause<unknown>> = []
      // A pure-interrupt cause is a scope tearing down mid-render, not an error.
      const result = coerceSync(
        Effect.interrupt,
        scope,
        (c) => caught.push(c),
        runSync,
      )
      expect(result).toEqual(View.Empty())
      expect(caught).toHaveLength(0)
    }),
  )
})

describe("coerceSync — Array → Fragment", () => {
  it.effect("array of primitives", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(coerceSync(["a", 1, null], scope, sink, runSync)).toEqual(
        View.Fragment({
          children: [
            View.Text({ value: "a" }),
            View.Text({ value: "1" }),
            View.Empty(),
          ],
        }),
      )
    }),
  )
})

describe("coerceSync — unknown fallback (String())", () => {
  it.effect("plain object → View.Text via String()", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      expect(
        coerceSync({ toString: () => "obj!" }, scope, sink, runSync),
      ).toEqual(View.Text({ value: "obj!" }))
    }),
  )
})

describe("coerceSync — asymmetry (does NOT peel async-only containers)", () => {
  // These tests pin the design decision: sync mode handles only the shapes
  // that can be emitted from a Reactive source at render-time. Containers
  // like Option/Result/Atom/AtomRef would require subscribing or unwrapping
  // an Effect, neither of which is appropriate inside the sync render path.

  it.effect("Option.some(x) → String() fallback, not unwrap", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const result = coerceSync(Option.some("inner"), scope, sink, runSync)
      expect(result._tag).toBe("Text")
      expect((result as { value: string }).value).not.toBe("inner")
    }),
  )

  it.effect("Result.succeed(x) → String() fallback, not unwrap", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const result = coerceSync(Result.succeed("inner"), scope, sink, runSync)
      expect(result._tag).toBe("Text")
      expect((result as { value: string }).value).not.toBe("inner")
    }),
  )

  it.effect("AtomRef → String() fallback, not View.Reactive", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const ref = AtomRef.make("x")
      const result = coerceSync(ref, scope, sink, runSync)
      expect(result._tag).toBe("Text")
    }),
  )

  it.effect("Chunk → String() fallback, not Fragment", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const result = coerceSync(
        Chunk.fromIterable(["a", "b"]),
        scope,
        sink,
        runSync,
      )
      expect(result._tag).toBe("Text")
    }),
  )
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
