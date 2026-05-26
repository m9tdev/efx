import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin"
import type * as ts from "typescript"
import { createEfxLanguagePlugin, getEfxVirtualCode } from "@efx/language"
import { findJsxTagPair } from "./jsx-tags.ts"
import { classifyRefs } from "./classify-references.ts"

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

      const filterRuntimeHits = <T extends { fileName: string }>(
        results: readonly T[],
      ): T[] => results.map(filterRuntimeHit).filter((d): d is T => d !== null)

      // Wires a LanguageService method through the proxy by name: calls the
      // underlying impl on `service`, hands the result + original args to
      // `transform`, and returns whatever the transform produces. The
      // `infer A`/`infer R` shape narrows `ts.LanguageService[K]` from a
      // method-or-undefined union (the interface has optional members) down
      // to its callable signature.
      const wrapMethod = <K extends keyof ts.LanguageService>(
        name: K,
        transform: ts.LanguageService[K] extends (...args: infer A) => infer R
          ? (result: R, ...args: A) => R
          : never,
      ): ts.LanguageService[K] => {
        const wrapped = (...args: unknown[]) => {
          const fn = (service as ts.LanguageService)[name] as (...a: unknown[]) => unknown
          const result = fn.apply(service, args)
          return (transform as (result: unknown, ...args: unknown[]) => unknown)(result, ...args)
        }
        return wrapped as ts.LanguageService[K]
      }

      return new Proxy(service, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== "function") return value

          if (prop === "getDefinitionAtPosition") {
            return wrapMethod("getDefinitionAtPosition", (r) => r && filterRuntimeHits(r))
          }
          if (prop === "getTypeDefinitionAtPosition") {
            return wrapMethod("getTypeDefinitionAtPosition", (r) => r && filterRuntimeHits(r))
          }
          if (prop === "getDefinitionAndBoundSpan") {
            return wrapMethod("getDefinitionAndBoundSpan", (r) => {
              if (!r?.definitions) return r
              return { ...r, definitions: filterRuntimeHits(r.definitions) }
            })
          }

          // getDocumentHighlights stays inline: its `.efx` paths early-return
          // before touching the underlying call (whitespace skip, JSX-pair
          // match), which wrapMethod's eager-call shape can't express.
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

          if (prop === "provideInlayHints") {
            return wrapMethod("provideInlayHints", (hints, fileName) => {
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
            })
          }

          if (prop === "getReferencesAtPosition") {
            return wrapMethod("getReferencesAtPosition", (result) => {
              if (!result) return result
              const filtered = filterRuntimeHits(result)
              const seen = new Set<string>()
              return filtered.filter(r => {
                const key = `${r.fileName}:${r.textSpan.start}`
                if (seen.has(key)) return false
                seen.add(key)
                return true
              })
            })
          }

          if (prop === "findReferences") {
            return wrapMethod("findReferences", (result) => {
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
              const firstSymbol = result[0]
              if (!firstSymbol) return result
              const def = firstSymbol.definition
              // Classify once (one read per distinct file), then sort on the
              // booleans. Otherwise the comparator would re-read source for
              // each pair it compared.
              const classified = classifyRefs(allRefs, def, ts.sys.readFile)
              classified.sort((a, b) => {
                if (a.isDef !== b.isDef) return a.isDef ? -1 : 1
                if (a.isImport !== b.isImport) return a.isImport ? 1 : -1
                return 0
              })
              return [{
                definition: def,
                references: classified.map((c) => c.ref),
              }]
            })
          }

          return value
        },
      })
    },
  }
}
