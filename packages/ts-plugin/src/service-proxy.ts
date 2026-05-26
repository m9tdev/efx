import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin"
import type * as ts from "typescript"
import { createEfxLanguagePlugin, getEfxVirtualCode } from "@efx/language"
import { findJsxTagPair } from "./jsx-tags.ts"

// tsserver identifies scripts by file path strings — asFileName is identity.
const efxLanguagePlugin = createEfxLanguagePlugin<string>((scriptId) => scriptId)

// Create the base Volar plugin
const volarPluginFactory = createLanguageServicePlugin((_ts, _info) => ({
  languagePlugins: [efxLanguagePlugin],
}))

/**
 * tsserver plugin entry. Wraps Volar's LanguageService in a Proxy to:
 *   - rewrite definition/reference paths from on-disk `.ts` siblings to `.efx`
 *     and convert offsets through the cached source map
 *   - run JSX tag-pair matching on document highlights
 *   - filter out `_tag`/`_props`/`_children` inlay hints (h()'s parameter names)
 *   - dedupe references across symbols and sort definition → usages → imports
 */
export const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
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
        const sourceStart = getEfxVirtualCode(efxPath)?.compiledToSourceOffset(virtualOffset) ?? null
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
              const vc = getEfxVirtualCode(fileName)
              const charAtPos = vc?.source[position]
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
                  const compiledPos = getEfxVirtualCode(fileName)?.sourceToCompiledOffset(position) ?? null
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
                  const compiledPos = getEfxVirtualCode(fileName)?.sourceToCompiledOffset(position) ?? null
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
              const allRefs: ts.ReferencedSymbolEntry[] = []
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
              if (!firstSymbol) return result
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
