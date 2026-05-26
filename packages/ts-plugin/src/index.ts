/**
 * TypeScript Language Service Plugin for `.efx` files using Volar.
 *
 * Uses Volar's language plugin framework to handle:
 * - File discovery via getExternalFiles
 * - Content transformation (.efx → compiled TypeScript)
 * - Position mapping for diagnostics, hover, completions, inlay hints, etc.
 */
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin"
import type { LanguagePlugin, VirtualCode, CodeInformation } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import { transformEfx, type JsxRange } from "@efx/compiler"
import { decode } from "@jridgewell/sourcemap-codec"
import type * as ts from "typescript"

// Volar's typescript property type isn't in the public LanguagePlugin interface
// but is expected by createLanguageServicePlugin
interface TypeScriptConfig {
  extraFileExtensions: Array<{
    extension: string
    isMixedContent: boolean
    scriptKind: ts.ScriptKind
  }>
  getServiceScript(root: VirtualCode): {
    code: VirtualCode
    extension: string
    scriptKind: ts.ScriptKind
  }
}

// Cache for source map data needed to convert compiled offsets to source offsets
interface SourceMapCache {
  readonly source: string
  readonly compiled: string
  readonly mappings: Mapping<CodeInformation>[]
  readonly jsxRanges: ReadonlyArray<JsxRange>
}
const sourceMapCache = new Map<string, SourceMapCache>()

const efxLanguagePlugin: LanguagePlugin<string> & { typescript: TypeScriptConfig } = {
  getLanguageId(scriptId) {
    if (scriptId.endsWith(".efx")) {
      return "efx"
    }
    return undefined
  },

  createVirtualCode(scriptId, languageId, snapshot) {
    if (languageId !== "efx") {
      return undefined
    }

    const source = snapshot.getText(0, snapshot.getLength())
    const result = transformEfx(source, scriptId)
    const compiled = result.code
    const jsxRanges = result.jsxRanges

    // Convert Babel source map to Volar mappings
    const mappings = convertSourceMap(result.map, source, compiled, jsxRanges)

    // Cache source map data for offset conversion in definition results
    sourceMapCache.set(scriptId, { source, compiled, mappings, jsxRanges })

    const virtualCode: VirtualCode = {
      id: "efx-ts",
      languageId: "typescript",
      snapshot: {
        getText: (start, end) => compiled.slice(start, end),
        getLength: () => compiled.length,
        getChangeRange: () => undefined,
      },
      mappings,
      embeddedCodes: [],
    }

    return virtualCode
  },

  typescript: {
    extraFileExtensions: [
      {
        extension: "efx",
        isMixedContent: false,
        scriptKind: 3 as ts.ScriptKind.TS,
      },
    ],

    getServiceScript(root: VirtualCode) {
      return {
        code: root,
        extension: ".ts",
        scriptKind: 3 as ts.ScriptKind.TS,
      }
    },
  },
}

/**
 * Convert Babel's source map format to Volar's Mapping format.
 * Uses compiler-provided jsxRanges to mark JSX-derived positions as non-semantic
 * (suppress inlay hints on h() internals, disable semantic on `<` `>` `/`).
 */
