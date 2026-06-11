import * as path from "node:path"
import * as ts from "typescript"
import * as kit from "@volar/kit"
import { create as createTypeScriptServices } from "volar-service-typescript"
import { URI } from "vscode-uri"
import { createVerrexLanguagePlugin } from "@verrex/core/language"

// LSP DiagnosticSeverity constants (stable wire protocol). `@volar/language-service`
// re-exports the type but not the values, so we inline these to avoid pulling in
// another package just for the enum.
const SEVERITY_ERROR = 1
const SEVERITY_WARNING = 2
const SEVERITY_HINT = 4

/**
 * Severity threshold names, matching `astro check`'s flag vocabulary.
 * `"error"` < `"warning"` < `"hint"` — each level includes the ones before it
 * (`"hint"` also admits LSP Information, like astro's `severity <= Hint` filter).
 */
export type Severity = "error" | "warning" | "hint"

const SEVERITY_CEILING: Record<Severity, number> = {
  error: SEVERITY_ERROR,
  warning: SEVERITY_WARNING,
  hint: SEVERITY_HINT,
}

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
  /**
   * Minimum severity that gets *printed* (counting is unaffected).
   * Defaults to `"error"` — the bare `tsc --noEmit` baseline this tool
   * replaces. (astro check defaults to `"hint"`; the flag semantics match,
   * only the default differs.)
   */
  minimumSeverity?: Severity
}

export interface CheckResult {
  /** Number of root files inspected (including non-`.vx` TS files). */
  filesChecked: number
  /** Total error-severity diagnostics across all files. */
  errors: number
  /** Total warning-severity diagnostics. */
  warnings: number
  /** Total hint-severity diagnostics (TS "suggestions", e.g. unused locals). */
  hints: number
}

export interface VerrexChecker {
  /**
   * Check every root file, printing qualifying diagnostics to stdout as they
   * are found. `cancel` is polled between files; a cancelled run returns the
   * counts accumulated so far (callers driving a re-check loop should discard
   * superseded results themselves).
   */
  check(options?: { cancel?: () => boolean }): Promise<CheckResult>
  /** Notify the checker of a created file (re-expands the tsconfig include globs). */
  fileCreated(fileName: string): void
  /** Notify the checker of an in-place edit (bumps the project version; content re-read from disk). */
  fileUpdated(fileName: string): void
  /** Notify the checker of a deletion (re-expands the tsconfig include globs). */
  fileDeleted(fileName: string): void
  /** Current root file names (re-resolved after create/delete events). */
  getRootFileNames(): string[]
}

/**
 * Build a persistent checker for a verrex project. The underlying
 * `ts.LanguageService` survives across `check()` calls, so a watch loop pays
 * incremental re-check cost, not project construction — feed file events in
 * via `fileCreated`/`fileUpdated`/`fileDeleted` (see `cli.ts` for the
 * chokidar wiring).
 *
 * `fileUpdated` (the hot path — every save) is incremental: kit bumps its
 * project version and the edited file's snapshot is re-read from disk.
 * `fileCreated`/`fileDeleted` rebuild the kit checker instead: kit's own root
 * file re-expansion is broken upstream (its `getScriptFileNames` caches
 * resolved names in a WeakMap keyed by a `ParsedCommandLine` it then mutates
 * in place, so a re-parsed include glob is never observed — present in
 * `@volar/kit` ≤ 2.4.28 and on volar main). Rebuild costs one project
 * construction, only on the rare add/remove events.
 */
export function createChecker(options: CheckOptions = {}): VerrexChecker {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const minimumSeverity = options.minimumSeverity ?? "error"
  const printCeiling = SEVERITY_CEILING[minimumSeverity]

  const tsconfigPath = resolveTsconfig(cwd, options.tsconfig)
  if (!tsconfigPath) {
    throw new Error(
      `No tsconfig.json found from ${cwd}. Pass --tsconfig <path> or run from a directory containing one.`,
    )
  }

  // `@volar/kit` uses `URI` as the script-id type, so the plugin gets URIs
  // and reduces them to filesystem paths for the compiler. The kit checker
  // owns the virtual-code lifetime per linter instance; we hold no
  // side-channel state of our own.
  const buildLinter = () => {
    const languagePlugin = createVerrexLanguagePlugin<URI>((uri) => uri.fsPath)
    const tsServices = createTypeScriptServices(ts)
    return kit.createTypeScriptChecker([languagePlugin], tsServices, tsconfigPath)
  }
  let linter = buildLinter()

  async function check(checkOptions: { cancel?: () => boolean } = {}): Promise<CheckResult> {
    const cancel = checkOptions.cancel ?? (() => false)
    const result: CheckResult = { filesChecked: 0, errors: 0, warnings: 0, hints: 0 }

    // Pin the instance for the whole pass — a create/delete event arriving
    // mid-pass swaps `linter`, and mixing instances would skew the counts.
    const pass = linter
    for (const fileName of pass.getRootFileNames()) {
      if (cancel()) return result
      const diagnostics = await pass.check(fileName)
      result.filesChecked += 1
      if (diagnostics.length === 0) continue

      const toPrint = diagnostics.filter((d) => (d.severity ?? SEVERITY_ERROR) <= printCeiling)
      if (toPrint.length > 0) {
        const text = pass.printErrors(fileName, toPrint, cwd)
        if (text) {
          process.stdout.write(text)
          if (!text.endsWith("\n")) process.stdout.write("\n")
        }
      }

      for (const d of diagnostics) {
        const sev = d.severity ?? SEVERITY_ERROR
        if (sev === SEVERITY_ERROR) result.errors += 1
        else if (sev === SEVERITY_WARNING) result.warnings += 1
        else if (sev === SEVERITY_HINT) result.hints += 1
      }
    }

    return result
  }

  return {
    check,
    fileCreated: () => {
      linter = buildLinter()
    },
    fileUpdated: (fileName) => linter.fileUpdated(fileName),
    fileDeleted: () => {
      linter = buildLinter()
    },
    getRootFileNames: () => linter.getRootFileNames(),
  }
}

/**
 * Type-check a verrex project once. Returns a summary; the printed output
 * goes to stdout in tsc's standard "file:line:col - error TS####: message"
 * format (via Volar kit's printErrors helper). Each call builds an
 * independent checker — use `createChecker` to keep one alive across runs.
 */
export async function runCheck(options: CheckOptions = {}): Promise<CheckResult> {
  return createChecker(options).check()
}

/**
 * Whether `result` should fail the process, astro-check semantics: each
 * threshold also fails on everything more severe (`"hint"` fails on any
 * unfixed hint, warning, or error). Defaults to `"error"`.
 */
export function shouldFail(
  result: CheckResult,
  minimumFailingSeverity: Severity = "error",
): boolean {
  switch (minimumFailingSeverity) {
    case "error":
      return result.errors > 0
    case "warning":
      return result.errors + result.warnings > 0
    case "hint":
      return result.errors + result.warnings + result.hints > 0
  }
}

function resolveTsconfig(cwd: string, supplied: string | undefined): string | undefined {
  if (supplied) {
    return path.isAbsolute(supplied) ? supplied : path.resolve(cwd, supplied)
  }
  return ts.findConfigFile(cwd, ts.sys.fileExists)
}
