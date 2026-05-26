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
import { transformEfx } from "@efx/compiler"
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

    // Convert Babel source map to Volar mappings
    const mappings = convertSourceMap(result.map, source, compiled)

    // Cache source map data for offset conversion in definition results
    sourceMapCache.set(scriptId, { source, compiled, mappings })

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
 * Marks h() function parameter positions as non-semantic to hide inlay hints.
 */
function convertSourceMap(
  map: { mappings?: string } | null | undefined,
  source: string,
  generated: string,
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

  // Find h() call positions in generated code to mark them as non-semantic (suppress inlay hints)
  const hCallPositions = findHCallPositions(generated, generatedLineStarts)

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

  // JSX punctuation characters that map to h() structure - these should not be semantic
  const jsxPunctuation = new Set(["<", ">", "/"])

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

    // Check if this position is inside an h() call (suppress inlay hints for h() internals)
    const isInHCall = hCallPositions.some(
      (pos) => seg.genOffset >= pos.start && seg.genOffset < pos.end
    )

    // JSX punctuation (< > /) maps to h() structure - fully disable semantic/nav
    const isJsxPunctuation = jsxPunctuation.has(seg.srcChar)

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

/**
 * Find positions of h() calls in generated code.
 * Returns ranges from the 'h' identifier through the closing paren to suppress
 * semantic features (inlay hints, semantic tokens) for generated JSX internals.
 */
function findHCallPositions(
  code: string,
  _lineStarts: number[],
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  // Match entire h(...) call to suppress all h() internal semantic features
  const hCallRegex = /\bh\s*\(/g
  let match
  while ((match = hCallRegex.exec(code)) !== null) {
    // Start from the 'h' identifier (important: Babel maps 'h' back to JSX source positions)
    const start = match.index
    // Find matching closing paren (accounting for nesting)
    const parenPos = match.index + match[0].length - 1
    let depth = 1
    let end = parenPos + 1
    while (end < code.length && depth > 0) {
      const ch = code[end]
      if (ch === "(") depth++
      else if (ch === ")") depth--
      end++
    }
    positions.push({ start, end })
  }
  return positions
}

interface JsxTag {
  start: number          // Start of the full tag
  length: number         // Length of the full tag
  nameStart: number      // Start of just the tag name (for highlighting)
  nameLength: number     // Length of just the tag name
  name: string
  isClosing: boolean
  isSelfClosing: boolean
}

function findJsxTagAtPosition(content: string, position: number): JsxTag | null {
  // Find if cursor is inside a JSX tag
  // Look backwards for < and forwards for >
  let tagStart = position
  while (tagStart > 0 && content[tagStart] !== "<" && content[tagStart] !== ">") {
    tagStart--
  }
  if (content[tagStart] !== "<") return null

  let tagEnd = position
  while (tagEnd < content.length && content[tagEnd] !== ">") {
    tagEnd++
  }
  if (tagEnd >= content.length) return null
  tagEnd++ // Include the >

  // Verify cursor is actually inside this tag
  if (position < tagStart || position >= tagEnd) return null

  const tagContent = content.slice(tagStart, tagEnd)
  const isClosing = tagContent.startsWith("</")
  const isSelfClosing = tagContent.endsWith("/>")

  // Extract tag name and its position
  const nameMatch = tagContent.match(isClosing ? /^(<\/\s*)([a-zA-Z][a-zA-Z0-9.]*)/i : /^(<\s*)([a-zA-Z][a-zA-Z0-9.]*)/i)
  if (!nameMatch) return null

  const nameStart = tagStart + nameMatch[1].length
  const nameLength = nameMatch[2].length
  const nameEnd = nameStart + nameLength

  // Only match if cursor is on: < or </ or tag name or > or />
  // Not on whitespace or attributes between name and >
  const cursorOnBracket = position === tagStart || (isClosing && position === tagStart + 1)
  const cursorOnName = position >= nameStart && position < nameEnd
  const cursorOnClose = position === tagEnd - 1 || (isSelfClosing && position === tagEnd - 2)

  if (!cursorOnBracket && !cursorOnName && !cursorOnClose) return null

  return {
    start: tagStart,
    length: tagEnd - tagStart,
    nameStart,
    nameLength,
    name: nameMatch[2],
    isClosing,
    isSelfClosing,
  }
}

function findMatchingJsxTag(content: string, tag: JsxTag): JsxTag | null {
  if (tag.isSelfClosing) return null

  const tagName = tag.name
  // Escape special regex chars in tag name (for components like Foo.Bar)
  const escapedName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  // Collect all opening and closing tags of this name
  const allTags: Array<{ pos: number; isOpening: boolean; isSelfClosing: boolean; end: number }> = []

  // Find all opening tags: <tagName followed by whitespace, >, or />
  const openingRegex = new RegExp(`<${escapedName}(?=[\\s>/>])`, "g")
  let match
  while ((match = openingRegex.exec(content)) !== null) {
    // Check if self-closing by finding the closing > and checking for />
    let closePos = match.index + match[0].length
    let depth = 0
    while (closePos < content.length) {
      const ch = content[closePos]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      else if (depth === 0 && ch === ">") break
      closePos++
    }
    const isSelf = closePos > 0 && content[closePos - 1] === "/"
    allTags.push({ pos: match.index, isOpening: true, isSelfClosing: isSelf, end: closePos + 1 })
  }

  // Find all closing tags: </tagName>
  const closingRegex = new RegExp(`</${escapedName}\\s*>`, "g")
  while ((match = closingRegex.exec(content)) !== null) {
    allTags.push({ pos: match.index, isOpening: false, isSelfClosing: false, end: match.index + match[0].length })
  }

  // Sort by position
  allTags.sort((a, b) => a.pos - b.pos)

  if (tag.isClosing) {
    // Find matching opening tag before this position
    let depth = 0
    for (let i = allTags.length - 1; i >= 0; i--) {
      const t = allTags[i]
      if (t.pos >= tag.start) continue
      if (t.isSelfClosing) continue

      if (!t.isOpening) {
        depth++
      } else {
        if (depth === 0) {
          // Opening tag: <tagName - name starts after <
          const nameStart = t.pos + 1
          return { start: t.pos, length: t.end - t.pos, nameStart, nameLength: tagName.length, name: tagName, isClosing: false, isSelfClosing: false }
        }
        depth--
      }
    }
  } else {
    // Find matching closing tag after this position
    let depth = 0
    for (const t of allTags) {
      if (t.pos <= tag.start) continue
      if (t.isSelfClosing) continue

      if (t.isOpening) {
        depth++
      } else {
        if (depth === 0) {
          // Closing tag: </tagName> - name starts after </
          const nameStart = t.pos + 2
          return { start: t.pos, length: t.end - t.pos, nameStart, nameLength: tagName.length, name: tagName, isClosing: true, isSelfClosing: false }
        }
        depth--
      }
    }
  }

  return null
}

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

              const content = ts.sys.readFile(fileName)
              if (!content) {
                return (value as ts.LanguageService["getDocumentHighlights"]).call(
                  target, fileName, position, filesToSearch
                )
              }

              // Don't highlight whitespace - return empty to avoid spurious matches
              const charAtPos = content[position]
              if (!charAtPos || /\s/.test(charAtPos)) {
                return undefined
              }

              // Check if cursor is on a JSX tag
              const tagMatch = findJsxTagAtPosition(content, position)
              if (tagMatch) {
                const matchingTag = findMatchingJsxTag(content, tagMatch)
                if (matchingTag) {
                  // Highlight just the tag names, not the whole tags
                  return [{
                    fileName,
                    highlightSpans: [
                      { textSpan: { start: tagMatch.nameStart, length: tagMatch.nameLength }, kind: "reference" as ts.HighlightSpanKind },
                      { textSpan: { start: matchingTag.nameStart, length: matchingTag.nameLength }, kind: "reference" as ts.HighlightSpanKind },
                    ],
                  }]
                }
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
