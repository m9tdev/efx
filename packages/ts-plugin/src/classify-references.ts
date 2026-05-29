import type * as ts from "typescript"

/**
 * One pass over the refs to decide "where does each one sit?" — definition,
 * usage, or import line. `findReferences` then sorts on the precomputed
 * booleans instead of re-reading source files inside the sort comparator
 * (which was O(N log N) reads of M files for N refs across M files).
 *
 * `readFile` is injected so tests can run without disk I/O. The local
 * `fileCache` collapses repeat reads of the same file *within a single
 * call* to one; cross-call caching is intentionally out of scope because
 * files change between language-service requests.
 */
export type ClassifiedRef<R> = {
  readonly ref: R
  readonly isDef: boolean
  readonly isImport: boolean
}

/**
 * Identity key for a reference: file path + start offset. The single
 * definition of "these two reference hits are the same one" — both reference
 * handlers in `service-proxy.ts` dedupe with this. They iterate different
 * shapes (a flat `ReferenceEntry[]` vs the flattened nested
 * `ReferencedSymbol[]`), so they share the key formula, not the loop.
 */
export const refKey = (ref: { fileName: string; textSpan: ts.TextSpan }): string =>
  `${ref.fileName}:${ref.textSpan.start}`

/** Drop duplicate reference hits (same `refKey`), preserving first-seen order. */
export function dedupeRefs<R extends { fileName: string; textSpan: ts.TextSpan }>(
  refs: ReadonlyArray<R>,
): R[] {
  const seen = new Set<string>()
  const out: R[] = []
  for (const ref of refs) {
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/**
 * Ordering policy for find-references results: definition first, then usages,
 * then imports last. Sorts on the precomputed `isDef`/`isImport` booleans
 * (from `classifyRefs`) so no source re-reads happen in the comparator.
 * Stable for the equal (usage) case — Node's sort preserves input order, so
 * usages keep tsserver's original ordering.
 */
export function sortClassifiedRefs<R>(
  classified: ReadonlyArray<ClassifiedRef<R>>,
): ClassifiedRef<R>[] {
  return [...classified].sort((a, b) => {
    if (a.isDef !== b.isDef) return a.isDef ? -1 : 1
    if (a.isImport !== b.isImport) return a.isImport ? 1 : -1
    return 0
  })
}

export function classifyRefs<R extends { fileName: string; textSpan: ts.TextSpan }>(
  refs: ReadonlyArray<R>,
  def: { fileName: string; textSpan: ts.TextSpan },
  readFile: (path: string) => string | undefined,
): ClassifiedRef<R>[] {
  const fileCache = new Map<string, string | undefined>()
  const readCached = (path: string): string | undefined => {
    if (fileCache.has(path)) return fileCache.get(path)
    const content = readFile(path)
    fileCache.set(path, content)
    return content
  }
  return refs.map((ref) => ({
    ref,
    isDef: ref.fileName === def.fileName && ref.textSpan.start === def.textSpan.start,
    isImport: isImportLine(ref, readCached),
  }))
}

const IMPORT_LINE = /^\s*(import|export\s+\*?\s*from)/

function isImportLine(
  ref: { fileName: string; textSpan: ts.TextSpan },
  readFile: (path: string) => string | undefined,
): boolean {
  const content = readFile(ref.fileName)
  if (!content) return false
  let lineStart = ref.textSpan.start
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--
  const lineEnd = content.indexOf("\n", ref.textSpan.start)
  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  return IMPORT_LINE.test(line)
}
