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
 *   - filter out hits in `@efx/runtime`'s `h.ts` from definition results
 *     (go-to-def on `<div>` should NOT land in the JSX factory)
 *   - run JSX tag-pair matching on document highlights
 *   - filter out `_tag`/`_props`/`_children` inlay hints
 *   - dedupe references across symbols and sort definition → usages → imports
 *
 * Cross-file go-to-def and find-references work natively now that `.efx`
 * imports use the explicit `.efx` extension (the Vue/Astro convention).
 * TS's module resolver handles those via `extraFileExtensions`; the
 * earlier sibling-`.ts` redirect is gone.
 */
export const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  const volarModule = volarPluginFactory(modules)
  const ts = modules.typescript

  return {
    ...volarModule,
    create(info) {
      const service = volarModule.create(info)

      // Filter out h.ts definitions (runtime internals) - these appear due to h() calls.
      // Cross-file path/offset rewriting isn't needed anymore: Volar maps virtual-code
      // results back to source `.efx` coordinates natively.
      const filterRuntimeHit = <T extends { fileName: string }>(def: T): T | null => {
        if (def.fileName.includes("/runtime/") && def.fileName.endsWith("/h.ts")) {
          return null
        }
        return def
      }

      return new Proxy(service, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== "function") return value

          if (prop === "getDefinitionAtPosition") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getDefinitionAtPosition"]).call(target, fileName, position)
              return result?.map(filterRuntimeHit).filter((d): d is NonNullable<typeof d> => d !== null)
            }
          }
          if (prop === "getDefinitionAndBoundSpan") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getDefinitionAndBoundSpan"]).call(target, fileName, position)
              if (result?.definitions) {
                const defs = result.definitions
                  .map(filterRuntimeHit)
                  .filter((d): d is NonNullable<typeof d> => d !== null)
                return { ...result, definitions: defs }
              }
              return result
            }
          }
          if (prop === "getTypeDefinitionAtPosition") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getTypeDefinitionAtPosition"]).call(target, fileName, position)
              return result?.map(filterRuntimeHit).filter((d): d is NonNullable<typeof d> => d !== null)
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
          if (prop === "getReferencesAtPosition") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["getReferencesAtPosition"]).call(target, fileName, position)
              if (!result) return result
              const filtered = result
                .map(filterRuntimeHit)
                .filter((r): r is NonNullable<typeof r> => r !== null)
              const seen = new Set<string>()
              return filtered.filter(r => {
                const key = `${r.fileName}:${r.textSpan.start}`
                if (seen.has(key)) return false
                seen.add(key)
                return true
              })
            }
          }
          if (prop === "findReferences") {
            return (fileName: string, position: number) => {
              const result = (value as ts.LanguageService["findReferences"]).call(target, fileName, position)
              if (!result) return result
              // Deduplicate across ALL symbols, not per-symbol
              const allRefs: ts.ReferencedSymbolEntry[] = []
              const seen = new Set<string>()
              for (const symbol of result) {
                for (const ref of symbol.references) {
                  const filtered = filterRuntimeHit(ref)
                  if (!filtered) continue
                  const key = `${filtered.fileName}:${filtered.textSpan.start}`
                  if (seen.has(key)) continue
                  seen.add(key)
                  allRefs.push(filtered)
                }
              }
              // Sort: definition first, then usages, then imports
              const firstSymbol = result[0]
              if (!firstSymbol) return result
              const def = firstSymbol.definition
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
                const aIsDef = a.fileName === def.fileName && a.textSpan.start === def.textSpan.start
                const bIsDef = b.fileName === def.fileName && b.textSpan.start === def.textSpan.start
                if (aIsDef && !bIsDef) return -1
                if (bIsDef && !aIsDef) return 1
                const aIsImport = isImportRef(a)
                const bIsImport = isImportRef(b)
                if (!aIsImport && bIsImport) return -1
                if (aIsImport && !bIsImport) return 1
                return 0
              })
              return [{
                definition: def,
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
