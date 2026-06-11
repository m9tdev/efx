#!/usr/bin/env node
/**
 * CLI for `verrex/check`.
 *
 *   verrex-check                  # use tsconfig.json found from cwd
 *   verrex-check --tsconfig path  # explicit tsconfig.json
 *   verrex-check --root dir       # cwd override (resolved before --tsconfig)
 *   verrex-check --watch          # incremental re-check on file change
 *
 * Flag semantics follow `astro check` (the parity target), with one
 * deliberate divergence: `--minimumSeverity` defaults to `error` (astro:
 * `hint`) so the bare invocation stays a drop-in for `tsc --noEmit` —
 * see the behavior contract in AGENTS.md.
 */
import * as path from "node:path"
import { parseArgs } from "node:util"
import {
  createChecker,
  runCheck,
  shouldFail,
  SEVERITIES,
  type CheckOptions,
  type CheckResult,
  type Severity,
} from "./index.ts"

const OPTIONS = {
  tsconfig: { type: "string", short: "p" },
  root: { type: "string" },
  watch: { type: "boolean", short: "w", default: false },
  minimumSeverity: { type: "string", default: "error" },
  minimumFailingSeverity: { type: "string", default: "error" },
  preserveWatchOutput: { type: "boolean", default: false },
} as const

function usageError(message: string): never {
  console.error(`verrex-check: ${message}`)
  printHelp()
  process.exit(2)
}

function parseCliArgs(argv: ReadonlyArray<string>) {
  // Help wins over everything else on the line, including invalid flags —
  // `verrex-check --help <candidate-flag>` is a capability probe, not an error.
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp()
    process.exit(0)
  }
  const values = (() => {
    try {
      // parseArgs rejects unknown flags, missing option values, and flag-like
      // values (`--root --watch`) — the failure modes a hand-rolled
      // `argv[++i]` loop silently swallows.
      return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }).values
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error))
    }
  })()
  const severity = (flag: string, value: string): Severity => {
    if ((SEVERITIES as ReadonlyArray<string>).includes(value)) return value as Severity
    usageError(`${flag} expects one of: ${SEVERITIES.join(", ")}`)
  }
  return {
    root: values.root,
    tsconfig: values.tsconfig,
    watch: values.watch,
    minimumSeverity: severity("--minimumSeverity", values.minimumSeverity),
    minimumFailingSeverity: severity("--minimumFailingSeverity", values.minimumFailingSeverity),
    preserveWatchOutput: values.preserveWatchOutput,
  }
}

function printHelp(): void {
  process.stdout.write(`verrex-check — type-check a verrex project via Volar

Usage:
  verrex-check [--tsconfig <path>] [--root <dir>] [--watch] [severity flags]

Options:
  --tsconfig, -p <path>          Path to tsconfig.json (relative to --root or absolute)
  --root <dir>                   Project root (defaults to cwd)
  --watch, -w                    Re-check on .vx/.ts change without restarting
  --minimumSeverity <s>          Minimum severity to print: error|warning|hint (default: error)
  --minimumFailingSeverity <s>   Minimum severity that fails the exit code: error|warning|hint (default: error)
  --preserveWatchOutput          Don't clear the screen between watch re-checks
  --help, -h                     Show this help

Exit codes:
  0  nothing at or above --minimumFailingSeverity
  1  failing diagnostics found
  2  usage error
`)
}

// Color only when stdout is a TTY and the consumer hasn't opted out
// (https://no-color.org). The per-diagnostic output is colored upstream by
// ts.formatDiagnosticsWithColorAndContext; this gates our summary lines.
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const paint = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s
const bold = paint(1, 22)
const dim = paint(2, 22)
const red = paint(31, 39)
const yellow = paint(33, 39)

function formatSummary(result: CheckResult, minimumSeverity: Severity): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const parts = [
    result.errors > 0 ? bold(red(plural(result.errors, "error"))) : dim("0 errors"),
  ]
  // A nonzero count always surfaces, whatever the print threshold — any
  // severity can fail the run via --minimumFailingSeverity, and an exit 1
  // must never come with a summary that reads clean.
  if (minimumSeverity !== "error" || result.warnings > 0) {
    parts.push(result.warnings > 0 ? bold(yellow(plural(result.warnings, "warning"))) : dim("0 warnings"))
  }
  if (minimumSeverity === "hint" || result.hints > 0) {
    parts.push(dim(plural(result.hints, "hint")))
  }
  return `\n${bold(`Checked ${plural(result.filesChecked, "file")}:`)} ${parts.join(", ")}\n`
}

