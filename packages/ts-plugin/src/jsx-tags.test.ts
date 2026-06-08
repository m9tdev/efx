import { describe, expect, it } from "vitest"
import type { JsxRange } from "@verrex/core/language"
import { findJsxTagPair, type JsxTagProvider } from "./jsx-tags.ts"

const mockProvider = (ranges: ReadonlyArray<JsxRange>): JsxTagProvider => ({
  getJsxRanges: () => ranges,
})

describe("findJsxTagPair", () => {
  it("returns null when provider has no ranges for the file", () => {
    const provider: JsxTagProvider = { getJsxRanges: () => undefined }
    expect(findJsxTagPair(provider, "test.vx", 5)).toBeNull()
  })

  it("returns null for empty ranges", () => {
    const provider = mockProvider([])
    expect(findJsxTagPair(provider, "test.vx", 5)).toBeNull()
  })

  it("skips fragments (no name to highlight)", () => {
    const provider = mockProvider([
      {
        kind: "fragment",
        start: 0,
        end: 20,
        openingTag: { start: 0, end: 2 },
        closingTag: { start: 17, end: 20 },
      },
    ])
    expect(findJsxTagPair(provider, "test.vx", 1)).toBeNull()
  })

  it("returns tag pair when cursor is on opening tag name", () => {
    // <div>...</div>
    // 01234    ^cursor on 'd'
    const provider = mockProvider([
      {
        kind: "element",
        start: 0,
        end: 14,
        isSelfClosing: false,
        openingTag: { start: 0, end: 5, nameStart: 1, nameEnd: 4 },
        closingTag: { start: 8, end: 14, nameStart: 10, nameEnd: 13 },
      },
    ])
    const result = findJsxTagPair(provider, "test.vx", 1)
    expect(result).toEqual({
      current: { start: 1, length: 3 },
      partner: { start: 10, length: 3 },
    })
  })

  it("returns tag pair when cursor is on closing tag", () => {
    const provider = mockProvider([
      {
        kind: "element",
        start: 0,
        end: 14,
        isSelfClosing: false,
        openingTag: { start: 0, end: 5, nameStart: 1, nameEnd: 4 },
        closingTag: { start: 8, end: 14, nameStart: 10, nameEnd: 13 },
      },
    ])
    const result = findJsxTagPair(provider, "test.vx", 10)
    expect(result).toEqual({
      current: { start: 10, length: 3 },
      partner: { start: 1, length: 3 },
    })
  })

  it("returns null for self-closing tags (no partner)", () => {
    // <div />
    const provider = mockProvider([
      {
        kind: "element",
        start: 0,
        end: 7,
        isSelfClosing: true,
        openingTag: { start: 0, end: 7, nameStart: 1, nameEnd: 4 },
      },
    ])
    expect(findJsxTagPair(provider, "test.vx", 1)).toBeNull()
  })

  it("returns null when cursor is on attributes (not tag name or brackets)", () => {
    // <div class="x">
    // 0123456789...
    // attributes start at 5, end before the >
    const provider = mockProvider([
      {
        kind: "element",
        start: 0,
        end: 25,
        isSelfClosing: false,
        openingTag: { start: 0, end: 15, nameStart: 1, nameEnd: 4 },
        closingTag: { start: 18, end: 25, nameStart: 20, nameEnd: 23 },
      },
    ])
    // Position 6 is in "class" attribute area
    expect(findJsxTagPair(provider, "test.vx", 6)).toBeNull()
  })

  it("returns tag pair when cursor is on opening bracket <", () => {
    const provider = mockProvider([
      {
        kind: "element",
        start: 0,
        end: 14,
        isSelfClosing: false,
        openingTag: { start: 0, end: 5, nameStart: 1, nameEnd: 4 },
        closingTag: { start: 8, end: 14, nameStart: 10, nameEnd: 13 },
      },
    ])
    const result = findJsxTagPair(provider, "test.vx", 0)
    expect(result).toEqual({
      current: { start: 1, length: 3 },
      partner: { start: 10, length: 3 },
    })
  })
})
