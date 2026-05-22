#!/usr/bin/env node
/**
 * Print the inferred TypeScript type of an exported symbol — same way `tsc`
 * would render it in an error message (i.e. using type aliases like `View`,
 * not the structurally-expanded union).
 *
 *   pnpm type UserPage
 *   pnpm type Counter
 *   pnpm type EfxLive
 *
 * Implementation: write a temp file that assigns the symbol to `never`,
 * run `tsc`, grep the resulting TS2322 error for the inferred type, clean up.
 */
import { execSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")
const demo = resolve(root, "apps/demo")

const symbol = process.argv[2]
if (!symbol) {
  console.error("usage: pnpm type <Symbol>")
  process.exit(1)
}

// Compile .efx → .ts so the `import` below resolves.
execSync("pnpm --filter @efx/demo efx:compile", { cwd: root, stdio: "ignore" })

// Find which file in apps/demo/src exports the symbol.
const srcDir = resolve(demo, "src")
const re = new RegExp(`export\\s+(const|function|class|let)\\s+${symbol}\\b`)
let sourceFile
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".efx") && !name.endsWith(".ts")) continue
  const full = resolve(srcDir, name)
  const content = execSync(`cat "${full}"`).toString()
  if (re.test(content)) {
    sourceFile = name.replace(/\.(efx|ts)$/, "")
    break
  }
}
if (!sourceFile) {
  console.error(`symbol "${symbol}" not exported from any file in apps/demo/src`)
  process.exit(1)
}

// Write a probe file and run tsc.
const probeName = `_probe-${symbol}-${process.pid}.ts`
const probePath = resolve(srcDir, probeName)
writeFileSync(
  probePath,
  `import { ${symbol} } from "./${sourceFile}"\n` +
    `const _PROBE: never = ${symbol}\n` +
    `void _PROBE\n`,
)

try {
  // tsc exits non-zero on type errors — that's our success path. Catch.
  let out = ""
  try {
    out = execSync("tsc --noEmit --noErrorTruncation", { cwd: demo, encoding: "utf8" })
  } catch (e) {
    out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")
  }
  // Pick the TS2322 line for our probe file.
  const line = out
    .split("\n")
    .find((l) => l.includes(probeName) && l.includes("TS2322"))
  if (!line) {
    console.error("(no type-mismatch error surfaced; symbol may already be `never`?)")
    console.error(out)
    process.exit(1)
  }
  // Pull the LHS type out of "Type 'X' is not assignable to type 'never'."
  const m = line.match(/Type '(.+)' is not assignable to type 'never'\./)
  if (m) {
    // `Data.TaggedEnum` types don't survive as named aliases in tsc's error
    // output — they render as their full structural union. Re-collapse the
    // View union back to `View` for readability. The outermost occurrence
    // ends exactly at `{ readonly _tag: "Empty"; }, ` (the comma+space
    // separating Effect's A from E); nested inner Views close differently
    // (e.g. `)[]`), so a non-greedy match catches just the outer one.
    const collapsed = m[1].replace(
      /\{ readonly _tag: "Text"; readonly value: string; \}.*?\{ readonly _tag: "Empty"; \}, /g,
      "View, ",
    )
    console.log(`${symbol}: ${collapsed}`)
  } else {
    console.log(line)
  }
} finally {
  if (existsSync(probePath)) rmSync(probePath)
}
