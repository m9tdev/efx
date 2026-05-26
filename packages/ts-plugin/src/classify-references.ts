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
