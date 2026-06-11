#!/usr/bin/env node
/**
 * Smoke test for verrex/check.
 *
 *   1. runCheck against a known-good fixture → 0 errors.
 *   2. Add a deliberately-broken .vx → runCheck reports the type error,
 *      with source position pointing at the .vx file.
 *   3. Remove the broken file → back to 0 errors.
 *   4. createChecker: ONE checker instance tracks create/update/delete via
 *      file events — the incremental loop `verrex-check --watch` runs on.
 *      Includes: tsconfig edits re-parse the project; a failed stale-flush
 *      (tsconfig briefly missing) rejects with a friendly error AND keeps
 *      the staleness; the watch-facing topology API (config files, wildcard
 *      dirs, tracked files).
 *   5. minimumSeverity: hint-severity diagnostics (TS suggestions) are
 *      counted but not printed by default; "hint" prints them.
 *   6. shouldFail: the failing-severity thresholds cascade.
 *   7. A supplied-but-missing tsconfig rejects with a friendly error.
 *
 * No tsserver subprocess; the check tool is invoked in-process.
 */
import { writeFileSync, readFileSync, unlinkSync, existsSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createChecker, runCheck, shouldFail } from "../../src/check/index.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(__dirname, "fixture")
const brokenPath = join(fixtureDir, "Broken.vx")

let failures = 0
const expect = (condition, message) => {
  if (condition) {
    console.log(`  PASS: ${message}`)
  } else {
    console.error(`  FAIL: ${message}`)
    failures += 1
  }
}

// Capture stdout while runCheck runs — the test should be quiet on success,
// noisy only when assertions fail.
const captureStdout = async (fn) => {
  const chunks = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString())
    return true
  }
  try {
    const result = await fn()
    return { result, output: chunks.join("") }
  } finally {
    process.stdout.write = originalWrite
  }
}

const unusedPath = join(fixtureDir, "Unused.vx")
const fixtureTsconfigPath = join(fixtureDir, "tsconfig.json")
const hiddenTsconfigPath = fixtureTsconfigPath + ".hidden"

const ensureClean = () => {
  if (existsSync(hiddenTsconfigPath)) renameSync(hiddenTsconfigPath, fixtureTsconfigPath)
  if (existsSync(brokenPath)) unlinkSync(brokenPath)
  if (existsSync(unusedPath)) unlinkSync(unusedPath)
}

ensureClean()

console.log("1. Known-good fixture should have 0 errors...")
{
  const { result, output } = await captureStdout(() => runCheck({ cwd: fixtureDir }))
  expect(result.errors === 0, `expected 0 errors, got ${result.errors}`)
  expect(result.filesChecked >= 1, `expected at least 1 file, got ${result.filesChecked}`)
  if (result.errors !== 0) console.error("output was:\n" + output)
}

console.log("\n2. Inject Broken.vx with a type error → expect >=1 error pointing at Broken.vx...")
writeFileSync(
  brokenPath,
  `const x: number = "wrong type"\nexport { x }\n`,
)
{
  const { result, output } = await captureStdout(() => runCheck({ cwd: fixtureDir }))
  expect(result.errors >= 1, `expected >=1 errors, got ${result.errors}`)
  expect(output.includes("Broken.vx"), "diagnostic output should mention Broken.vx")
  expect(output.includes("2322"), "diagnostic output should include TS2322 (not assignable)")
  if (failures > 0 || process.env.VERREX_CHECK_TEST_DEBUG) {
    console.log("[captured output]\n" + output)
  }
}

console.log("\n3. Remove Broken.vx → expect 0 errors again...")
unlinkSync(brokenPath)
{
  const { result, output } = await captureStdout(() => runCheck({ cwd: fixtureDir }))
  expect(result.errors === 0, `expected 0 errors after cleanup, got ${result.errors}`)
  if (result.errors !== 0) console.error("output was:\n" + output)
}

