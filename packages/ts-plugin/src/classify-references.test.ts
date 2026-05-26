import { describe, expect, it } from "vitest"
import type * as ts from "typescript"
import { classifyRefs } from "./classify-references.ts"

const span = (start: number, length = 1): ts.TextSpan => ({ start, length })

describe("classifyRefs", () => {
  it("flags the definition ref", () => {
    const def = { fileName: "a.ts", textSpan: span(10) }
    const refs = [
      { fileName: "a.ts", textSpan: span(10) },
      { fileName: "a.ts", textSpan: span(50) },
    ]
    const out = classifyRefs(refs, def, () => "")
    expect(out[0]?.isDef).toBe(true)
    expect(out[1]?.isDef).toBe(false)
  })

  it("flags refs whose line starts with `import`", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const content = `import { X } from './x'\nconst y = X()\n`
    const importPos = content.indexOf("X")
    const usagePos = content.indexOf("X", importPos + 1)
    const refs = [
      { fileName: "b.ts", textSpan: span(importPos) },
      { fileName: "b.ts", textSpan: span(usagePos) },
    ]
    const out = classifyRefs(refs, def, () => content)
    expect(out[0]?.isImport).toBe(true)
    expect(out[1]?.isImport).toBe(false)
  })

  it("flags refs whose line starts with `export * from`", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const content = `export * from './foo'\n`
    const pos = content.indexOf("foo")
    const out = classifyRefs(
      [{ fileName: "b.ts", textSpan: span(pos) }],
      def,
      () => content,
    )
    expect(out[0]?.isImport).toBe(true)
  })

  it("reads each file at most once across many refs in the same call", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const fileA = `import { X } from './x'\nconst a = X()\nconst b = X()\n`
    const fileB = `import { Y } from './y'\nconst c = Y()\n`
    const calls: string[] = []
    const readFile = (path: string): string | undefined => {
      calls.push(path)
      if (path === "a.ts") return fileA
      if (path === "b.ts") return fileB
      return undefined
    }
    const refs = [
      { fileName: "a.ts", textSpan: span(fileA.indexOf("X")) },
      { fileName: "a.ts", textSpan: span(fileA.indexOf("X", 30)) },
      { fileName: "a.ts", textSpan: span(fileA.lastIndexOf("X")) },
      { fileName: "b.ts", textSpan: span(fileB.indexOf("Y")) },
      { fileName: "b.ts", textSpan: span(fileB.lastIndexOf("Y")) },
    ]
    classifyRefs(refs, def, readFile)
    expect(calls.sort()).toEqual(["a.ts", "b.ts"])
  })

  it("caches a missing-file lookup too (undefined is a valid cache value)", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const calls: string[] = []
    const readFile = (path: string): string | undefined => {
      calls.push(path)
      return undefined
    }
    const refs = [
      { fileName: "ghost.ts", textSpan: span(0) },
      { fileName: "ghost.ts", textSpan: span(10) },
    ]
    classifyRefs(refs, def, readFile)
    expect(calls).toEqual(["ghost.ts"])
  })

  it("treats refs in unreadable files as non-imports", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const out = classifyRefs(
      [{ fileName: "missing.ts", textSpan: span(0) }],
      def,
      () => undefined,
    )
    expect(out[0]?.isImport).toBe(false)
  })

  it("preserves the original ref identity", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const ref = { fileName: "a.ts", textSpan: span(5) }
    const out = classifyRefs([ref], def, () => "")
    expect(out[0]?.ref).toBe(ref)
  })

  it("handles a ref on the first line (no leading newline before lineStart)", () => {
    const def = { fileName: "a.ts", textSpan: span(0) }
    const content = `import { X } from './x'`
    const refs = [{ fileName: "b.ts", textSpan: span(content.indexOf("X")) }]
    const out = classifyRefs(refs, def, () => content)
    expect(out[0]?.isImport).toBe(true)
  })
})
