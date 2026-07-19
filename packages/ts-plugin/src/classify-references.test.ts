import { describe, expect, it } from "vitest"
import type * as ts from "typescript"
import {
  classifyRefs,
  dedupeRefs,
  refKey,
  sortClassifiedRefs,
  type ClassifiedRef,
} from "./classify-references.ts"

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

describe("refKey", () => {
  it("combines file path and start offset", () => {
    expect(refKey({ fileName: "a.ts", textSpan: span(42) })).toBe("a.ts:42")
  })

  it("distinguishes same offset in different files and different offsets", () => {
    expect(refKey({ fileName: "a.ts", textSpan: span(1) })).not.toBe(
      refKey({ fileName: "b.ts", textSpan: span(1) }),
    )
    expect(refKey({ fileName: "a.ts", textSpan: span(1) })).not.toBe(
      refKey({ fileName: "a.ts", textSpan: span(2) }),
    )
  })
})

describe("dedupeRefs", () => {
  it("drops same-(file,start) duplicates, keeping first-seen order", () => {
    const refs = [
      { fileName: "a.ts", textSpan: span(10) },
      { fileName: "a.ts", textSpan: span(20) },
      { fileName: "a.ts", textSpan: span(10) }, // dup of #0
      { fileName: "b.ts", textSpan: span(10) }, // same start, other file → kept
    ]
    const out = dedupeRefs(refs)
    expect(out.map(refKey)).toEqual(["a.ts:10", "a.ts:20", "b.ts:10"])
  })

  it("dedupes by start only, ignoring length", () => {
    const out = dedupeRefs([
      { fileName: "a.ts", textSpan: span(5, 1) },
      { fileName: "a.ts", textSpan: span(5, 99) },
    ])
    expect(out).toHaveLength(1)
  })
})

describe("sortClassifiedRefs", () => {
  const mk = (
    id: string,
    isDef: boolean,
    isImport: boolean,
  ): ClassifiedRef<string> => ({
    ref: id,
    isDef,
    isImport,
  })

  it("orders definition first, then usages, then imports last", () => {
    const sorted = sortClassifiedRefs([
      mk("import1", false, true),
      mk("usage1", false, false),
      mk("def", true, false),
      mk("import2", false, true),
      mk("usage2", false, false),
    ])
    expect(sorted.map((c) => c.ref)).toEqual([
      "def",
      "usage1",
      "usage2",
      "import1",
      "import2",
    ])
  })

  it("is stable within the usage tier (preserves input order)", () => {
    const sorted = sortClassifiedRefs([
      mk("u1", false, false),
      mk("u2", false, false),
      mk("u3", false, false),
    ])
    expect(sorted.map((c) => c.ref)).toEqual(["u1", "u2", "u3"])
  })

  it("does not mutate the input array", () => {
    const input = [mk("import1", false, true), mk("def", true, false)]
    const snapshot = input.map((c) => c.ref)
    sortClassifiedRefs(input)
    expect(input.map((c) => c.ref)).toEqual(snapshot)
  })
})