console.log("\n4. createChecker: one instance tracks file events incrementally...")
{
  const checker = createChecker({ cwd: fixtureDir })
  const goodPath = join(fixtureDir, "Good.vx")
  const goodSource = readFileSync(goodPath, "utf8")

  const clean = await captureStdout(() => checker.check())
  expect(clean.result.errors === 0, `fresh checker: expected 0 errors, got ${clean.result.errors}`)
  const baselineFiles = clean.result.filesChecked

  // The hot path: an in-place edit of an EXISTING root file, signalled via
  // fileUpdated — kit bumps its project version and re-reads the snapshot.
  try {
    writeFileSync(goodPath, goodSource + `export const oops: number = "nope"\n`)
    checker.fileUpdated(goodPath)
    const edited = await captureStdout(() => checker.check())
    expect(edited.result.errors >= 1, `after fileUpdated break: expected >=1 errors, got ${edited.result.errors}`)
    expect(edited.output.includes("Good.vx"), "after fileUpdated break: output should mention Good.vx")
  } finally {
    writeFileSync(goodPath, goodSource)
    checker.fileUpdated(goodPath)
  }
  const restored = await captureStdout(() => checker.check())
  expect(restored.result.errors === 0, `after fileUpdated restore: expected 0 errors, got ${restored.result.errors}`)
  if (restored.result.errors !== 0) console.error("output was:\n" + restored.output)

  // Create/delete re-expand the tsconfig include globs (lazily, at the next
  // check/getRootFileNames — a burst of events costs one rebuild).
  writeFileSync(brokenPath, `const x: number = "wrong type"\nexport { x }\n`)
  checker.fileCreated(brokenPath)
  expect(
    checker.getRootFileNames().some((f) => f.endsWith("Broken.vx")),
    "after fileCreated: getRootFileNames flushes the stale project",
  )
  const broken = await captureStdout(() => checker.check())
  expect(broken.result.errors >= 1, `after fileCreated: expected >=1 errors, got ${broken.result.errors}`)
  expect(broken.output.includes("Broken.vx"), "after fileCreated: output should mention Broken.vx")
  expect(
    broken.result.filesChecked === baselineFiles + 1,
    `after fileCreated: expected ${baselineFiles + 1} files, got ${broken.result.filesChecked}`,
  )

  // An edit to the tsconfig itself marks the project stale: excluding
  // Broken.vx must drop its error without a new checker.
  const tsconfigPath = join(fixtureDir, "tsconfig.json")
  expect(checker.tsconfigPath === tsconfigPath, "checker.tsconfigPath points at the fixture tsconfig")
  const tsconfigSource = readFileSync(tsconfigPath, "utf8")
  try {
    const config = JSON.parse(tsconfigSource)
    writeFileSync(tsconfigPath, JSON.stringify({ ...config, exclude: ["Broken.vx"] }, null, 2))
    checker.fileUpdated(tsconfigPath)
    const excluded = await captureStdout(() => checker.check())
    expect(
      excluded.result.errors === 0,
      `after tsconfig exclude: expected 0 errors, got ${excluded.result.errors}`,
    )
    expect(
      excluded.result.filesChecked === baselineFiles,
      `after tsconfig exclude: expected ${baselineFiles} files, got ${excluded.result.filesChecked}`,
    )
  } finally {
    writeFileSync(tsconfigPath, tsconfigSource)
    checker.fileUpdated(tsconfigPath)
  }

  // A failed stale-flush must KEEP the staleness: hide the tsconfig so the
  // flush rejects (friendly error, not a TS-internals TypeError), restore it,
  // and verify the next check() still sees the pending project change.
  let rejection = null
  try {
    renameSync(fixtureTsconfigPath, hiddenTsconfigPath)
    try {
      await checker.check()
    } catch (error) {
      rejection = error
    }
  } finally {
    renameSync(hiddenTsconfigPath, fixtureTsconfigPath)
  }
  expect(
    rejection instanceof Error && /tsconfig not found at/.test(rejection.message),
    `missing tsconfig mid-watch: friendly rejection, got: ${rejection && rejection.message}`,
  )
  const afterRestore = await captureStdout(() => checker.check())
  expect(
    afterRestore.result.errors >= 1,
    `staleness survives a failed flush: expected Broken.vx's error, got ${afterRestore.result.errors}`,
  )

  unlinkSync(brokenPath)
  checker.fileDeleted(brokenPath)
  const removed = await captureStdout(() => checker.check())
  expect(removed.result.errors === 0, `after fileDeleted: expected 0 errors, got ${removed.result.errors}`)
  expect(
    removed.result.filesChecked === baselineFiles,
    `after fileDeleted: expected ${baselineFiles} files, got ${removed.result.filesChecked}`,
  )

  const cancelled = await captureStdout(() => checker.check({ cancel: () => true }))
  expect(cancelled.result.filesChecked === 0, "cancel before the first file: 0 files checked")

  // Watch-facing project topology.
  expect(checker.getConfigFilePaths().includes(fixtureTsconfigPath), "getConfigFilePaths includes the tsconfig")
  expect(
    checker.getWildcardDirectories().includes(fixtureDir),
    "getWildcardDirectories includes the include-glob root",
  )
  expect(
    checker.getTrackedFileNames().some((f) => f.endsWith("Good.vx")),
    "getTrackedFileNames observed Good.vx",
  )
}

