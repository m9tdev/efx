import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin"
import type { Language } from "@volar/language-core"
import type * as ts from "typescript"
import {
  createVerrexLanguagePlugin,
  VerrexVirtualCode,
} from "@verrex/core/language"
import { findJsxTagPair, type JsxTagProvider } from "./jsx-tags.ts"
import {
  classifyRefs,
  dedupeRefs,
  sortClassifiedRefs,
} from "./classify-references.ts"
import { hintText, SUPPRESS_RE } from "./hint-text.ts"

/** Diagnostic code for verrex's own (compiler) diagnostics; well outside TS's range. */
const VERREX_DIAGNOSTIC_CODE = 90001

// tsserver identifies scripts by file path strings — asFileName is identity.
const verrexLanguagePlugin = createVerrexLanguagePlugin<string>(
  (scriptId) => scriptId,
)

// Volar hands us the `Language` for this tsserver session via the `setup`
// hook, which fires synchronously inside `volarModule.create(info)`. We stash
// it here and immediately read it back into a per-`create` const below, before
// any language-service method can run — so concurrent projects don't clobber
// each other. The `Language` is the single source of truth for compiled `.vx`
// files: we look the `VerrexVirtualCode` back up through it instead of keeping a
// side-channel cache.
let pendingLanguage: Language<string> | undefined

const volarPluginFactory = createLanguageServicePlugin((_ts, _info) => ({
  languagePlugins: [verrexLanguagePlugin],
  setup(language) {
    pendingLanguage = language
  },
}))

