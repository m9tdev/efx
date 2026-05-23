/**
 * TypeScript Language Service Plugin for `.efx` files.
 *
 *   tsconfig.json:
 *     "compilerOptions": { "plugins": [{ "name": "@efx/ts-plugin" }] },
 *     "include": ["src/**\/*.ts", "src/**\/*.efx"]
 *
 * What it does:
 *
 *   1. Treats `.efx` files as TypeScript script-kind so tsserver will
 *      type-check them at all.
 *   2. Intercepts file reads for `.efx` files — returns the *compiled*
 *      output of `transformEfx(...)` (no JSX) to tsserver. The user's
 *      generic-inference fold and channel-tracking rewrites are what
 *      tsserver type-checks against.
 *   3. Wraps `getSemanticDiagnostics` / `getSyntacticDiagnostics` /
 *      `getSuggestionDiagnostics` to remap diagnostic positions from the
 *      compiled `.ts` coordinates back into `.efx` coordinates using
 *      Babel's source map. Editors that display `.efx` source see
 *      squiggles at the lines the user actually wrote.
 *
 * Known limit (Layer 1): live in-editor editing of `.efx` files isn't
 * fully supported — tsserver's incremental edit model expects one source
 * of truth per file, and we present compiled output. Cross-file
 * diagnostics (a `.ts` importing a `.efx`) and full-file rechecks work;
 * mid-edit diagnostics may lag a keystroke. Volar-level infrastructure
 * would close that gap.
 */
import * as ts from "typescript/lib/tsserverlibrary"
import { transformEfx } from "@efx/compiler"
import { decode, type SourceMapMappings } from "@jridgewell/sourcemap-codec"

interface Compiled {
  readonly source: string
  readonly compiled: string
  readonly mappings: SourceMapMappings
  readonly compiledLineStarts: ReadonlyArray<number>
  readonly sourceLineStarts: ReadonlyArray<number>
}

const computeLineStarts = (text: string): number[] => {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

const offsetToLineCol = (
  lineStarts: ReadonlyArray<number>,
  offset: number,
): { line: number; col: number } => {
  // Binary search for the largest index with lineStarts[i] <= offset.
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo, col: offset - lineStarts[lo]! }
}

const lineColToOffset = (
  lineStarts: ReadonlyArray<number>,
  line: number,
  col: number,
): number => {
  const start = lineStarts[line] ?? lineStarts[lineStarts.length - 1] ?? 0
  return start + col
}

/**
 * Find the source-side {line, col} for a compiled-side {line, col} by
 * scanning the line's segments for the last one whose generatedColumn is
 * ≤ the queried column.
 */
const findSourcePosition = (
  mappings: SourceMapMappings,
  genLine: number,
  genCol: number,
): { line: number; col: number } | null => {
  const segments = mappings[genLine]
  if (!segments || segments.length === 0) return null
  let best: typeof segments[number] | null = null
  for (const seg of segments) {
    if (seg.length >= 4 && seg[0] <= genCol) best = seg
    else if (seg.length >= 4 && seg[0] > genCol) break
  }
  if (!best || best.length < 4) return null
  return { line: best[2]!, col: best[3]! }
}

const isEfx = (fileName: string): boolean => fileName.endsWith(".efx")

const cache = new Map<string, Compiled>()

const getCompiled = (fileName: string, source: string): Compiled => {
  const cached = cache.get(fileName)
  if (cached && cached.source === source) return cached
  const result = transformEfx(source, fileName)
  const map = result.map as { mappings?: string } | null
  const next: Compiled = {
    source,
    compiled: result.code,
    mappings: map?.mappings ? decode(map.mappings) : [],
    compiledLineStarts: computeLineStarts(result.code),
    sourceLineStarts: computeLineStarts(source),
  }
  cache.set(fileName, next)
  return next
}

