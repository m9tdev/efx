import * as path from "node:path"
import * as ts from "typescript"
import * as kit from "@volar/kit"
import { create as createTypeScriptServices } from "volar-service-typescript"
import { URI } from "vscode-uri"
import { createVerrexLanguagePlugin } from "verrex/language"

// LSP DiagnosticSeverity constants (stable wire protocol). `@volar/language-service`
// re-exports the type but not the values, so we inline these to avoid pulling in
// another package just for the enum.
const SEVERITY_ERROR = 1
const SEVERITY_WARNING = 2

export interface CheckOptions {
  /**
   * Project root. Used to resolve tsconfig.json when `tsconfig` is unset.
   * Defaults to `process.cwd()`.
   */
  cwd?: string
  /**
   * Path to tsconfig.json (absolute, or relative to `cwd`).
   * If omitted, `ts.findConfigFile` is used starting from `cwd`.
   */
  tsconfig?: string
}

export interface CheckResult {
  /** Number of root files inspected (including non-`.vx` TS files). */
  filesChecked: number
  /** Total error-severity diagnostics across all files. */
  errors: number
  /** Total warning-severity diagnostics. */
  warnings: number
}

/**
 * Type-check an verrex project. Returns a summary; the printed output goes
 * to stdout in tsc's standard "file:line:col - error TS####: message"
 * format (via Volar kit's printErrors helper).
 */
export async function runCheck(options: CheckOptions = {}): Promise<CheckResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd())

  const tsconfigPath = resolveTsconfig(cwd, options.tsconfig)
  if (!tsconfigPath) {
    throw new Error(
      `No tsconfig.json found from ${cwd}. Pass --tsconfig <path> or run from a directory containing one.`,
    )
  }

  // `@volar/kit` uses `URI` as the script-id type, so the plugin gets URIs
  // and reduces them to filesystem paths for the compiler. The kit checker
  // owns the virtual-code lifetime per `createTypeScriptChecker` call; we
  // hold no side-channel state of our own.
  const languagePlugin = createVerrexLanguagePlugin<URI>((uri) => uri.fsPath)
  const tsServices = createTypeScriptServices(ts)
  const linter = kit.createTypeScriptChecker([languagePlugin], tsServices, tsconfigPath)

  const fileNames = linter.getRootFileNames()
  let errors = 0
  let warnings = 0

  for (const fileName of fileNames) {
    const diagnostics = await linter.check(fileName)
    if (diagnostics.length === 0) continue

    // Match `tsc --noEmit` behaviour: only print error-severity diagnostics.
    // Warnings/hints surfaced by volar-service-typescript (e.g. unused locals
    // without `noUnusedLocals`) get counted but not printed by default.
    // TODO(astro-parity): expose --minimumSeverity to control what prints.
    const errorOnly = diagnostics.filter((d) => (d.severity ?? SEVERITY_ERROR) === SEVERITY_ERROR)
    if (errorOnly.length > 0) {
      const text = linter.printErrors(fileName, errorOnly, cwd)
      if (text) {
        process.stdout.write(text)
        if (!text.endsWith("\n")) process.stdout.write("\n")
      }
    }

    for (const d of diagnostics) {
      const sev = d.severity ?? SEVERITY_ERROR
      if (sev === SEVERITY_ERROR) errors += 1
      else if (sev === SEVERITY_WARNING) warnings += 1
    }
  }

  return { filesChecked: fileNames.length, errors, warnings }
}

function resolveTsconfig(cwd: string, supplied: string | undefined): string | undefined {
  if (supplied) {
    return path.isAbsolute(supplied) ? supplied : path.resolve(cwd, supplied)
  }
  return ts.findConfigFile(cwd, ts.sys.fileExists)
}
