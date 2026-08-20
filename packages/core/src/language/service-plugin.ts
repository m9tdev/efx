import type {
  LanguageServicePlugin,
  LanguageServicePluginInstance,
} from "@volar/language-service"
import { URI } from "vscode-uri"
import { toLspDiagnostics } from "./diagnostics.ts"
import { VerrexVirtualCode } from "./virtual-code.ts"

/**
 * A Volar LanguageServicePlugin that surfaces the compiler's own diagnostics
 * (`VerrexVirtualCode.diagnostics`, source offsets) through the standard
 * `provideDiagnostics` channel. Volar calls it per EMBEDDED document (the
 * compiled TS of a `.vx`), so ranges are reported in GENERATED offsets and
 * Volar maps them back to the `.vx` source like any TypeScript diagnostic.
 * Used by `verrex-check` (`@volar/kit`); the ts-plugin, which is not a Volar
 * language service, renders the same field via `toTsDiagnostics` (see its
 * `service-proxy.ts`). Policy (severity, source, mapping) lives in
 * `diagnostics.ts`.
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
          return toLspDiagnostics(root, (offset) => document.positionAt(offset))
        },
      }
    },
  }
}
