#!/usr/bin/env node
/**
 * Smoke test for @efx/check.
 *
 *   1. runCheck against a known-good fixture → 0 errors.
 *   2. Add a deliberately-broken .vx → runCheck reports the type error,
 *      with source position pointing at the .vx file.
 *   3. Remove the broken file → back to 0 errors.
 *
 * No tsserver subprocess; the check tool is invoked in-process.
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runCheck } from "../src/index.ts"

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

const ensureClean = () => {
  if (existsSync(brokenPath)) unlinkSync(brokenPath)
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
  if (failures > 0 || process.env.EFX_CHECK_TEST_DEBUG) {
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

ensureClean()

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
} else {
  console.log("\nAll assertions passed")
  process.exit(0)
}
