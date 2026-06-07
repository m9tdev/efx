import { describe, expect, it } from "vitest"
import { transformVerrex } from "./transform.ts"
import type { CompilerMapping } from "./source-map.ts"

/**
 * Tests for the compiler's `mappings` output (typed source↔generated spans).
 *
 * `verrex/language`'s `src/source-map.test.ts` covers the same ground but goes
 * through the Volar-shaped `Mapping<CodeInformation>[]` translation. These
 * tests assert on the compiler's typed shape directly — they protect the
 * contract any Volar-agnostic consumer would depend on.
 */

const compile = (src: string) => transformVerrex(src, "test.vx")

const findBySourceOffset = (
  mappings: ReadonlyArray<CompilerMapping>,
  offset: number,
) => mappings.find((m) => m.source.offset === offset)

describe("transformVerrex — mappings shape", () => {
  it("every mapping carries source and generated lengths plus a kind", () => {
    const result = compile(`
      const x = <div class="page">hi</div>
    `)
    expect(result.mappings.length).toBeGreaterThan(0)
    for (const m of result.mappings) {
      expect(typeof m.source.offset).toBe("number")
      expect(typeof m.source.length).toBe("number")
      expect(typeof m.generated.offset).toBe("number")
      expect(typeof m.generated.length).toBe("number")
      expect(["user", "h-call", "punctuation"]).toContain(m.kind)
    }
  })

  it("single-arg arrow paren strip: source `((` (2 chars) → generated `(` (1 char)", () => {
    // PR #12 regression: Babel strips parens on single-arg arrows so
    // `(n) =>` compiles to `n =>`. The source mapping covering `((` (the
    // function-call paren + arrow paren) has source length 2 but generated
    // length 1. Without this, downstream consumers over-claim generated
    // territory and inlay-hint positions drift.
    const src = `
      const f = () => count.update((n) => n + 1)
    `
    const result = compile(src)
    expect(result.code).toContain("count.update(n => n + 1)")

    const outerParenSrc = src.indexOf("update(") + "update".length
    const m = findBySourceOffset(result.mappings, outerParenSrc)
    expect(m).toBeDefined()
    expect(m!.source.length, "covers source `((`").toBe(2)
    expect(m!.generated.length, "covers generated `(`").toBe(1)
  })

  it("source positions are not duplicated (dedup by source offset)", () => {
    const src = `
      const view = <div><span>x</span></div>
    `
    const result = compile(src)
    const seen = new Set<number>()
    for (const m of result.mappings) {
      expect(seen.has(m.source.offset), `duplicate at offset ${m.source.offset}`).toBe(false)
      seen.add(m.source.offset)
    }
  })

  it("user source positions are covered by at most one mapping (no overlap)", () => {
    const src = `
      const view = <div>hi</div>
    `
    const result = compile(src)
    for (let i = 0; i < src.length; i++) {
      const containing = result.mappings.filter(
        (m) => i >= m.source.offset && i < m.source.offset + m.source.length,
      )
      expect(containing.length, `offset ${i} claimed by ${containing.length}`).toBeLessThanOrEqual(1)
    }
  })

  it("mappings are sorted by source offset", () => {
    const src = `
      const view = <div><span>x</span></div>
    `
    const result = compile(src)
    for (let i = 1; i < result.mappings.length; i++) {
      expect(result.mappings[i]!.source.offset).toBeGreaterThan(result.mappings[i - 1]!.source.offset)
    }
  })
})

describe("transformVerrex — mapping kinds", () => {
  it("JSX angle brackets `<` `>` `/` are classified as punctuation", () => {
    const src = `
      const x = <div>hi</div>
    `
    const result = compile(src)
    const ltSrc = src.indexOf("<div")
    const ltMapping = findBySourceOffset(result.mappings, ltSrc)
    expect(ltMapping?.kind).toBe("punctuation")
  })

  it("positions inside an h() call (JSX-derived) are classified as h-call", () => {
    const src = `
      const x = <div class="page">hi</div>
    `
    const result = compile(src)
    // Find a mapping whose source span sits inside the JSX opening tag.
    // Babel's source map doesn't emit a mapping at every character, so we
    // look up by containment rather than exact match.
    const classSrc = src.indexOf("class")
    const containing = result.mappings.find(
      (m) => m.source.offset <= classSrc && m.source.offset + m.source.length > classSrc,
    )
    expect(containing, "expected a mapping covering the `class` attribute").toBeDefined()
    expect(containing!.kind).toBe("h-call")
  })

  it("normal user code outside JSX is classified as user", () => {
    const src = `
      const x = 1
      const view = <div>hi</div>
    `
    const result = compile(src)
    const constSrc = src.indexOf("const x")
    const m = findBySourceOffset(result.mappings, constSrc)
    expect(m?.kind).toBe("user")
  })

  it("operator `>` inside a JSX expression is NOT punctuation", () => {
    // `{a > b}` inside JSX: the `>` is a JS operator, not JSX angle bracket.
    // The classifier checks for the tag-span containment to disambiguate.
    const src = `
      const a = 1, b = 2
      const view = <div>{a > b ? "yes" : "no"}</div>
    `
    const result = compile(src)
    const gtSrc = src.indexOf("a > b") + 2
    const m = findBySourceOffset(result.mappings, gtSrc)
    // Whether a mapping exists at that exact position depends on Babel's
    // emission, but if one does, it must NOT be classified as punctuation.
    if (m) {
      expect(m.kind).not.toBe("punctuation")
    }
  })
})

describe("transformVerrex — no-source-map cases", () => {
  it("file without JSX produces a single passthrough-ish mapping", () => {
    const src = `
      export const x = 42
    `
    const result = compile(src)
    expect(result.mappings.length).toBeGreaterThan(0)
    // All mappings should be classified as user code (no JSX in source).
    for (const m of result.mappings) {
      expect(m.kind).toBe("user")
    }
  })
})
