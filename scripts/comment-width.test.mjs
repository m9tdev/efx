// Pins the tricky comment shapes `comment-width-core.mjs` must handle — each
// case here was a real bug or a near-miss found by review. Run with
// `node --test scripts/`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { overlongCommentLines, processSource } from "./comment-width-core.mjs"

const fix = (src, width = 80) => processSource(src, { width, fix: true })
const check = (src, width = 80) => processSource(src, { width })

test("short comments pass untouched", () => {
  const src = "// fine\nconst x = 1\n"
  const r = check(src)
  assert.equal(r.paragraphs, 0)
  assert.equal(r.text, src)
})

test("long `//` paragraph reflows at the width and is idempotent", () => {
  const src = "// " + "word ".repeat(30).trim() + "\nconst x = 1\n"
  const r = fix(src)
  assert.equal(r.paragraphs, 1)
  for (const l of r.text.split("\n")) assert.ok(l.length <= 80, l)
  assert.equal(fix(r.text).changed, false)
})

test("one-line `/** … */` over width expands to a block; `*/` survives", () => {
  const src = "/** " + "word ".repeat(25).trim() + " */\nexport const y = 1\n"
  const r = fix(src)
  const lines = r.text.split("\n")
  assert.equal(lines[0], "/**")
  assert.equal(lines.at(-3), " */")
  assert.ok(lines.every((l) => l.length <= 80))
  assert.equal(fix(r.text).changed, false)
})

test("short one-line docblock stays one line", () => {
  const src = "/** short. */\nconst z = 1\n"
  assert.equal(fix(src).text, src)
})

test("blank comment line splits paragraphs (no swallowing)", () => {
  const src = ["// aaa " + "pad ".repeat(20).trim(), "//", "// bbb", ""].join(
    "\n",
  )
  const r = fix(src)
  const lines = r.text.split("\n")
  assert.ok(lines.includes("//"), "bare separator kept")
  assert.equal(lines.at(-2), "// bbb")
})

test("numbered list keeps hang indent on continuation lines", () => {
  const src = [
    "// 1. first item " + "word ".repeat(20).trim(),
    "//    continuation already hung",
    "// 2. second item",
    "",
  ].join("\n")
  const r = fix(src)
  const lines = r.text.split("\n")
  assert.ok(lines[0].startsWith("// 1. "))
  for (const l of lines.slice(1, -2)) assert.ok(l.startsWith("//    "), l)
  assert.equal(lines.at(-2), "// 2. second item")
  assert.ok(lines.every((l) => l.length <= 80))
})

test("backtick code span is never split", () => {
  const span = "`Component.make(<T,>(props: { item: T }) => Effect.gen(x))`"
  const src = "// mentioning the extremely long inline " + span + " here\n"
  const r = fix(src)
  assert.ok(r.text.includes(span), "span intact on one line")
})

test("fenced code inside a docblock is verbatim", () => {
  const fenceLine =
    " * <Catch HttpError={(e, reset) => <Banner status={e.status} onRetry={reset} />}>"
  const src = ["/**", " * ```tsx", fenceLine, " * ```", " */", ""].join("\n")
  const r = fix(src)
  assert.ok(r.text.includes(fenceLine))
  assert.equal(r.paragraphs, 0)
})

test("`───` section header is exempt from reflow, not merged", () => {
  const header = "// ─── Error boundary (Catch) " + "─".repeat(60)
  const src = [header, "// prose after the header", ""].join("\n")
  const r = fix(src)
  const lines = r.text.split("\n")
  assert.equal(lines[0], header)
  assert.equal(lines[1], "// prose after the header")
})

test("table rows and URLs are exempt from reflow", () => {
  const table = "// | a very long table row ".padEnd(90, "x") + " | b | c |"
  const url = "// see https://example.com/" + "seg/".repeat(20)
  const src = [table, "//", url, ""].join("\n")
  const r = fix(src)
  assert.ok(r.text.includes(table))
  assert.ok(r.text.includes(url))
})

test("indented code sample in a comment is not reflowed", () => {
  const code = "//   const someVeryLongIdentifier = " + "a + ".repeat(20) + "a"
  const src = code + "\n"
  assert.equal(fix(src).text, src)
})

test("check mode counts but does not rewrite", () => {
  const src = "// " + "word ".repeat(30).trim() + "\n"
  const r = check(src)
  assert.equal(r.paragraphs, 1)
  assert.equal(r.text, src)
  assert.equal(r.changed, false)
})

test("overlongCommentLines reports unfixable lines, skips URLs", () => {
  const src = [
    "// @ts-expect-error " + "x".repeat(80),
    "// https://example.com/" + "y".repeat(80),
    "const ok = 1",
    "",
  ].join("\n")
  const rep = overlongCommentLines(src)
  assert.deepEqual(
    rep.map((r) => r.line),
    [1],
  )
})
