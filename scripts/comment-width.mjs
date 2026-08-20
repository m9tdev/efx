// Comment line-width check (and reflow with --fix). oxfmt leaves comment text
// alone and oxlint has no max-len, so this keeps `//` and ` * ` prose inside
// the same 80 columns as code. Exempt: URLs, table rows (`|`), directives
// (`@ts-…`), section headers (`───`), fenced code, indented samples/diagrams.
// The reflow logic is pure and lives in `comment-width-core.mjs` (tested by
// `comment-width.test.mjs`); this shell owns the file list, writes, and the
// exit code.
//
//   node scripts/comment-width.mjs          # report (exit 1 on offenders)
//   node scripts/comment-width.mjs --fix    # reflow paragraphs in place
import { readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { overlongCommentLines, processSource } from "./comment-width-core.mjs"

const fix = process.argv.includes("--fix")
const files = execSync(
  "git ls-files 'packages/**/*.ts' 'packages/**/*.mjs' 'apps/**/*.ts' 'apps/**/*.vx' 'scripts/*.mjs'",
  { encoding: "utf8" },
)
  .split("\n")
  .filter((f) => f && !f.includes("/dist/") && !f.endsWith("CHANGELOG.md"))

let bad = 0
for (const file of files) {
  const src = readFileSync(file, "utf8")
  const { text, paragraphs, changed } = processSource(src, { fix })
  bad += paragraphs
  if (fix && changed) writeFileSync(file, text)
}
// Report: reflowable overflow (fixable) plus every exempt comment line that is
// still too long (URLs aside — those cannot be shortened by hand either).
const long = []
for (const file of files) {
  for (const { line, length } of overlongCommentLines(
    readFileSync(file, "utf8"),
  ))
    long.push(`${file}:${line} (${length})`)
}
if (fix) console.log(`comment-width: reflowed ${bad} paragraph(s)`)
if (bad > 0 && !fix)
  console.error(
    `comment-width: ${bad} comment paragraph(s) exceed 80 columns — run \`node scripts/comment-width.mjs --fix\``,
  )
if (long.length > 0) {
  console.error(
    `comment-width: ${long.length} comment line(s) over 80 columns need a hand edit (directive, header, code sample):`,
  )
  for (const l of long) console.error("  " + l)
}
if ((bad > 0 && !fix) || long.length > 0) process.exit(1)