function convertSourceMap(
  map: { mappings?: string } | null | undefined,
  source: string,
  generated: string,
  jsxRanges: ReadonlyArray<JsxRange>,
): Mapping<CodeInformation>[] {
  if (!map?.mappings) {
    // No source map - create a simple 1:1 mapping
    const length = Math.min(source.length, generated.length)
    return [
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [length],
        data: {
          verification: true,
          completion: true,
          semantic: true,
          navigation: true,
          structure: true,
          format: true,
        },
      },
    ]
  }

  const decoded = decode(map.mappings)
  const sourceLineStarts = computeLineStarts(source)
  const generatedLineStarts = computeLineStarts(generated)

  const mappings: Mapping<CodeInformation>[] = []
  const fullData: CodeInformation = {
    verification: true,
    completion: true,
    semantic: true,
    navigation: true,
    structure: true,
    format: true,
  }
  // For h() internals: keep semantic but disable highlights (like Vue does)
  const noHighlightData: CodeInformation = {
    verification: true,
    completion: true,
    semantic: { shouldHighlight: () => false },
    navigation: true,
    structure: true,
    format: true,
  }
  // For JSX punctuation (< > /): these map to h() structure, disable all semantic
  const structuralOnlyData: CodeInformation = {
    verification: true,
    completion: false,
    semantic: false,
    navigation: false, // Don't navigate to h() from <
    structure: true,
    format: true,
  }

  // JSX punctuation characters (`<`, `>`, `/`) only get the structural-only profile
  // when they sit inside an opening/closing tag span — otherwise `{a > b}` inside
  // a JSX expression would false-positive on `>`.
  const jsxPunctuation = new Set(["<", ">", "/"])
  const insideJsxNode = (srcOffset: number): boolean =>
    jsxRanges.some((r) => srcOffset >= r.start && srcOffset < r.end)
  const insideTagPunctuationSpan = (srcOffset: number): boolean =>
    jsxRanges.some((r) => {
      if (srcOffset >= r.openingTag.start && srcOffset < r.openingTag.end) return true
      if (r.closingTag && srcOffset >= r.closingTag.start && srcOffset < r.closingTag.end) return true
      return false
    })

  // Collect all segments, deduplicating by source offset (keep first/best match)
  const segmentsBySource = new Map<number, { genOffset: number; srcOffset: number; srcChar: string }>()
  for (let genLine = 0; genLine < decoded.length; genLine++) {
    const segments = decoded[genLine]
    if (!segments) continue

    for (const segment of segments) {
      if (segment.length < 4) continue

      const [genCol, , srcLine, srcCol] = segment
      if (srcLine === undefined || srcCol === undefined) continue
      const genOffset = lineColToOffset(generatedLineStarts, genLine, genCol)
      const srcOffset = lineColToOffset(sourceLineStarts, srcLine, srcCol)
      const srcChar = source[srcOffset] || ""

      // Only keep the first mapping for each source offset
      if (!segmentsBySource.has(srcOffset)) {
        segmentsBySource.set(srcOffset, { genOffset, srcOffset, srcChar })
      }
    }
  }

  // Sort by source offset for proper length calculation
  const sortedSegments = [...segmentsBySource.values()].sort((a, b) => a.srcOffset - b.srcOffset)

  // Create mappings with lengths extending to next segment
  for (let i = 0; i < sortedSegments.length; i++) {
    const seg = sortedSegments[i]
    const nextSeg = sortedSegments[i + 1]

    // Length in source space: from this offset to the next (or 1 if last)
    const srcLength = nextSeg ? nextSeg.srcOffset - seg.srcOffset : 1

    // Position is JSX-derived if its source offset falls inside any JSX node range.
    const isInHCall = insideJsxNode(seg.srcOffset)

    // JSX punctuation (< > /) — only when actually inside a tag span, not e.g. {a > b}.
    const isJsxPunctuation =
      jsxPunctuation.has(seg.srcChar) && insideTagPunctuationSpan(seg.srcOffset)

    // Choose appropriate CodeInformation:
    // - JSX punctuation: structural only (no semantic, no navigation)
    // - Inside h() call: no highlights but keep other semantic features
    // - Normal code: full features
    let data: CodeInformation
    if (isJsxPunctuation) {
      data = structuralOnlyData
    } else if (isInHCall) {
      data = noHighlightData
    } else {
      data = fullData
    }

    mappings.push({
      sourceOffsets: [seg.srcOffset],
      generatedOffsets: [seg.genOffset],
      lengths: [srcLength],
      data,
    })
  }

  return mappings
}

interface NameSpan {
  readonly start: number
  readonly length: number
}

/**
 * Given a cursor position in a `.efx` source, find the JSX tag at that position
 * and its paired partner (opening↔closing). Returns name spans only; consumers
 * highlight just the names, not the brackets.
 *
 * Backed by compiler-emitted `jsxRanges` — no source-text regex, no depth
 * counting. Babel's parser already paired the tags; we read its work.
 *
 * Cursor positions that count as "on a tag":
 *   - on the name (e.g. on `div` inside `<div>` or `</div>`)
 *   - on the opening `<` / closing `>` / self-closing `/`
 *   - NOT on attributes (e.g. inside `class="x"`)
 *
 * Fragments (`<>...</>`) have no names — skipped.
 */