/** Map a compiled-side offset back to a source-side offset, or null. */
const mapCompiledOffset = (c: Compiled, compiledOffset: number): number | null => {
  const gen = offsetToLineCol(c.compiledLineStarts, compiledOffset)
  const src = findSourcePosition(c.mappings, gen.line, gen.col)
  if (!src) return null
  return lineColToOffset(c.sourceLineStarts, src.line, src.col)
}

function init(_modules: { typescript: typeof ts }): ts.server.PluginModule {
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const host = info.languageServiceHost
      const ls = info.languageService
      const project = info.project

      const log = (msg: string): void => {
        project?.projectService?.logger?.info?.(`[efx] ${msg}`)
      }
      log("plugin loaded")

      // ── Intercept LanguageServiceHost methods so tsserver sees compiled .efx ──

      const originalReadFile = host.readFile?.bind(host)
      host.readFile = (path: string, encoding?: string): string | undefined => {
        const raw = originalReadFile?.(path, encoding)
        if (raw == null || !isEfx(path)) return raw
        return getCompiled(path, raw).compiled
      }

      const originalGetScriptSnapshot = host.getScriptSnapshot.bind(host)
      host.getScriptSnapshot = (fileName: string): ts.IScriptSnapshot | undefined => {
        if (!isEfx(fileName)) return originalGetScriptSnapshot(fileName)
        const raw = originalReadFile?.(fileName)
        if (raw == null) return undefined
        return ts.ScriptSnapshot.fromString(getCompiled(fileName, raw).compiled)
      }

      const originalGetScriptKind = host.getScriptKind?.bind(host)
      host.getScriptKind = (fileName: string): ts.ScriptKind => {
        if (isEfx(fileName)) return ts.ScriptKind.TS
        return originalGetScriptKind?.(fileName) ?? ts.ScriptKind.Unknown
      }

      // ── Wrap diagnostic methods with sourcemap-based position remap ──

      const remapOne = (d: ts.Diagnostic): ts.Diagnostic => {
        const file = d.file
        if (!file || !isEfx(file.fileName) || typeof d.start !== "number") return d
        const raw = originalReadFile?.(file.fileName)
        if (raw == null) return d
        const c = getCompiled(file.fileName, raw)
        const srcStart = mapCompiledOffset(c, d.start)
        if (srcStart == null) return d
        const srcEnd =
          typeof d.length === "number" && d.length > 0
            ? mapCompiledOffset(c, d.start + d.length) ?? srcStart + 1
            : srcStart + 1
        // Substitute a SourceFile whose text + lineMap are the original
        // .efx source so consumers (LSP, formatters) compute line/col
        // correctly against the user's source.
        const sourceFile = ts.createSourceFile(
          file.fileName,
          c.source,
          ts.ScriptTarget.Latest,
          false,
          ts.ScriptKind.TS,
        )
        return {
          ...d,
          file: sourceFile,
          start: srcStart,
          length: Math.max(1, srcEnd - srcStart),
        }
      }
      const remapAll = (diags: ReadonlyArray<ts.Diagnostic>): Array<ts.Diagnostic> =>
        diags.map(remapOne)

      // Build a proxy that delegates everything to ls but overrides
      // diagnostic methods.
      const proxy = Object.create(null) as ts.LanguageService
      for (const k of Object.keys(ls) as Array<keyof ts.LanguageService>) {
        const v = ls[k]
        if (typeof v === "function") {
          ;(proxy as any)[k] = (v as Function).bind(ls)
        } else {
          ;(proxy as any)[k] = v
        }
      }

      proxy.getSemanticDiagnostics = (fileName) =>
        remapAll(ls.getSemanticDiagnostics(fileName))
      proxy.getSyntacticDiagnostics = (fileName) =>
        remapAll(ls.getSyntacticDiagnostics(fileName)) as Array<ts.DiagnosticWithLocation>
      proxy.getSuggestionDiagnostics = (fileName) =>
        remapAll(ls.getSuggestionDiagnostics(fileName)) as Array<ts.DiagnosticWithLocation>

      return proxy
    },
  }
}

export = init
