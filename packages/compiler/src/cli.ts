#!/usr/bin/env node
/**
 * CLI: walk a directory tree, compile every `.efx` file to a sibling `.ts`
 * file with `// @generated` banner.
 *
 *   efx-compile <rootDir>
 *
 * Output `.ts` files are what `tsc` reads — they contain only `h()` calls,
 * no JSX. The corresponding `.efx` files remain the source of truth for
 * humans and for the Vite dev pipeline.
 */
import { promises as fs } from "node:fs"
import { join, relative } from "node:path"
import { transformEfx } from "./transform.ts"

const BANNER = "// @generated — do not edit. Source: "

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      out.push(...(await walk(full)))
    } else if (entry.isFile() && entry.name.endsWith(".efx")) {
      out.push(full)
    }
  }
  return out
}

async function compileFile(file: string, root: string): Promise<void> {
  const source = await fs.readFile(file, "utf8")
  const { code } = transformEfx(source, file)
  const tsPath = file.replace(/\.efx$/, ".ts")
  const rel = relative(root, file)
  await fs.writeFile(tsPath, `${BANNER}${rel}\n${code}`, "utf8")
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? "."
  const files = await walk(root)
  if (files.length === 0) {
    console.log(`[efx-compile] no .efx files under ${root}`)
    return
  }
  await Promise.all(files.map((f) => compileFile(f, root)))
  console.log(`[efx-compile] ${files.length} file(s) compiled`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
