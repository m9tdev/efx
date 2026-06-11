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
import { createChecker, runCheck, shouldFail, type CheckResult, type Severity } from "./index.ts"

const SEVERITIES: ReadonlyArray<Severity> = ["error", "warning", "hint"]

interface ParsedArgs {
  root: string | undefined
  tsconfig: string | undefined
  watch: boolean
  minimumSeverity: Severity
  minimumFailingSeverity: Severity
  preserveWatchOutput: boolean
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = {
    root: undefined,
    tsconfig: undefined,
    watch: false,
    minimumSeverity: "error",
    minimumFailingSeverity: "error",
    preserveWatchOutput: false,
  }
  const severityValue = (flag: string, value: string | undefined): Severity => {
    if (value !== undefined && (SEVERITIES as ReadonlyArray<string>).includes(value)) {
      return value as Severity
    }
    console.error(`verrex-check: ${flag} expects one of: ${SEVERITIES.join(", ")}`)
    printHelp()
    process.exit(2)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--tsconfig" || arg === "-p") {
      out.tsconfig = argv[++i]
    } else if (arg === "--root") {
      out.root = argv[++i]
    } else if (arg === "--watch" || arg === "-w") {
      out.watch = true
    } else if (arg === "--minimumSeverity") {
      out.minimumSeverity = severityValue(arg, argv[++i])
    } else if (arg === "--minimumFailingSeverity") {
      out.minimumFailingSeverity = severityValue(arg, argv[++i])
    } else if (arg === "--preserveWatchOutput") {
      out.preserveWatchOutput = true
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`verrex-check: unknown argument: ${arg}`)
      printHelp()
      process.exit(2)
    }
  }
  return out
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

function printSummary(result: CheckResult, minimumSeverity: Severity): void {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const parts = [
    result.errors > 0 ? bold(red(plural(result.errors, "error"))) : dim("0 errors"),
  ]
  if (minimumSeverity === "warning" || minimumSeverity === "hint" || result.warnings > 0) {
    parts.push(result.warnings > 0 ? bold(yellow(plural(result.warnings, "warning"))) : dim("0 warnings"))
  }
  if (minimumSeverity === "hint") {
    parts.push(dim(plural(result.hints, "hint")))
  }
  process.stdout.write(
    `\n${bold(`Checked ${plural(result.filesChecked, "file")}:`)} ${parts.join(", ")}\n`,
  )
}

const args = parseArgs(process.argv.slice(2))
const checkOptions: { cwd?: string; tsconfig?: string; minimumSeverity: Severity } = {
  minimumSeverity: args.minimumSeverity,
}
if (args.root !== undefined) checkOptions.cwd = args.root
if (args.tsconfig !== undefined) checkOptions.tsconfig = args.tsconfig

if (args.watch) {
  // Loaded lazily: the one-shot path (CI, pre-commit) never pays for it.
  const { watch } = await import("chokidar")
  const checker = createChecker(checkOptions)
  const root = path.resolve(args.root ?? process.cwd())

  // Watch the extensions the project actually contains (derived from the
  // resolved root files — for verrex that's .vx plus .ts/.tsx etc.), not a
  // hardcoded list. Same trick as astro-check.
  const watchedExtensions = new Set(
    checker.getRootFileNames().map((fileName) => path.extname(fileName)),
  )

  // Debounced re-check: each trigger bumps `req`; an in-flight pass polls its
  // own ticket between files and yields as soon as it's superseded.
  let req = 0
  const lint = async (): Promise<void> => {
    const current = ++req
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (current !== req) return
    const result = await checker.check({ cancel: () => current !== req })
    if (current !== req) return
    printSummary(result, args.minimumSeverity)
    process.stdout.write(dim("Watching for changes...") + "\n")
  }
  const update = (): void => {
    if (!args.preserveWatchOutput) process.stdout.write("\x1bc")
    void lint()
  }

  watch(root, {
    ignored: (p, stats) =>
      p.includes("node_modules") ||
      p.includes(".git") ||
      (stats?.isFile() === true && !watchedExtensions.has(path.extname(p))),
    ignoreInitial: true,
  })
    .on("add", (fileName) => {
      checker.fileCreated(fileName)
      update()
    })
    .on("change", (fileName) => {
      checker.fileUpdated(fileName)
      update()
    })
    .on("unlink", (fileName) => {
      checker.fileDeleted(fileName)
      update()
    })

  // First pass runs immediately (no screen clear); the watcher keeps the
  // process alive afterwards. Watch mode never exits non-zero on diagnostics.
  await lint()
} else {
  const result = await runCheck(checkOptions)
  printSummary(result, args.minimumSeverity)
  process.exit(shouldFail(result, args.minimumFailingSeverity) ? 1 : 0)
}