function findJsxTagPair(
  efxPath: string,
  position: number,
): { current: NameSpan; partner: NameSpan } | null {
  const cache = sourceMapCache.get(efxPath)
  if (!cache) return null

  for (const r of cache.jsxRanges) {
    if (r.kind === "fragment") continue

    // On the opening tag?
    if (position >= r.openingTag.start && position < r.openingTag.end) {
      const onName = position >= r.openingTag.nameStart && position < r.openingTag.nameEnd
      const onLeadBracket = position < r.openingTag.nameStart // `<`
      const onTrailBracket = position >= r.openingTag.end - 1 // `>`
      const onSelfSlash = r.isSelfClosing && position === r.openingTag.end - 2 // `/`
      if (!(onName || onLeadBracket || onTrailBracket || onSelfSlash)) continue

      // Self-closing has no partner
      if (r.isSelfClosing || !r.closingTag) return null
      return {
        current: nameSpanOf(r.openingTag),
        partner: nameSpanOf(r.closingTag),
      }
    }

    // On the closing tag?
    if (r.closingTag && position >= r.closingTag.start && position < r.closingTag.end) {
      return {
        current: nameSpanOf(r.closingTag),
        partner: nameSpanOf(r.openingTag),
      }
    }
  }
  return null
}

const nameSpanOf = (t: { nameStart: number; nameEnd: number }): NameSpan => ({
  start: t.nameStart,
  length: t.nameEnd - t.nameStart,
})

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1)
    }
  }
  return starts
}

function lineColToOffset(lineStarts: number[], line: number, col: number): number {
  const start = lineStarts[line] ?? lineStarts[lineStarts.length - 1] ?? 0
  return start + col
}

/**
 * Convert a compiled (generated) offset to source offset using cached mappings.
 * Returns the source offset, or null if no mapping found.
 */
function compiledToSourceOffset(efxPath: string, compiledOffset: number): number | null {
  const cache = sourceMapCache.get(efxPath)
  if (!cache) return null

  // Find the mapping that contains the compiled offset
  // Mappings are point-to-point (length: 1), so find the closest one at or before the offset
  let bestMapping: { generatedOffset: number; sourceOffset: number } | null = null
  for (const mapping of cache.mappings) {
    const genOff = mapping.generatedOffsets[0]
    if (genOff <= compiledOffset) {
      if (!bestMapping || genOff > bestMapping.generatedOffset) {
        bestMapping = {
          generatedOffset: genOff,
          sourceOffset: mapping.sourceOffsets[0],
        }
      }
    }
  }

  if (!bestMapping) return null

  // Add the delta to the source offset
  const delta = compiledOffset - bestMapping.generatedOffset
  return bestMapping.sourceOffset + delta
}

/**
 * Convert a source offset to compiled (generated) offset using cached mappings.
 * Returns the compiled offset, or null if no mapping found.
 */
function sourceToCompiledOffset(efxPath: string, sourceOffset: number): number | null {
  const cache = sourceMapCache.get(efxPath)
  if (!cache) return null

  // Find the mapping that contains the source offset
  let bestMapping: { generatedOffset: number; sourceOffset: number } | null = null
  for (const mapping of cache.mappings) {
    const srcOff = mapping.sourceOffsets[0]
    if (srcOff <= sourceOffset) {
      if (!bestMapping || srcOff > bestMapping.sourceOffset) {
        bestMapping = {
          generatedOffset: mapping.generatedOffsets[0],
          sourceOffset: srcOff,
        }
      }
    }
  }

  if (!bestMapping) return null

  // Add the delta to the compiled offset
  const delta = sourceOffset - bestMapping.sourceOffset
  return bestMapping.generatedOffset + delta
}

// Create the base Volar plugin
const volarPluginFactory = createLanguageServicePlugin((_ts, _info) => ({
  languagePlugins: [efxLanguagePlugin],
}))

