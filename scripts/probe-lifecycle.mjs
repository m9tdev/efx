// Lifecycle probe — exercises Effect.acquireRelease's release through per-row
// Scope, in three phases:
//   1. Initial render produces N "mount:i" entries.
//   2. Add/remove rows: removing a row fires its matching "unmount:i" via
//      Scope.closeUnsafe on that row's per-row scope.
//   3. Trigger a full teardown (__teardown interrupts the program fiber,
//      closing the program scope). The parent-fork cascade closes every
//      remaining row scope: every outstanding mount must have a matching
//      unmount afterwards.
import { runProbe } from "./probe-harness.mjs"

const { initial, afterAdd, afterRemove, beforeTeardown, afterTeardown } =
  await runProbe({
    url: process.env.VERREX_URL ?? "http://localhost:5173/",
    viewport: { width: 900, height: 1400 },
    run: async (page) => {
      await page.waitForSelector(".lifecycle")

      const read = () => page.evaluate(() => window.__lifecycle ?? [])

      const initial = await read()
      console.log("initial:", initial)

      await page.locator(".lifecycle button", { hasText: "add row" }).click()
      await page.waitForTimeout(50)
      const afterAdd = await read()
      console.log("after add:", afterAdd)

      await page
        .locator(".lifecycle button", { hasText: "remove last" })
        .click()
      await page.waitForTimeout(50)
      const afterRemove = await read()
      console.log("after remove:", afterRemove)

      // Phase 3: leave several rows mounted, trigger full teardown via
      // __teardown. The fork-cascade through every row scope should fire each
      // remaining row's unmount.
      await page.locator(".lifecycle button", { hasText: "add row" }).click()
      await page.locator(".lifecycle button", { hasText: "add row" }).click()
      await page.waitForTimeout(50)
      const beforeTeardown = await read()
      console.log("before teardown:", beforeTeardown)

      await page.evaluate(() => globalThis.__teardown?.())
      await page.waitForTimeout(100)
      const afterTeardown = await read()
      console.log("after teardown:", afterTeardown)

      return { initial, afterAdd, afterRemove, beforeTeardown, afterTeardown }
    },
  })

// Assertions
const failures = []

// Phase 1 + 2 assertions (preserved)
const mountCount = afterRemove.filter((e) => e.startsWith("mount:")).length
const unmountCount = afterRemove.filter((e) => e.startsWith("unmount:")).length
if (initial.length < 2)
  failures.push(`expected ≥2 initial mounts, got ${initial.length}`)
if (afterAdd.length !== initial.length + 1)
  failures.push(
    `expected one new mount after add, events grew by ${afterAdd.length - initial.length}`,
  )
if (unmountCount < 1) failures.push(`expected ≥1 unmount after remove, got 0`)
if (
  mountCount - unmountCount !==
  afterRemove.filter((e) => e.startsWith("mount:")).length - 1
)
  failures.push(`expected exactly 1 row's worth of unmount to fire`)

// Phase 3 assertion: every outstanding mount has a matching unmount after
// the cascade. Counts must be equal across the whole event log.
const finalMounts = afterTeardown.filter((e) => e.startsWith("mount:")).length
const finalUnmounts = afterTeardown.filter((e) =>
  e.startsWith("unmount:"),
).length
if (finalMounts !== finalUnmounts)
  failures.push(
    `after teardown cascade: ${finalMounts} mounts vs ${finalUnmounts} unmounts (every row should be unmounted)`,
  )
const outstandingBefore =
  beforeTeardown.filter((e) => e.startsWith("mount:")).length -
  beforeTeardown.filter((e) => e.startsWith("unmount:")).length
if (outstandingBefore < 2)
  failures.push(
    `expected ≥2 rows still mounted before teardown, got ${outstandingBefore}`,
  )

if (failures.length > 0) {
  console.error("FAIL:")
  for (const f of failures) console.error("  -", f)
  process.exit(1)
}
console.log("PASS")