/**
 * tsserver plugin entry. Wraps Volar's LanguageService in a Proxy to:
 *   - filter out hits in `verrex`'s `h.ts` from definition results
 *     (go-to-def on `<div>` should NOT land in the JSX factory)
 *   - run JSX tag-pair matching on document highlights
 *   - filter out `_tag`/`_props`/`_children` inlay hints
 *   - dedupe references across symbols and sort definition → usages → imports
 *
 * Cross-file go-to-def and find-references work natively now that `.vx`
 * imports use the explicit `.vx` extension (the Vue/Astro convention).
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

      // Resolve the compiled `.vx` representation from Volar's own context —
      // the same instance Volar indexed in `createVirtualCode`. The
      // `instanceof` narrows away `.ts`/other virtual codes and the
      // not-yet-compiled case. No side-channel cache to fall out of sync.
      const getVerrexVirtualCode = (
        fileName: string,
      ): VerrexVirtualCode | undefined => {
        const root = language?.scripts.get(fileName)?.generated?.root
        return root instanceof VerrexVirtualCode ? root : undefined
      }

      const jsxTagProvider: JsxTagProvider = {
        getJsxRanges: (verrexPath) =>
          getVerrexVirtualCode(verrexPath)?.jsxRanges,
      }

      // Filter out h.ts definitions (runtime internals) - these appear due to h() calls.
      // Cross-file path/offset rewriting isn't needed anymore: Volar maps virtual-code
      // results back to source `.vx` coordinates natively.
      const filterRuntimeHit = <T extends { fileName: string }>(
        def: T,
      ): T | null => {
        if (
          def.fileName.includes("/runtime/") &&
          def.fileName.endsWith("/h.ts")
        ) {
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
          const fn = (service as ts.LanguageService)[name] as (
            ...a: unknown[]
          ) => unknown
          const result = fn.apply(service, args)
          return (
            transform as (result: unknown, ...args: unknown[]) => unknown
          )(result, ...args)
        }
        return wrapped as ts.LanguageService[K]
      }

      return new Proxy(service, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== "function") return value

          if (prop === "getDefinitionAtPosition") {
            return wrapMethod(
              "getDefinitionAtPosition",
              (r) => r && filterRuntimeHits(r),
            )
          }
          if (prop === "getTypeDefinitionAtPosition") {
            return wrapMethod(
              "getTypeDefinitionAtPosition",
              (r) => r && filterRuntimeHits(r),
            )
          }
          if (prop === "getDefinitionAndBoundSpan") {
            return wrapMethod("getDefinitionAndBoundSpan", (r) => {
              if (!r?.definitions) return r
              return { ...r, definitions: filterRuntimeHits(r.definitions) }
            })
          }

          // getDocumentHighlights stays inline: its `.vx` paths early-return
          // before touching the underlying call (whitespace skip, JSX-pair
          // match), which wrapMethod's eager-call shape can't express.
          if (prop === "getDocumentHighlights") {
            return (
              fileName: string,
              position: number,
              filesToSearch: string[],
            ) => {
              if (!fileName.endsWith(".vx")) {
                return (
                  value as ts.LanguageService["getDocumentHighlights"]
                ).call(target, fileName, position, filesToSearch)
              }

              // Whitespace at cursor → suppress; tsserver otherwise returns spurious empty hits
              const vc = getVerrexVirtualCode(fileName)
              const charAtPos = vc?.source[position]
              if (charAtPos && /\s/.test(charAtPos)) {
                return undefined
              }

              // JSX tag-pair highlight, backed by compiler jsxRanges
              const pair = findJsxTagPair(jsxTagProvider, fileName, position)
              if (pair) {
                return [
                  {
                    fileName,
                    highlightSpans: [
                      {
                        textSpan: pair.current,
                        kind: "reference" as ts.HighlightSpanKind,
                      },
                      {
                        textSpan: pair.partner,
                        kind: "reference" as ts.HighlightSpanKind,
                      },
                    ],
                  },
                ]
              }

              // Fall back to default behavior
              return (
                value as ts.LanguageService["getDocumentHighlights"]
              ).call(target, fileName, position, filesToSearch)
            }
          }

          if (prop === "getCompletionsAtPosition") {
            return wrapMethod(
              "getCompletionsAtPosition",
              (result, fileName, position) => {
                if (!fileName.endsWith(".vx") || !result) return result
                const source = getVerrexVirtualCode(fileName)?.source
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
                const crossesNewlineFromCursor = (
                  span: ts.TextSpan,
                ): boolean => {
                  const lo = Math.min(position, span.start)
                  const hi = Math.max(position, span.start + span.length)
                  return source.slice(lo, hi).includes("\n")
                }
                const insertAtCursor: ts.TextSpan = {
                  start: position,
                  length: 0,
                }

                const entries = result.entries.map((e) => {
                  if (
                    e.replacementSpan &&
                    crossesNewlineFromCursor(e.replacementSpan)
                  ) {
                    return { ...e, replacementSpan: insertAtCursor }
                  }
                  return e
                })
                const orig = result.optionalReplacementSpan
                const clamped =
                  orig && crossesNewlineFromCursor(orig) ? insertAtCursor : orig
                // Spread the optional field only when defined — exactOptionalPropertyTypes
                // rejects `optionalReplacementSpan: undefined` as a value.
                return clamped
                  ? { ...result, optionalReplacementSpan: clamped, entries }
                  : { ...result, entries }
              },
            )
          }

          if (prop === "getSemanticDiagnostics") {
            return wrapMethod("getSemanticDiagnostics", (diags, fileName) => {
              if (!fileName.endsWith(".vx")) return diags
              // The compiler's own diagnostics (a `get(...)` in a nested
              // function/handler), carried on the virtual code in SOURCE
              // offsets — the coordinates Volar's decorated TS diagnostics
              // arrive in here too, so they print side by side. `file` is the
              // program's SourceFile: tsserver only uses its name to find the
              // script (source text) for line/column conversion.
              const code = getVerrexVirtualCode(fileName)
              if (!code || code.diagnostics.length === 0) return diags
              const file = service.getProgram()?.getSourceFile(fileName)
              if (!file) return diags
              const own: ts.Diagnostic[] = code.diagnostics.map((d) => ({
                file,
                start: d.start,
                length: d.end - d.start,
                messageText: d.message,
                category: 1 satisfies ts.DiagnosticCategory.Error,
                code: VERREX_DIAGNOSTIC_CODE,
                source: "verrex",
              }))
              return [...diags, ...own]
            })
          }

          if (prop === "provideInlayHints") {
            return wrapMethod("provideInlayHints", (hints, fileName) => {
              if (!fileName.endsWith(".vx")) return hints
              // Drop the h() parameter labels (_tag/_props/_children). Text
              // extraction + the suppression regex live in hint-text.ts so
              // they're unit-testable without a tsserver.
              return hints.filter(
                (hint: ts.InlayHint) => !SUPPRESS_RE.test(hintText(hint)),
              )
            })
          }

          if (prop === "getReferencesAtPosition") {
            return wrapMethod("getReferencesAtPosition", (result) => {
              if (!result) return result
              return dedupeRefs(filterRuntimeHits(result))
            })
          }

          if (prop === "findReferences") {
            return wrapMethod("findReferences", (result) => {
              if (!result) return result
              const firstSymbol = result[0]
              if (!firstSymbol) return result
              const def = firstSymbol.definition
              // Flatten the nested ReferencedSymbol[] into one list, drop h.ts
              // hits, then dedupe across ALL symbols (not per-symbol) with the
              // shared refKey. Classify once (one read per distinct file), then
              // apply the def→usages→imports ordering — both extracted next to
              // classifyRefs so the policy is unit-tested without a tsserver.
              const allRefs = dedupeRefs(
                filterRuntimeHits(result.flatMap((s) => s.references)),
              )
              const classified = sortClassifiedRefs(
                classifyRefs(allRefs, def, ts.sys.readFile),
              )
              return [
                {
                  definition: def,
                  references: classified.map((c) => c.ref),
                },
              ]
            })
          }

          return value
        },
      })
    },
  }
}
