// Save-button probe — the pending → run → settle mutation
// pattern in a real browser event loop, three phases:
// 1. Click save: the handler's first action swaps its own button for a spinner,
//      then awaits the 600ms Http call. The swap must not interrupt the handler
//      at that await: spinner shows, then the button returns and `saved` is 1.
//   2. Click save (fails): the same shape ending in a typed HttpError, which
//      must reach the Catch AFTER the self-triggered re-render.
//   3. Reset while saving: ↻ reset tears down the OWNING subtree mid-flight —
//      the handler must be interrupted (no late `saved` increment lands in
//      the fresh instance).
import { runProbe, waitForText } from "./probe-harness.mjs"

const SEL = '[data-demo="savebutton"]'
const result = await runProbe({
  url: process.env.VERREX_URL ?? "http://localhost:5173/",
  viewport: { width: 900, height: 1400 },
  run: async (page) => {
    await page.waitForSelector(`${SEL} .save`)
    const text = (s) =>
      page.evaluate((q) => document.querySelector(q)?.innerText ?? "", s)

    // Phase 1: survives its own re-render.
    await page.locator(`${SEL} .save`).click()
    await page.waitForSelector(`${SEL} .saving`, { timeout: 500 })
    await waitForText(page, `${SEL} .saved`, /^1$/, 3000)
    await page.waitForSelector(`${SEL} .save`, { timeout: 1000 })

    // Phase 2: typed failure reaches Catch after the re-render.
    await page.locator(`${SEL} .save-fail`).click()
    await page.waitForSelector(`${SEL} .caught`, { timeout: 3000 })
    const caught = await text(`${SEL} .caught`)
    await page.locator(`${SEL} .reset`).click()
    await page.waitForSelector(`${SEL} .save`, { timeout: 1000 })

    // Phase 3: owner teardown interrupts an in-flight handler.
    await page.locator(`${SEL} .save`).click()
    await page.waitForSelector(`${SEL} .saving`, { timeout: 500 })
    await page.locator(`.tour-demo:has(${SEL}) .demo-refresh`).click()
    await page.waitForSelector(`${SEL} .save`, { timeout: 1000 })
    // A NEGATIVE assertion (nothing may change), so a fixed wait is the only
    // shape: comfortably past the 600ms Http latency + a render.
    await page.waitForTimeout(1200)
    const savedAfterReset = await text(`${SEL} .saved`)

    return { caught, savedAfterReset }
  },
})

console.log(result)
const failures = []
if (!/HttpError 404/i.test(result.caught))
  failures.push(
    `phase 2: Catch did not receive HttpError after re-render: '${result.caught}'`,
  )
if (result.savedAfterReset !== "0")
  failures.push(
    `phase 3: stale write landed after reset — saved='${result.savedAfterReset}'`,
  )

if (failures.length) {
  console.error("FAIL\n  " + failures.join("\n  "))
  process.exit(1)
}
console.log(
  "PASS — handler survives its own re-render, fails into Catch, dies with its owner",
)
