#!/usr/bin/env node
/**
 * CLI for `@efx/check`.
 *
 *   efx-check                  # use tsconfig.json found from cwd
 *   efx-check --tsconfig path  # explicit tsconfig.json
 *   efx-check --root dir       # cwd override (resolved before --tsconfig)
 *
 * Exit code: 0 if no errors, 1 otherwise (warnings do not fail).
 *
 * Not yet implemented (astro-parity TODO):
 *   - --watch              chokidar-based incremental check loop
 *   - --minimumSeverity    filter what's printed
 *   - --minimumFailingSeverity  control which severity bumps exit code
 *   - colored output       kleur or similar
 */
import { runCheck } from "./index.ts"

interface ParsedArgs {
  root: string | undefined
  tsconfig: string | undefined
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = { root: undefined, tsconfig: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--tsconfig" || arg === "-p") {
      out.tsconfig = argv[++i]
    } else if (arg === "--root") {
      out.root = argv[++i]
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`efx-check: unknown argument: ${arg}`)
      printHelp()
      process.exit(2)
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(`efx-check — type-check an efx project via Volar

Usage:
  efx-check [--tsconfig <path>] [--root <dir>]

Options:
  --tsconfig, -p <path>   Path to tsconfig.json (relative to --root or absolute)
  --root <dir>            Project root (defaults to cwd)
  --help, -h              Show this help

Exit codes:
  0  no errors
  1  errors found
  2  usage error
`)
}

const args = parseArgs(process.argv.slice(2))
const checkOptions: { cwd?: string; tsconfig?: string } = {}
if (args.root !== undefined) checkOptions.cwd = args.root
if (args.tsconfig !== undefined) checkOptions.tsconfig = args.tsconfig
const result = await runCheck(checkOptions)

const fileLabel = result.filesChecked === 1 ? "file" : "files"
process.stdout.write(
  `\nChecked ${result.filesChecked} ${fileLabel}: ${result.errors} error${result.errors === 1 ? "" : "s"}` +
    (result.warnings > 0 ? `, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}` : "") +
    "\n",
)

process.exit(result.errors > 0 ? 1 : 0)