// Wrap the plugin factory to add .ts -> .efx path rewriting for definitions
const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  const volarModule = volarPluginFactory(modules)
  const ts = modules.typescript

  return {
    ...volarModule,
    create(info) {
      // Let Volar create its proxied service
      const service = volarModule.create(info)

      // Helper to check if .efx source exists for a .ts file
      const getEfxPath = (filePath: string): string | null => {
        if (filePath.endsWith(".ts") && !filePath.endsWith(".d.ts")) {
          const efxPath = filePath.slice(0, -3) + ".efx"
          if (ts.sys.fileExists(efxPath)) {
            return efxPath
          }
        }
        return null
      }

      // Get the header offset from a generated .ts file (the "// @generated" line length)
      const getGeneratedHeaderOffset = (tsPath: string): number => {
        try {
          const content = ts.sys.readFile(tsPath)
          if (content?.startsWith("// @generated")) {
            const newlineIdx = content.indexOf("\n")
            if (newlineIdx !== -1) {
              return newlineIdx + 1 // Include the newline
            }
          }
        } catch {
          // Ignore read errors
        }
        return 0
      }

      // Rewrite definition info to point to .efx source files and convert offsets
      const rewriteDefinitionInfo = <T extends { fileName: string; textSpan: ts.TextSpan }>(
        def: T
      ): T | null => {
        // Filter out h.ts definitions (runtime internals) - these appear due to h() calls
        if (def.fileName.includes("/runtime/") && def.fileName.endsWith("/h.ts")) {
          return null
        }

        const efxPath = getEfxPath(def.fileName)
        if (!efxPath) return def

        // Account for the "// @generated" header in disk .ts files
        const headerOffset = getGeneratedHeaderOffset(def.fileName)
        const virtualOffset = def.textSpan.start - headerOffset

        // Convert textSpan offsets from compiled (virtual) to source using source map
        const sourceStart = compiledToSourceOffset(efxPath, virtualOffset)
        if (sourceStart === null) {
          // No mapping found, return with just path rewritten
          return { ...def, fileName: efxPath }
        }

        return {
          ...def,
          fileName: efxPath,
          textSpan: {
            start: sourceStart,
            length: def.textSpan.length,
          },
        }
      }

      // Create a proxy to intercept definition methods AFTER Volar's processing
      return new Proxy(service, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== "function") return value

          // Wrap definition methods to rewrite .ts -> .efx paths and filter runtime internals
          if (prop === "getDefinitionAtPosition") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getDefinitionAtPosition"]).call(target, fileName, position)
              return result?.map(rewriteDefinitionInfo).filter((d): d is NonNullable<typeof d> => d !== null)
            }
          }
          if (prop === "getDefinitionAndBoundSpan") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getDefinitionAndBoundSpan"]).call(target, fileName, position)
              if (result?.definitions) {
                const defs = result.definitions
                  .map(rewriteDefinitionInfo)
                  .filter((d): d is NonNullable<typeof d> => d !== null)
                return { ...result, definitions: defs }
              }
              return result
            }
          }
          if (prop === "getTypeDefinitionAtPosition") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getTypeDefinitionAtPosition"]).call(target, fileName, position)
              return result?.map(rewriteDefinitionInfo).filter((d): d is NonNullable<typeof d> => d !== null)
            }
          }
          // JSX tag pair matching for document highlights
          if (prop === "getDocumentHighlights") {
            return (fileName: string, position: number, filesToSearch: string[]) => {
              if (!fileName.endsWith(".efx")) {
                return (value as ts.LanguageService["getDocumentHighlights"]).call(
                  target, fileName, position, filesToSearch
                )
              }

              // Whitespace at cursor → suppress; tsserver otherwise returns spurious empty hits
              const cache = sourceMapCache.get(fileName)
              const charAtPos = cache?.source[position]
              if (charAtPos && /\s/.test(charAtPos)) {
                return undefined
              }

              // JSX tag-pair highlight, backed by compiler jsxRanges
              const pair = findJsxTagPair(fileName, position)
              if (pair) {
                return [{
                  fileName,
                  highlightSpans: [
                    { textSpan: pair.current, kind: "reference" as ts.HighlightSpanKind },
                    { textSpan: pair.partner, kind: "reference" as ts.HighlightSpanKind },
                  ],
                }]
              }

              // Fall back to default behavior
              return (value as ts.LanguageService["getDocumentHighlights"]).call(
                target, fileName, position, filesToSearch
              )
            }
          }
          // Filter h() internal hints from inlay hints
          if (prop === "provideInlayHints") {
            return (fileName: string, span: ts.TextSpan, preferences: ts.UserPreferences | undefined) => {
              const hints = (value as ts.LanguageService["provideInlayHints"]).call(target, fileName, span, preferences)
              if (!fileName.endsWith(".efx")) return hints
              return hints.filter((hint: ts.InlayHint) => {
                // Extract text from various possible structures
                let text = ""
                if (typeof hint.text === "string") {
                  text = hint.text
                } else if (Array.isArray(hint.text)) {
                  text = (hint.text as Array<{ text: string }>).map((p) => p.text).join("")
                }
                // Also check displayParts which is used in newer TS versions
                const hintAny = hint as { displayParts?: Array<{ text: string }> }
                if (hintAny.displayParts && Array.isArray(hintAny.displayParts)) {
                  text = hintAny.displayParts.map((p) => p.text).join("")
                }
                return !/^_?(tag|props|children):?$/i.test(text)
              })
            }
          }
          // Rewrite references to point to .efx source files
          // For .efx files, redirect to the .ts file with converted position for cross-file refs
          if (prop === "getReferencesAtPosition") {
            return (fileName: string, position: number) => {
              let targetFile = fileName
              let targetPos = position
              // If querying from .efx, redirect to .ts with compiled position
              if (fileName.endsWith(".efx")) {
                const tsPath = fileName.slice(0, -4) + ".ts"
                if (ts.sys.fileExists(tsPath)) {
                  const compiledPos = sourceToCompiledOffset(fileName, position)
                  if (compiledPos !== null) {
                    const headerOffset = getGeneratedHeaderOffset(tsPath)
                    targetFile = tsPath
                    targetPos = compiledPos + headerOffset
                  }
                }
              }
              const result = (value as ts.LanguageService["getReferencesAtPosition"]).call(target, targetFile, targetPos)
              if (!result) return result
              // Convert all refs, then deduplicate by fileName + start
              const converted = result
                .map(rewriteDefinitionInfo)
                .filter((r): r is NonNullable<typeof r> => r !== null)
              const seen = new Set<string>()
              return converted.filter(r => {
                const key = `${r.fileName}:${r.textSpan.start}`
                if (seen.has(key)) return false
                seen.add(key)
                return true
              })
            }
          }
          if (prop === "findReferences") {
            return (fileName: string, position: number) => {
              let targetFile = fileName
              let targetPos = position
              // If querying from .efx, redirect to .ts with compiled position
              if (fileName.endsWith(".efx")) {
                const tsPath = fileName.slice(0, -4) + ".ts"
                if (ts.sys.fileExists(tsPath)) {
                  const compiledPos = sourceToCompiledOffset(fileName, position)
                  if (compiledPos !== null) {
                    const headerOffset = getGeneratedHeaderOffset(tsPath)
                    targetFile = tsPath
                    targetPos = compiledPos + headerOffset
                  }
                }
              }
              const result = (value as ts.LanguageService["findReferences"]).call(target, targetFile, targetPos)
              if (!result) return result
              // Deduplicate across ALL symbols, not per-symbol
              const allRefs: Array<{ fileName: string; textSpan: ts.TextSpan } & Record<string, unknown>> = []
              const seen = new Set<string>()
              for (const symbol of result) {
                for (const ref of symbol.references) {
                  const converted = rewriteDefinitionInfo(ref)
                  if (!converted) continue
                  const key = `${converted.fileName}:${converted.textSpan.start}`
                  if (seen.has(key)) continue
                  seen.add(key)
                  allRefs.push(converted)
                }
              }
              // Sort: definition first, then usages, then imports
              const firstSymbol = result[0]
              const convertedDef = rewriteDefinitionInfo(firstSymbol.definition) ?? firstSymbol.definition
              // Check if ref is in an import statement by reading the line
              const isImportRef = (ref: { fileName: string; textSpan: ts.TextSpan }): boolean => {
                try {
                  const content = ts.sys.readFile(ref.fileName)
                  if (!content) return false
                  // Find line start
                  let lineStart = ref.textSpan.start
                  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--
                  const lineEnd = content.indexOf("\n", ref.textSpan.start)
                  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
                  return /^\s*(import|export\s+\*?\s*from)/.test(line)
                } catch {
                  return false
                }
              }
              // Definition first, then non-imports (usages), then imports
              allRefs.sort((a, b) => {
                const aIsDef = a.fileName === convertedDef.fileName && a.textSpan.start === convertedDef.textSpan.start
                const bIsDef = b.fileName === convertedDef.fileName && b.textSpan.start === convertedDef.textSpan.start
                if (aIsDef && !bIsDef) return -1
                if (bIsDef && !aIsDef) return 1
                const aIsImport = isImportRef(a)
                const bIsImport = isImportRef(b)
                if (!aIsImport && bIsImport) return -1
                if (aIsImport && !bIsImport) return 1
                return 0
              })
              return [{
                definition: convertedDef,
                references: allRefs,
              }]
            }
          }

          return value
        },
      })
    },
  }
}

export = pluginFactory
