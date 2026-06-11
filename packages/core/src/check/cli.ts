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
  help: { type: "boolean", short: "h", default: false },
} as const

interface ParsedArgs {
  root: string | undefined
  tsconfig: string | undefined
  watch: boolean
  minimumSeverity: Severity
  minimumFailingSeverity: Severity
  preserveWatchOutput: boolean
}

function usageError(message: string): never {
  console.error(`verrex-check: ${message}`)
  printHelp()
  process.exit(2)
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"]
  try {
    // parseArgs rejects unknown flags, missing option values, and flag-like
    // values (`--root --watch`) — the failure modes a hand-rolled `argv[++i]`
    // loop silently swallows.
    values = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }).values
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error))
  }
  if (values.help) {
    printHelp()
    process.exit(0)
  }
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
  if (minimumSeverity !== "error" || result.warnings > 0) {
    parts.push(result.warnings > 0 ? bold(yellow(plural(result.warnings, "warning"))) : dim("0 warnings"))
  }
  if (minimumSeverity === "hint") {
    parts.push(dim(plural(result.hints, "hint")))
  }
  return `\n${bold(`Checked ${plural(result.filesChecked, "file")}:`)} ${parts.join(", ")}\n`
}

// Every extension the checker can ingest (the TS family plus .vx) — NOT the
// extensions the project happens to contain at startup, so the first file of
// a new kind still fires its add event. The tsconfig itself is allowed
// through separately in the `ignored` predicate.
const WATCHED_EXTENSIONS = new Set(
  [".vx", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
)

const args = parseCliArgs(process.argv.slice(2))
const checkOptions: CheckOptions = { minimumSeverity: args.minimumSeverity }
if (args.root !== undefined) checkOptions.cwd = args.root
if (args.tsconfig !== undefined) checkOptions.tsconfig = args.tsconfig

if (args.watch) {
  // Loaded lazily: the one-shot path (CI, pre-commit) never pays for it.
  const { watch } = await import("chokidar")
  const checker = createChecker(checkOptions)

  // Watch the directory the tsconfig anchors its include globs to — not the
  // invocation cwd, which can be elsewhere (`--tsconfig ../app/tsconfig.json`
  // from a sibling dir would otherwise watch the wrong tree entirely).
  const watchRoot = path.dirname(checker.tsconfigPath)

  // Debounced re-check: each trigger bumps `req`; an in-flight pass polls its
  // own ticket and yields as soon as it's superseded. The screen clear sits
  // after the debounce (one clear per executed pass, none for coalesced
  // events) and is TTY-gated — a pipe must never receive the reset sequence.
  let req = 0
  const lint = async (): Promise<void> => {
    const current = ++req
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (current !== req) return
    if (current > 1 && !args.preserveWatchOutput && process.stdout.isTTY === true) {
      process.stdout.write("\x1bc")
    }
    const result = await checker.check({ cancel: () => current !== req })
    if (current !== req) return
    process.stdout.write(formatSummary(result, args.minimumSeverity))
    process.stdout.write(dim("Watching for changes...") + "\n")
  }

  watch(watchRoot, {
    ignored: (p, stats) => {
      if (path.resolve(p) === checker.tsconfigPath) return false
      // Match whole path segments below the watch root — substring tests
      // would ignore the entire tree of e.g. a `user.github.io` checkout.
      const segments = path.relative(watchRoot, p).split(path.sep)
      if (segments.includes("node_modules") || segments.includes(".git")) return true
      return stats?.isFile() === true && !WATCHED_EXTENSIONS.has(path.extname(p))
    },
    ignoreInitial: true,
  })
    .on("add", (fileName) => {
      checker.fileCreated(fileName)
      void lint()
    })
    .on("change", (fileName) => {
      checker.fileUpdated(fileName)
      void lint()
    })
    .on("unlink", (fileName) => {
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
  const result = await runCheck(checkOptions)
  // Await the final write's flush callback before exiting: stdout-to-pipe is
  // async on Linux and process.exit() does not drain it — a large diagnostic
  // dump piped to a slow reader would otherwise be truncated. Writes are
  // FIFO, so flushing the last one flushes everything before it.
  await new Promise<void>((resolve) => {
    process.stdout.write(formatSummary(result, args.minimumSeverity), () => resolve())
  })
  process.exit(shouldFail(result, args.minimumFailingSeverity) ? 1 : 0)
}
