// Red test for per-component lifecycle scopes:
//   - Component uses Effect.acquireRelease to log mount/unmount events.
//   - Initial render produces N "mount:i" entries.
//   - Adding a row produces one more "mount".
//   - Removing a row should produce a matching "unmount" — this is what's
//     currently missing.
import { chromium } from "playwright-core"

const URL = process.env.EFX_URL ?? "http://localhost:5173/"

const browser = await chromium.launch({
  executablePath: process.env.EFX_CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
})
const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } })
const page = await ctx.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForSelector(".lifecycle")

const read = () => page.evaluate(() => window.__lifecycle ?? [])

const initial = await read()
console.log("initial:", initial)

await page.locator(".lifecycle button", { hasText: "add row" }).click()
await page.waitForTimeout(50)
const afterAdd = await read()
console.log("after add:", afterAdd)

await page.locator(".lifecycle button", { hasText: "remove last" }).click()
await page.waitForTimeout(50)
const afterRemove = await read()
console.log("after remove:", afterRemove)

await browser.close()

// Assertions
const mountCount = afterRemove.filter((e) => e.startsWith("mount:")).length
const unmountCount = afterRemove.filter((e) => e.startsWith("unmount:")).length

const failures = []
if (initial.length < 2) failures.push(`expected ≥2 initial mounts, got ${initial.length}`)
if (afterAdd.length !== initial.length + 1)
  failures.push(`expected one new mount after add, events grew by ${afterAdd.length - initial.length}`)
if (unmountCount < 1)
  failures.push(`expected ≥1 unmount after remove, got 0`)
if (mountCount - unmountCount !== afterRemove.filter((e) => e.startsWith("mount:")).length - 1)
  failures.push(`expected exactly 1 row's worth of unmount to fire`)

if (failures.length > 0) {
  console.error("FAIL:")
  for (const f of failures) console.error("  -", f)
  process.exit(1)
}
console.log("PASS")
