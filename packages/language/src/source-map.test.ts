import { describe, expect, it } from "vitest"
import { transformEfx } from "@efx/compiler"
import { convertSourceMap } from "./source-map.ts"

/**
 * Tests for `convertSourceMap`. Each test runs the full pipeline (`transformEfx`
 * → `convertSourceMap`) and asserts on the resulting Volar `Mapping<CodeInformation>[]`.
 *
 * The point of these tests is to lock in the bidirectional position-mapping
 * contract: every Babel transform that shifts byte counts (paren strip on
 * single-arg arrows, `.value` → `h.read(x)`, bare-test → `h.peek(id)`, etc.)
 * produces mappings where source and generated lengths can differ. If we ever
 * lose track of that asymmetry, inlay-hint / hover / go-to-def positions
 * silently drift in the editor — PR #12 was one such regression.
 */

const buildMappings = (src: string) => {
  const result = transformEfx(src, "test.efx")
  const mappings = convertSourceMap(result.map, src, result.code, result.jsxRanges)
  return { code: result.code, mappings }
}

const findBySourceOffset = (
  mappings: ReturnType<typeof buildMappings>["mappings"],
  offset: number,
) => mappings.find((m) => m.sourceOffsets[0] === offset)

describe("convertSourceMap — span lengths", () => {
  it("every mapping carries both source and generated lengths", () => {
    const src = `const x = <div class="page">hi</div>`
    const { mappings } = buildMappings(src)
    expect(mappings.length).toBeGreaterThan(0)
    for (const m of mappings) {
      expect(m.lengths).toHaveLength(1)
      expect(m.generatedLengths).toBeDefined()
      expect(m.generatedLengths).toHaveLength(1)
    }
  })

  it("single-arg arrow: source `((` (2 chars) maps to generated `(` (1 char)", () => {
    // Regression test for PR #12: Babel strips parens on single-arg arrows so
    // `(n) =>` compiles to `n =>`. The source mapping covering the outer `((`
    // (function-call paren + arrow paren) has 2 source chars but only 1
    // generated char. Without distinct generatedLengths, Volar over-claims
    // generated territory and inlay-hint positions drift one column left.
    const src = `const f = () => count.update((n) => n + 1)`
    const { code, mappings } = buildMappings(src)
    // Sanity: Babel actually does strip the paren
    expect(code).toContain("count.update(n => n + 1)")
    expect(code).not.toContain("update((n)")

    // The outer-paren mapping starts at the position of `update(`'s `(` — the
    // src `(` that survives into generated. Its source length extends to the
    // next mapping (the `n`), which is 2 chars away (covering `((`).
    const outerParenSrc = src.indexOf("update(") + "update".length
    const m = findBySourceOffset(mappings, outerParenSrc)
    expect(m, "expected a mapping at the outer `(` source position").toBeDefined()
    expect(m!.lengths[0], "source span covers `((`").toBe(2)
    expect(m!.generatedLengths![0], "generated span covers only `(`").toBe(1)
  })

  it(".value rewrite: source `x.value` (7 chars) → generated `h.read(x)` (9 chars)", () => {
    // `x.value` access inside JSX gets rewritten to `h.read(x)`. The compiler
    // copies the source loc of the original MemberExpression onto the emitted
    // CallExpression — so the mapping at the start of `x` covers source span
    // for the original read, generated span for the `h.read(...)` call.
    const src = `import { AtomRef } from "effect/unstable/reactivity"
const x = AtomRef.make(0)
const view = <div>{x.value}</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain("h.read(x)")
    // The source `x.value` is at known position; assert SOMETHING maps to the
    // generated `h.read` region. The exact mapping shape depends on Babel's
    // codegen so we just check the structure rather than exact bytes.
    const xValueSrc = src.indexOf("{x.value}") + 1
    const generatedHRead = code.indexOf("h.read(x)")
    // There should be at least one mapping whose source offset falls within
    // x.value and whose generated offset falls within h.read(x).
    const intersecting = mappings.filter(
      (m) =>
        m.sourceOffsets[0]! >= xValueSrc - 1 &&
        m.sourceOffsets[0]! <= xValueSrc + 7 &&
        m.generatedOffsets[0]! >= generatedHRead &&
        m.generatedOffsets[0]! <= generatedHRead + 9,
    )
    expect(intersecting.length).toBeGreaterThan(0)
  })

  it("bare-test rewrite: `{cond ? a : b}` → `h.peek(cond) ? a : b` adds 8 generated chars before `cond`", () => {
    // The `cond` identifier in test position gets wrapped: `cond` → `h.peek(cond)`.
    // The source `cond` (4 chars) keeps a mapping; the inserted prefix `h.peek(`
    // and suffix `)` have no source counterpart, but together with the wrap
    // they create a region where generated length > source length.
    const src = `const cond = true
const a = "a"
const b = "b"
const view = <div>{cond ? a : b}</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain("h.peek(cond)")
    // The mapping at source `cond` (inside the ternary test) should exist and
    // have a sensible shape.
    const condTestSrc = src.indexOf("{cond ?") + 1
    const m = findBySourceOffset(mappings, condTestSrc)
    expect(m, "expected a mapping at the test-position `cond`").toBeDefined()
    expect(m!.lengths[0], "source length covers `cond`").toBeGreaterThanOrEqual(1)
    expect(m!.generatedLengths![0]).toBeDefined()
  })

  it("h.track wrap: source JSX expression becomes h.track(() => <expr>)", () => {
    // When something inside a JSX expression got rewritten, the whole expression
    // wraps in `h.track(() => ...)`. The source expression range and the
    // generated wrapped range have different lengths.
    const src = `import { AtomRef } from "effect/unstable/reactivity"
const x = AtomRef.make(0)
const view = <div>{x.value + 1}</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain("h.track(")
    // The wrap region exists; we just verify the mapping array is well-formed
    // around the JSX expression container.
    const exprSrc = src.indexOf("{x.value + 1}") + 1
    const exprMappings = mappings.filter(
      (m) => m.sourceOffsets[0]! >= exprSrc - 1 && m.sourceOffsets[0]! <= exprSrc + 12,
    )
    expect(exprMappings.length).toBeGreaterThan(0)
    for (const m of exprMappings) {
      expect(m.generatedLengths![0]).toBeDefined()
      expect(m.generatedLengths![0]).toBeGreaterThanOrEqual(0)
    }
  })

  it("intrinsic tag span: source `<div>` (5 chars) ≠ generated `h(\"div\",` (8 chars)", () => {
    const src = `const x = <div>hi</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain('h("div"')
    // Some mapping in the tag region should reflect the asymmetry. Find a
    // mapping covering the `<div>` source area.
    const tagSrc = src.indexOf("<div>")
    const tagMappings = mappings.filter(
      (m) => m.sourceOffsets[0]! >= tagSrc && m.sourceOffsets[0]! <= tagSrc + 5,
    )
    expect(tagMappings.length).toBeGreaterThan(0)
    // At least one mapping in this span has source.length !== generated.length
    // (because JSX→h() is structurally different in size).
    const asymmetric = tagMappings.filter(
      (m) => m.lengths[0] !== m.generatedLengths![0],
    )
    expect(asymmetric.length).toBeGreaterThan(0)
  })
})

describe("convertSourceMap — structural cases", () => {
  it("spread attribute: source `{...props}` maps into the h() call", () => {
    const src = `const x = <div {...props}>hi</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toMatch(/h\("div",\s*\{\s*\.\.\.props\s*\}/)
    const spreadSrc = src.indexOf("{...props}")
    const region = mappings.filter(
      (m) => m.sourceOffsets[0]! >= spreadSrc && m.sourceOffsets[0]! < spreadSrc + 10,
    )
    expect(region.length).toBeGreaterThan(0)
    for (const m of region) {
      expect(m.generatedLengths![0]).toBeDefined()
    }
  })

  it("multi-line JSX: mappings span line boundaries cleanly", () => {
    const src = `const view = (
  <div>
    <span>hi</span>
  </div>
)`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain('h("div"')
    expect(code).toContain('h("span"')
    // Every mapping has a non-negative offset within the source.
    for (const m of mappings) {
      expect(m.sourceOffsets[0]).toBeGreaterThanOrEqual(0)
      expect(m.sourceOffsets[0]).toBeLessThanOrEqual(src.length)
    }
    // No two mappings claim the exact same source offset (we dedupe).
    const seen = new Set<number>()
    for (const m of mappings) {
      const off = m.sourceOffsets[0]!
      expect(seen.has(off), `duplicate mapping at source offset ${off}`).toBe(false)
      seen.add(off)
    }
  })

  it("fragment <>...</>: mappings exist for the fragment tags", () => {
    const src = `const view = <>hello</>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain("Fragment")
    // The opening `<>` is at the start.
    const openSrc = src.indexOf("<>")
    expect(mappings.some((m) => m.sourceOffsets[0]! >= openSrc && m.sourceOffsets[0]! <= openSrc + 2)).toBe(true)
  })

  it("member-expression tag: <X.Y>...</X.Y> emits h(X.Y, ...)", () => {
    const src = `import * as M from "./mod"
const view = <M.X />`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain("h(M.X")
    // The `M.X` source identifiers map into the h(M.X, ...) call.
    const mSrc = src.indexOf("<M.X") + 1
    expect(mappings.some((m) => m.sourceOffsets[0] === mSrc)).toBe(true)
  })

  it("auto-injected import line has no overlap with user code mappings", () => {
    // The compiler injects `import { h } from "@efx/runtime"` for files using JSX.
    // That insertion shouldn't claim source territory that belongs to user code.
    const src = `const view = <div>hi</div>`
    const { code, mappings } = buildMappings(src)
    expect(code).toContain('import { h }')
    // Find user-code source positions: every char in `src`. Each should be
    // covered by at most one mapping (no overlap).
    for (let i = 0; i < src.length; i++) {
      const containing = mappings.filter(
        (m) => i >= m.sourceOffsets[0]! && i < m.sourceOffsets[0]! + m.lengths[0]!,
      )
      expect(containing.length, `source offset ${i} claimed by ${containing.length} mappings`).toBeLessThanOrEqual(1)
    }
  })

  it("no JSX in file: mappings still produced from passthrough source map", () => {
    const src = `export const x = 42
export const y = "hello"`
    const { code, mappings } = buildMappings(src)
    // With no JSX, the compiler doesn't inject anything; code is mostly source.
    expect(code).toContain("export const x = 42")
    expect(mappings.length).toBeGreaterThan(0)
    for (const m of mappings) {
      expect(m.generatedLengths![0]).toBeDefined()
    }
  })
})

describe("convertSourceMap — CodeInformation profiles", () => {
  it("JSX angle brackets get the structural-only profile (no navigation)", () => {
    const src = `const x = <div>hi</div>`
    const { mappings } = buildMappings(src)
    // Find the mapping for `<` (the opening angle bracket).
    const ltSrc = src.indexOf("<div")
    const m = findBySourceOffset(mappings, ltSrc)
    expect(m, "expected a mapping at the opening `<`").toBeDefined()
    // structuralOnlyData: navigation: false, semantic: false, completion: false.
    expect(m!.data.navigation, "`<` should not navigate").toBe(false)
    expect(m!.data.semantic, "`<` should not have semantic features").toBe(false)
  })

  it("normal source code outside JSX gets the full profile", () => {
    const src = `const x = 1
const view = <div>hi</div>`
    const { mappings } = buildMappings(src)
    // The `const` keyword on line 1 is outside any JSX node.
    const constSrc = src.indexOf("const x")
    const m = findBySourceOffset(mappings, constSrc)
    expect(m, "expected a mapping at top-level `const`").toBeDefined()
    expect(m!.data.navigation).not.toBe(false)
    expect(m!.data.semantic).not.toBe(false)
  })
})
