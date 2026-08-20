import type { Diagnostic } from "@volar/language-service"
import { SourceMap } from "@volar/source-map"
import type * as ts from "typescript"
import { VerrexVirtualCode } from "./virtual-code.ts"

/**
 * The one policy module for verrex's OWN (compiler) diagnostics — carried on
 * `VerrexVirtualCode.diagnostics` in SOURCE offsets. Severity, source label,
 * and code are decided here once; the two consumers are thin renderers:
 * `service-plugin.ts` (Volar/LSP shape, generated offsets, for
 * `verrex-check`) and the ts-plugin's `service-proxy.ts` (`ts.Diagnostic`
 * shape, source offsets, for tsserver).
 */

/** Diagnostic source label shown next to the message in editors/CLI. */
export const VERREX_DIAGNOSTIC_SOURCE = "verrex"

/**
 * Diagnostic code for verrex's own (compiler) diagnostics; well outside TS's
 * range.
 */
export const VERREX_DIAGNOSTIC_CODE = 90001

// LSP DiagnosticSeverity values (stable wire protocol).
export const SEVERITY_ERROR = 1
export const SEVERITY_WARNING = 2
export const SEVERITY_HINT = 4

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
 * The virtual code's diagnostics as LSP `Diagnostic`s in GENERATED
 * coordinates (Volar serves the embedded document, then maps back to `.vx`
 * source like any TypeScript diagnostic). `positionAt` converts a generated
 * offset to an LSP position — pass the embedded `TextDocument`'s method.
 */
export const toLspDiagnostics = (
  code: VerrexVirtualCode,
  positionAt: (offset: number) => Diagnostic["range"]["start"],
): Array<Diagnostic> => {
  const out: Array<Diagnostic> = []
  for (const d of code.diagnostics) {
    const gen = toGeneratedRange(code, d.start, d.end)
    if (!gen) continue
    out.push({
      range: { start: positionAt(gen.start), end: positionAt(gen.end) },
      severity: SEVERITY_ERROR as NonNullable<Diagnostic["severity"]>,
      source: VERREX_DIAGNOSTIC_SOURCE,
      message: d.message,
    })
  }
  return out
}

/**
 * The virtual code's diagnostics as `ts.Diagnostic`s in SOURCE offsets — the
 * coordinates Volar's decorated TS diagnostics arrive in inside tsserver, so
 * they print side by side. `file` is the program's SourceFile: tsserver only
 * uses its name to find the script (source text) for line/column conversion.
 */
export const toTsDiagnostics = (
  code: VerrexVirtualCode,
  file: ts.SourceFile,
): Array<ts.Diagnostic> =>
  code.diagnostics.map((d) => ({
    file,
    start: d.start,
    length: d.end - d.start,
    messageText: d.message,
    category: 1 satisfies ts.DiagnosticCategory.Error,
    code: VERREX_DIAGNOSTIC_CODE,
    source: VERREX_DIAGNOSTIC_SOURCE,
  }))
