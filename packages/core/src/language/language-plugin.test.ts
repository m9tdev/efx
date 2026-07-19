import { describe, expect, it } from "vitest"
import type * as ts from "typescript"
import { createVerrexLanguagePlugin } from "./language-plugin.ts"
import { VerrexVirtualCode } from "./virtual-code.ts"

/**
 * The transform-error contract: editor hosts recompile on every keystroke
 * over routinely-unparseable source, and Babel hard-throws on the common
 * mid-edit states (`foo.` at EOF, an unterminated tag) even with
 * errorRecovery. The plugin must absorb that — degrade to the file's last
 * good compile (or an empty module), never let the throw reach tsserver —
 * except in "throw" mode, where batch hosts (verrex-check) need the failure
 * loud.
 */

const GOOD = `export const greeting: string = "hello"\n`
const GOOD_V2 = `export const farewell: string = "bye"\n`
// Unexpected EOF after `.` — fatal for Babel even with errorRecovery.
const BROKEN = `export const greeting = something.\n`

const snapshotOf = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

const plugin = () => createVerrexLanguagePlugin<string>((scriptId) => scriptId)

const compile = (
  p: ReturnType<typeof plugin>,
  fileName: string,
  source: string,
) =>
  p.createVirtualCode!(fileName, "verrex", snapshotOf(source), {
    getAssociatedScript: () => undefined,
  })

describe("createVerrexLanguagePlugin transform-error recovery", () => {
  it("compiles parseable source (sanity)", () => {
    const code = compile(plugin(), "/a.vx", GOOD)
    expect(code).toBeInstanceOf(VerrexVirtualCode)
    expect((code as VerrexVirtualCode).compiled).toContain("greeting")
  })

  it("falls back to an empty module when the file never compiled", () => {
    const code = compile(plugin(), "/a.vx", BROKEN) as VerrexVirtualCode
    expect(code).toBeInstanceOf(VerrexVirtualCode)
    expect(code.compiled).toBe("export {}\n")
    expect(code.mappings).toEqual([])
  })

  it("serves the last good compile while the source is unparseable", () => {
    const p = plugin()
    compile(p, "/a.vx", GOOD)
    const code = compile(p, "/a.vx", BROKEN) as VerrexVirtualCode
    expect(code.compiled).toContain("greeting")
    // The virtual code still carries the CURRENT (broken) source text.
    expect(code.source).toBe(BROKEN)
    // jsxRanges are never served stale: the ts-plugin reads them directly
    // off the instance (tag-pair highlights), bypassing the mapping gates.
    expect(code.jsxRanges).toEqual([])
  })

  it("evicts the last-good entry when Volar disposes the script", () => {
    const p = plugin()
    const good = compile(p, "/a.vx", GOOD) as VerrexVirtualCode
    p.disposeVirtualCode!("/a.vx", good)
    const code = compile(p, "/a.vx", BROKEN) as VerrexVirtualCode
    // A recreated path with unparseable content must not be served the dead
    // file's exports.
    expect(code.compiled).toBe("export {}\n")
  })

  it("degrades fallback mappings to completion-only", () => {
    const p = plugin()
    const good = compile(p, "/a.vx", GOOD) as VerrexVirtualCode
    expect(good.mappings.length).toBeGreaterThan(0)
    const fallback = compile(p, "/a.vx", BROKEN) as VerrexVirtualCode
    expect(fallback.mappings.length).toBe(good.mappings.length)
    for (const mapping of fallback.mappings) {
      // Stale offsets must not decorate (inlay hints, diagnostics) or write
      // (rename, format); completions stay on — they're the point of
      // surviving mid-edit states.
      expect(mapping.data.completion).toBe(true)
      expect(mapping.data.semantic).toBe(false)
      expect(mapping.data.verification).toBe(false)
      expect(mapping.data.navigation).toBe(false)
      expect(mapping.data.format).toBe(false)
    }
    // The good compile's own mappings are untouched (no shared mutation).
    expect(
      good.mappings.some((mapping) => mapping.data.semantic !== false),
    ).toBe(true)
  })

  it("recompiles fresh once the source parses again", () => {
    const p = plugin()
    compile(p, "/a.vx", GOOD)
    compile(p, "/a.vx", BROKEN)
    const code = compile(p, "/a.vx", GOOD_V2) as VerrexVirtualCode
    expect(code.compiled).toContain("farewell")
    // And the new compile becomes the fallback.
    const again = compile(p, "/a.vx", BROKEN) as VerrexVirtualCode
    expect(again.compiled).toContain("farewell")
  })

  it("keeps last-good compiles per file", () => {
    const p = plugin()
    compile(p, "/a.vx", GOOD)
    const code = compile(p, "/b.vx", BROKEN) as VerrexVirtualCode
    expect(code.compiled).toBe("export {}\n")
  })

  it('"throw" mode propagates with the file named, for batch hosts', () => {
    const p = createVerrexLanguagePlugin<string>((scriptId) => scriptId, {
      onTransformError: "throw",
    })
    compile(p, "/a.vx", GOOD)
    // Babel's message carries only line:col; batch hosts print this verbatim,
    // so the file must be named.
    expect(() => compile(p, "/a.vx", BROKEN)).toThrow(
      /\/a\.vx: Unexpected token/,
    )
  })
})