console.log("\n5. minimumSeverity: hints counted but not printed by default...")
writeFileSync(unusedPath, `const unused = 1\nexport const ok = 2\n`)
{
  const dflt = await captureStdout(() => runCheck({ cwd: fixtureDir }))
  expect(dflt.result.errors === 0, `expected 0 errors, got ${dflt.result.errors}`)
  expect(dflt.result.hints >= 1, `expected >=1 hint (unused local suggestion), got ${dflt.result.hints}`)
  expect(!dflt.output.includes("Unused.vx"), "default severity: hint should not print")

  const hints = await captureStdout(() => runCheck({ cwd: fixtureDir, minimumSeverity: "hint" }))
  expect(hints.output.includes("Unused.vx"), 'minimumSeverity "hint": hint should print')
  expect(hints.output.includes("6133"), "printed hint should be TS6133 (declared but never read)")
}
unlinkSync(unusedPath)

console.log("\n6. shouldFail: failing-severity thresholds cascade...")
{
  const only = (kind, n) => ({ filesChecked: 1, errors: 0, warnings: 0, hints: 0, [kind]: n })
  expect(shouldFail(only("errors", 1)) === true, "default: errors fail")
  expect(shouldFail(only("warnings", 1)) === false, "default: warnings do not fail")
  expect(shouldFail(only("warnings", 1), "warning") === true, '"warning": warnings fail')
  expect(shouldFail(only("hints", 1), "warning") === false, '"warning": hints do not fail')
  expect(shouldFail(only("hints", 1), "hint") === true, '"hint": hints fail')
  expect(shouldFail(only("errors", 1), "hint") === true, '"hint": errors still fail')
  expect(shouldFail(only("errors", 0), "hint") === false, '"hint": clean result passes')
  // Untyped JS callers passing a typo'd threshold must still fail on errors.
  expect(shouldFail(only("errors", 1), "bogus") === true, "unknown threshold: errors still fail")
  expect(shouldFail(only("warnings", 1), "bogus") === false, "unknown threshold: falls back to error level")
}

console.log("\n7. Supplied tsconfig that doesn't exist → friendly rejection...")
{
  let rejection = null
  try {
    await runCheck({ cwd: fixtureDir, tsconfig: "missing/tsconfig.json" })
  } catch (error) {
    rejection = error
  }
  expect(
    rejection instanceof Error && /tsconfig not found at/.test(rejection.message),
    `expected friendly 'tsconfig not found at' rejection, got: ${rejection && rejection.message}`,
  )
}

ensureClean()

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
} else {
  console.log("\nAll assertions passed")
  process.exit(0)
}
