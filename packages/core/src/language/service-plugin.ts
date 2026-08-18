import type {
  Diagnostic,
  LanguageServicePlugin,
  LanguageServicePluginInstance,
} from "@volar/language-service"
import { SourceMap } from "@volar/source-map"
import { URI } from "vscode-uri"
import { VerrexVirtualCode } from "./virtual-code.ts"

/** LSP `DiagnosticSeverity.Error` (stable wire protocol). */
const SEVERITY_ERROR = 1

/**
 * Map a SOURCE range of a `.vx` file to a GENERATED range in its compiled TS,
 * through the virtual code's own mappings. `undefined` when no mapping covers
 * the start (a diagnostic on unmapped text has nowhere to land).
 */
export const toGeneratedRange = (
  code: VerrexVirtualCode,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | undefined => {
  const map = new SourceMap(code.mappings)
  for (const [genStart, genEnd] of map.toGeneratedRange(start, end, true)) {
    return { start: genStart, end: genEnd }
  }
  for (const [genStart] of map.toGeneratedLocation(start)) {
    return { start: genStart, end: genStart + (end - start) }
  }
  return undefined
}

/**
 * A Volar LanguageServicePlugin that surfaces the compiler's own diagnostics
 * (`VerrexVirtualCode.diagnostics`, source offsets) through the standard
 * `provideDiagnostics` channel. Volar calls it per EMBEDDED document (the
 * compiled TS of a `.vx`), so ranges are reported in GENERATED offsets and
 * Volar maps them back to the `.vx` source like any TypeScript diagnostic.
 * Used by `verrex-check` (`@volar/kit`); the ts-plugin, which is not a Volar
 * language service, reads the same field itself (see its `service-proxy.ts`).
 */
export function createVerrexServicePlugin(): LanguageServicePlugin {
  return {
    name: "verrex",
    capabilities: {
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    create(context): LanguageServicePluginInstance {
      return {
        provideDiagnostics(document) {
          const decoded = context.decodeEmbeddedDocumentUri(
            URI.parse(document.uri),
          )
          if (!decoded) return []
          const root = context.language.scripts.get(decoded[0])?.generated?.root
          if (!(root instanceof VerrexVirtualCode)) return []
          const out: Array<Diagnostic> = []
          for (const d of root.diagnostics) {
            const gen = toGeneratedRange(root, d.start, d.end)
            if (!gen) continue
            out.push({
              range: {
                start: document.positionAt(gen.start),
                end: document.positionAt(gen.end),
              },
              severity: SEVERITY_ERROR as NonNullable<Diagnostic["severity"]>,
              source: "verrex",
              message: d.message,
            })
          }
          return out
        },
      }
    },
  }
}
