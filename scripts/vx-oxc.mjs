// Runs oxlint / oxfmt over `.vx` files.
//
// Neither tool can be taught about `.vx`: the extension→language map is
// hardcoded in Rust (`oxc_span`'s `VALID_EXTENSIONS`) ahead of any user-facing
// extension point. oxlint's JS plugin API takes `{ meta, rules }` only — no
// ESLint-style `processors` — and oxfmt has no plugin system at all. So we
// mirror each `.vx` into a shadow tree of `.tsx` symlinks and point the tools
// at those instead. `.vx` is exactly TypeScript + JSX, so the tsx parser is
// the correct reader for it.
//
// oxfmt writes THROUGH the symlink, so `format` lands in the real source file.
//
// Two constraints worth knowing before editing:
//   - Pass explicit FILE paths, never the shadow directory. Both tools apply
//     .gitignore to directory arguments, and the shadow lives under
//     node_modules/ — a directory argument would be silently filtered to zero
//     files. Explicit file paths bypass that.
//   - Run from the repo root so `.oxlintrc.json` / `.oxfmtrc.json` resolve.
//
// Caveat: this lints `.vx` as TSX, which means a JSX-semantics rule would
// apply React assumptions to syntax that has none (see the root AGENTS.md).
// Safe under the current config — no react / jsx-a11y plugin is enabled — but
// don't turn those on without revisiting this.

import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const MODES = {
  lint: "oxlint",
  "lint:fix": "oxlint",
  format: "oxfmt",
  "format:check": "oxfmt",
}

const mode = process.argv[2]
if (!(mode in MODES)) {
  console.error(`usage: vx-oxc.mjs <${Object.keys(MODES).join("|")}>`)
  process.exit(2)
}

const root = process.cwd()
const shadow = join(root, "node_modules", ".cache", "vx-shadow")

// `--others --exclude-standard` so new, not-yet-committed `.vx` files are
// covered too — they are the ones most likely to be unformatted.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.vx"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)

if (files.length === 0) process.exit(0)

rmSync(shadow, { recursive: true, force: true })
const links = files.map((file) => {
  const link = join(shadow, `${file}.tsx`)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(resolve(root, file), link)
  return link
})

// oxlint --fix and oxfmt (write mode) both edit through the symlink, so the
// rewrite lands in the real `.vx` source.
const FLAGS = {
  lint: ["--format=default"],
  "lint:fix": ["--format=default", "--fix"],
  "format:check": ["--check"],
  format: [],
}
const flags = FLAGS[mode]

let out = ""
let code = 0
try {
  out = execFileSync(
    join(root, "node_modules", ".bin", MODES[mode]),
    [...flags, ...links],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
} catch (error) {
  out = `${error.stdout ?? ""}${error.stderr ?? ""}`
  code = error.status ?? 1
} finally {
  rmSync(shadow, { recursive: true, force: true })
}

// Rewrite shadow paths back to real `.vx` paths so diagnostics stay clickable.
// The tools print both absolute and cwd-relative forms, so strip either.
const relShadow = shadow.slice(root.length + 1)
process.stdout.write(
  out
    .split(`${shadow}/`)
    .join("")
    .split(`${relShadow}/`)
    .join("")
    .split(".vx.tsx")
    .join(".vx"),
)
process.exit(code)
