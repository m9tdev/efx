import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin"
import type { Language } from "@volar/language-core"
import type * as ts from "typescript"
import { createEfxLanguagePlugin, EfxVirtualCode } from "@efx/language"
import { findJsxTagPair, type JsxTagProvider } from "./jsx-tags.ts"
import { classifyRefs } from "./classify-references.ts"

// tsserver identifies scripts by file path strings — asFileName is identity.
const efxLanguagePlugin = createEfxLanguagePlugin<string>((scriptId) => scriptId)

// Volar hands us the `Language` for this tsserver session via the `setup`
// hook, which fires synchronously inside `volarModule.create(info)`. We stash
// it here and immediately read it back into a per-`create` const below, before
// any language-service method can run — so concurrent projects don't clobber
// each other. The `Language` is the single source of truth for compiled `.efx`
// files: we look the `EfxVirtualCode` back up through it instead of keeping a
// side-channel cache.
let pendingLanguage: Language<string> | undefined

const volarPluginFactory = createLanguageServicePlugin((_ts, _info) => ({
  languagePlugins: [efxLanguagePlugin],
  setup(language) {
    pendingLanguage = language
  },
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
      // `setup` ran synchronously during the create() above; capture its
      // `Language` before any async method call can overwrite the slot.
      const language = pendingLanguage
      pendingLanguage = undefined

      // Resolve the compiled `.efx` representation from Volar's own context —
      // the same instance Volar indexed in `createVirtualCode`. The
      // `instanceof` narrows away `.ts`/other virtual codes and the
      // not-yet-compiled case. No side-channel cache to fall out of sync.
      const getEfxVirtualCode = (fileName: string): EfxVirtualCode | undefined => {
        const root = language?.scripts.get(fileName)?.generated?.root
        return root instanceof EfxVirtualCode ? root : undefined
      }

      const jsxTagProvider: JsxTagProvider = {
        getJsxRanges: (efxPath) => getEfxVirtualCode(efxPath)?.jsxRanges,
      }

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
              const pair = findJsxTagPair(jsxTagProvider, fileName, position)
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

          if (prop === "getCompletionsAtPosition") {
            return wrapMethod("getCompletionsAtPosition", (result, fileName, position) => {
              if (!fileName.endsWith(".efx") || !result) return result
              const source = getEfxVirtualCode(fileName)?.source
              if (!source) return result
              // Babel's errorRecovery turns mid-edit `count.\n...return` into a
              // `count.return` MemberExpression — convenient for letting
              // tsserver enumerate `count`'s members, but the resulting
              // replacementSpan covers `return` on the next line. If the
              // editor applied it, picking `set` would delete `return`.
              // Clamp any span that sits across a newline from the cursor to
              // an insert-at-cursor (zero-width at position). Deliberately
              // coarse: we don't try to identify the synthesized property
              // text — any cross-line span gets clamped. In practice, no
              // legitimate completion wants to delete content from a
              // different line than the cursor.
              const crossesNewlineFromCursor = (span: ts.TextSpan): boolean => {
                const lo = Math.min(position, span.start)
                const hi = Math.max(position, span.start + span.length)
                return source.slice(lo, hi).includes("\n")
              }
              const insertAtCursor: ts.TextSpan = { start: position, length: 0 }

              const entries = result.entries.map((e) => {
                if (e.replacementSpan && crossesNewlineFromCursor(e.replacementSpan)) {
                  return { ...e, replacementSpan: insertAtCursor }
                }
                return e
              })
              const orig = result.optionalReplacementSpan
              const clamped = orig && crossesNewlineFromCursor(orig) ? insertAtCursor : orig
              // Spread the optional field only when defined — exactOptionalPropertyTypes
              // rejects `optionalReplacementSpan: undefined` as a value.
              return clamped
                ? { ...result, optionalReplacementSpan: clamped, entries }
                : { ...result, entries }
            })
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
