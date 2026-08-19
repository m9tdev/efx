import * as path from "node:path"
import * as ts from "typescript"
import * as kit from "@volar/kit"
import { create as createTypeScriptServices } from "volar-service-typescript"
import { URI } from "vscode-uri"
import {
  createVerrexLanguagePlugin,
  createVerrexServicePlugin,
} from "@verrex/core/language"

// LSP DiagnosticSeverity constants (stable wire protocol).
// `@volar/language-service` re-exports the type but not the values, so we
// inline these to avoid pulling in another package just for the enum.
const SEVERITY_ERROR = 1
const SEVERITY_WARNING = 2
const SEVERITY_HINT = 4

/**
 * Severity threshold names, matching `astro check`'s flag vocabulary. `"error"`
 * < `"warning"` < `"hint"` — each level includes the ones before it (`"hint"`
 * also admits LSP Information, like astro's `severity <= Hint` filter).
 */
export const SEVERITIES = ["error", "warning", "hint"] as const
export type Severity = (typeof SEVERITIES)[number]

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
  /**
   * Total diagnostics below warning — LSP Hint (TS "suggestions", e.g. unused
   * locals) and LSP Information both land here, mirroring the `"hint"` print
   * ceiling so everything printable is counted somewhere.
   */
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
  /**
   * Notify the checker of a created file (re-expands the tsconfig include
   * globs).
   */
  fileCreated(fileName: string): void
  /**
   * Notify the checker of an in-place edit (bumps the project version; content
   * re-read from disk). An edit to the tsconfig itself marks the whole project
   * stale instead — compiler options and include globs are re-parsed.
   */
  fileUpdated(fileName: string): void
  /**
   * Notify the checker of a deletion (re-expands the tsconfig include globs).
   */
  fileDeleted(fileName: string): void
  /** Current root file names (re-resolved after create/delete events). */
  getRootFileNames(): string[]
  /** Absolute path of the tsconfig this checker resolved. */
  readonly tsconfigPath: string
  /**
   * The tsconfig plus its `extends` chain (absolute). An update event on any
   * of them re-parses the project — base configs change options/includes just
   * as the top-level one does.
   */
  getConfigFilePaths(): string[]
  /**
   * Directories the tsconfig's include globs expand under (absolute) — the
   * directories a watcher must cover, which are NOT necessarily under the
   * tsconfig's own directory (`"include": ["../shared/**"]`).
   */
  getWildcardDirectories(): string[]
  /**
   * Every file-scheme document the checker has pulled into the program so
   * far — root files plus imported sources (e.g. workspace dependencies
   * resolved outside the include globs). Grows as checks run; a watcher can
   * use it to cover dependency files the way `tsc --watch` does.
   */
  getTrackedFileNames(): string[]
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
 * `fileCreated`/`fileDeleted` (and tsconfig edits) mark the project stale
 * instead, and the kit checker is rebuilt lazily — once, at the start of the
 * next `check()` — because kit's own root-file re-expansion is broken
 * upstream (its `getScriptFileNames` caches resolved names in a WeakMap
 * keyed by a `ParsedCommandLine` it then mutates in place, so a re-parsed
 * include glob is never observed — present in `@volar/kit` ≤ 2.4.28 and on
 * volar main). Lazy means a burst of N add/remove events (git checkout,
 * codegen) costs one project construction, not N — and none at all when a
 * fresh config parse shows the root set and options unchanged (build-output
 * churn never enters the include globs).
 */