// Every extension the checker can ingest (the TS family plus .vx) — NOT the
// extensions the project happens to contain at startup, so the first file of
// a new kind still fires its add event. Config files are allowed through
// separately in the `ignored` predicate.
const WATCHED_EXTENSIONS = new Set(
  [".vx", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
)

function invocationError(error: unknown): never {
  console.error(`verrex-check: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const args = parseCliArgs(process.argv.slice(2))
const checkOptions: CheckOptions = { minimumSeverity: args.minimumSeverity }
if (args.root !== undefined) checkOptions.cwd = args.root
if (args.tsconfig !== undefined) checkOptions.tsconfig = args.tsconfig

if (args.watch) {
  // Loaded lazily: the one-shot path (CI, pre-commit) never pays for it.
  const { watch } = await import("chokidar")
  const checker = (() => {
    try {
      return createChecker(checkOptions)
    } catch (error) {
      invocationError(error)
    }
  })()

  // Watch where the program actually lives: the tsconfig's directory plus
  // every wildcard directory its include globs expand under (which may sit
  // outside it — `"include": ["../shared/**"]`), plus the config files
  // themselves (an extends base can sit anywhere). Imported sources outside
  // these trees (workspace dependencies) are added file-by-file below.
  const watchDirs = [
    ...new Set([path.dirname(checker.tsconfigPath), ...checker.getWildcardDirectories()]),
  ]

  const hasIgnoredSegment = (segments: ReadonlyArray<string>) =>
    segments.includes("node_modules") || segments.includes(".git")

  const watcher = watch([...new Set([...watchDirs, ...checker.getConfigFilePaths()])], {
    ignored: (p, stats) => {
      const abs = path.resolve(p)
      if (checker.getConfigFilePaths().includes(abs)) return false
      // Match whole path segments below the containing watch dir — substring
      // tests would ignore the entire tree of e.g. a `user.github.io`
      // checkout. Explicitly-added files outside every dir fall through with
      // their absolute segments.
      const base = watchDirs.find((d) => abs === d || abs.startsWith(d + path.sep))
      const segments = (base ? path.relative(base, abs) : abs).split(path.sep)
      if (hasIgnoredSegment(segments)) return true
      return stats?.isFile() === true && !WATCHED_EXTENSIONS.has(path.extname(abs))
    },
    ignoreInitial: true,
  })

  // Files the program pulled in from outside the watched trees — workspace
  // dependency sources (`@verrex/core` dev exports resolve to
  // packages/core/src/*.ts from the demo). tsc --watch covers these; a watch
  // that doesn't reports stale results until an unrelated in-tree save.
  const watchedFiles = new Set<string>()
  const knownFiles = new Set<string>(checker.getRootFileNames().map((f) => path.resolve(f)))
  const refreshTrackedFiles = () => {
    for (const fileName of [...checker.getRootFileNames(), ...checker.getTrackedFileNames()]) {
      const abs = path.resolve(fileName)
      knownFiles.add(abs)
      if (watchedFiles.has(abs)) continue
      if (watchDirs.some((d) => abs.startsWith(d + path.sep))) continue
      if (hasIgnoredSegment(abs.split(path.sep))) continue
      if (!WATCHED_EXTENSIONS.has(path.extname(abs))) continue
      watchedFiles.add(abs)
      watcher.add(abs)
    }
  }

  // Debounced re-check: each trigger bumps `req`; an in-flight pass polls its
  // own ticket and yields as soon as it's superseded. The screen clear sits
  // after the debounce, only on a TTY, and only once a previous pass has
  // actually printed — ticket ordinality alone would wipe the user's
  // scrollback at startup when the first pass is superseded before printing.
  let req = 0
  let anyPassCompleted = false
  const lint = async (): Promise<void> => {
    const current = ++req
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (current !== req) return
    if (anyPassCompleted && !args.preserveWatchOutput && process.stdout.isTTY === true) {
      process.stdout.write("\x1bc")
    }
    try {
      const result = await checker.check({ cancel: () => current !== req })
      if (current !== req) return
      anyPassCompleted = true
      refreshTrackedFiles()
      process.stdout.write(
        formatSummary(result, args.minimumSeverity) + dim("Watching for changes...") + "\n",
      )
    } catch (error) {
      // A failing pass (tsconfig briefly missing mid-checkout, a transform
      // crash on an unrecoverable mid-edit file) must not kill the session —
      // report and keep watching; the project re-checks on the next event.
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`verrex-check: ${message}\n`)
      process.stdout.write(dim("Watching for changes...") + "\n")
    }
  }

  // A change/unlink for a file that was never part of the project (build
  // output, scratch files) can't alter diagnostics — skip the pass. Adds
  // can join the project, so they always go through (the shape comparison
  // in the checker keeps irrelevant ones from rebuilding anything).
  const isRelevant = (abs: string) =>
    knownFiles.has(abs) || checker.getConfigFilePaths().includes(abs)

  watcher
    .on("add", (fileName) => {
      checker.fileCreated(fileName)
      void lint()
    })
    .on("change", (fileName) => {
      const abs = path.resolve(fileName)
      if (!isRelevant(abs)) return
      checker.fileUpdated(abs)
      void lint()
    })
    .on("unlink", (fileName) => {
      if (!isRelevant(path.resolve(fileName))) return
      checker.fileDeleted(fileName)
      void lint()
    })
    .on("error", (error) => {
      // An unhandled 'error' event would crash the watch session (chokidar
      // emits one for EPERM/EACCES dirs and inotify ENOSPC). Report and keep
      // watching — the checker itself is unaffected.
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`verrex-check: watcher error: ${message}\n`)
    })

  // First pass runs immediately; the watcher keeps the process alive
  // afterwards. Watch mode never exits non-zero on diagnostics.
  await lint()
} else {
  const result = await runCheck(checkOptions).catch(invocationError)
  // Await the final write's flush callback before exiting: stdout-to-pipe is
  // async on Linux and process.exit() does not drain it — a large diagnostic
  // dump piped to a slow reader would otherwise be truncated. Writes are
  // FIFO, so flushing the last one flushes everything before it.
  await new Promise<void>((resolve) => {
    process.stdout.write(formatSummary(result, args.minimumSeverity), () => resolve())
  })
  process.exit(shouldFail(result, args.minimumFailingSeverity) ? 1 : 0)
}