export function createChecker(options: CheckOptions = {}): VerrexChecker {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const minimumSeverity = options.minimumSeverity ?? "error"
  const printCeiling = SEVERITY_CEILING[minimumSeverity]

  const foundTsconfig = resolveTsconfig(cwd, options.tsconfig)
  if (!foundTsconfig) {
    throw new Error(
      `No tsconfig.json found from ${cwd}. Pass --tsconfig <path> or run from a directory containing one.`,
    )
  }
  // Normalized so fileUpdated can reliably recognize edits to the tsconfig.
  const tsconfigPath = path.resolve(foundTsconfig)

  // Every file the language syncs from disk — roots AND imported sources
  // (workspace dependencies resolved outside the include globs). Volar
  // consults each plugin's getLanguageId for every script it registers, so a
  // passive plugin ahead of the verrex one observes the whole program through
  // public API (kit exposes no program/script iteration). Accumulates across
  // rebuilds; stale entries are harmless for the watch use case.
  const trackedFiles = new Set<string>()
  const trackingPlugin = {
    getLanguageId: (uri: URI) => {
      if (uri.scheme === "file") trackedFiles.add(uri.fsPath)
      return undefined
    },
  }

  // `@volar/kit` uses `URI` as the script-id type, so the plugin gets URIs
  // and reduces them to filesystem paths for the compiler. The kit checker
  // owns the virtual-code lifetime per linter instance; we hold no
  // side-channel state of our own.
  const buildLinter = () => {
    // "throw" (not the editor default "recover"): a checker must fail loudly
    // on unparseable source, never report against a stale last-good compile.
    // The watch loop catches per-pass and keeps running.
    const languagePlugin = createVerrexLanguagePlugin<URI>(
      (uri) => uri.fsPath,
      {
        onTransformError: "throw",
      },
    )
    const tsServices = createTypeScriptServices(ts)
    return kit.createTypeScriptChecker(
      [trackingPlugin, languagePlugin],
      // + the compiler's own diagnostics (a nested `get(...)`), reported at
      // their source position like any TS error.
      [...tsServices, createVerrexServicePlugin()],
      tsconfigPath,
    )
  }

  // The same extraFileExtensions kit hands to its own config parse, so our
  // shape snapshot expands include globs identically (`.vx` admitted).
  const extraFileExtensions =
    createVerrexLanguagePlugin<URI>((uri) => uri.fsPath).typescript
      ?.extraFileExtensions ?? []

  interface ProjectShape {
    /** Sorted, for cheap equality. */
    fileNames: string[]
    optionsKey: string
    configFiles: string[]
    wildcardDirectories: string[]
  }

  // One cheap config parse (milliseconds — no language service) describing
  // what the project would look like if rebuilt now. Throws a friendly error
  // when the tsconfig is missing/unreadable: TS 6's parser otherwise dies
  // with an internal TypeError deep in typescript.js.
  const parseProjectShape = (): ProjectShape => {
    if (!ts.sys.fileExists(tsconfigPath)) {
      throw new Error(`tsconfig not found at ${tsconfigPath}`)
    }
    const sourceFile = ts.readJsonConfigFile(tsconfigPath, ts.sys.readFile)
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      sourceFile,
      ts.sys,
      path.dirname(tsconfigPath),
      undefined,
      tsconfigPath,
      undefined,
      extraFileExtensions,
    )
    return {
      fileNames: parsed.fileNames.map((f) => path.resolve(f)).sort(),
      optionsKey: JSON.stringify(parsed.options),
      configFiles: [
        tsconfigPath,
        ...(sourceFile.extendedSourceFiles ?? []).map((f) => path.resolve(f)),
      ],
      wildcardDirectories: Object.keys(parsed.wildcardDirectories ?? {}).map(
        (d) => path.resolve(d),
      ),
    }
  }

  let shape = parseProjectShape()
  let linter = buildLinter()
  let projectStale = false
  const markProjectStale = () => {
    projectStale = true
  }
  const freshLinter = () => {
    if (projectStale) {
      // Re-snapshot first and rebuild only when the project actually changed:
      // create/delete churn that never enters the root set (build output,
      // editor temp files) must not pay a full language-service rebuild.
      // A parse throw (tsconfig briefly missing mid-`git checkout`) leaves
      // `projectStale` set, so the next call retries instead of silently
      // serving the outdated project.
      const next = parseProjectShape()
      const changed =
        next.optionsKey !== shape.optionsKey ||
        next.fileNames.length !== shape.fileNames.length ||
        next.fileNames.some((fileName, i) => fileName !== shape.fileNames[i])
      shape = next
      if (changed) linter = buildLinter()
      projectStale = false
    }
    return linter
  }

  async function check(
    checkOptions: { cancel?: () => boolean } = {},
  ): Promise<CheckResult> {
    const cancel = checkOptions.cancel ?? (() => false)
    const result: CheckResult = {
      filesChecked: 0,
      errors: 0,
      warnings: 0,
      hints: 0,
    }

    // Pin the instance for the whole pass — a superseded-but-draining pass
    // must not pick up a rebuild a newer overlapping pass just performed.
    const pass = freshLinter()
    for (const fileName of pass.getRootFileNames()) {
      if (cancel()) return result
      const diagnostics = await pass.check(fileName)
      // Re-check after the await: a pass superseded mid-file must not print
      // stale diagnostics over the newer pass's output.
      if (cancel()) return result
      result.filesChecked += 1
      if (diagnostics.length === 0) continue

      const toPrint = diagnostics.filter(
        (d) => (d.severity ?? SEVERITY_ERROR) <= printCeiling,
      )
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
        // Everything below warning (LSP Information 3 and Hint 4) counts as a
        // hint — the same bucket the "hint" print ceiling admits, so nothing
        // can print yet be invisible to the counts and the exit code.
        else result.hints += 1
      }
    }

    return result
  }

  return {
    check,
    fileCreated: markProjectStale,
    fileUpdated: (fileName) => {
      if (shape.configFiles.includes(path.resolve(fileName))) markProjectStale()
      else linter.fileUpdated(fileName)
    },
    fileDeleted: markProjectStale,
    getRootFileNames: () => freshLinter().getRootFileNames(),
    tsconfigPath,
    getConfigFilePaths: () => [...shape.configFiles],
    getWildcardDirectories: () => [...shape.wildcardDirectories],
    getTrackedFileNames: () => [...trackedFiles],
  }
}

/**
 * Type-check a verrex project once. Returns a summary; the printed output
 * goes to stdout in tsc's standard "file:line:col - error TS####: message"
 * format (via Volar kit's printErrors helper). Each call builds an
 * independent checker — use `createChecker` to keep one alive across runs.
 */
export async function runCheck(
  options: CheckOptions = {},
): Promise<CheckResult> {
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
    default:
      // Unreachable for TS callers; guards untyped JS callers passing a typo'd
      // threshold, which must not read as "success" (astro has the same arm).
      return result.errors > 0
  }
}

function resolveTsconfig(
  cwd: string,
  supplied: string | undefined,
): string | undefined {
  if (supplied) {
    return path.isAbsolute(supplied) ? supplied : path.resolve(cwd, supplied)
  }
  return ts.findConfigFile(cwd, ts.sys.fileExists)
}
