// Drive the demo with Playwright to verify reactivity + capture screenshots.
import { writeFileSync } from "node:fs"
import { runProbe } from "./probe-harness.mjs"

const consoleLog = []

await runProbe({
  viewport: { width: 900, height: 1100 },
  onConsole: (m) => consoleLog.push(`[${m.type()}] ${m.text()}`),
  onPageError: (e) => consoleLog.push(`[pageerror] ${e.message}`),
  run: async (page) => {
    // Wait for the async fetch + Counter to render
    await page.waitForSelector(".user-page h1")
    await page.waitForSelector(".counter")

    await page.screenshot({ path: "/tmp/verrex-verify/00-initial.png" })

    const countBefore = await page.locator(".counter .count").innerText()
    console.log("count before:", JSON.stringify(countBefore))

    // Click the [+] button three times
    const plusBtn = page.locator(".counter button").first()
    await plusBtn.click()
    await plusBtn.click()
    await plusBtn.click()

    await page.screenshot({ path: "/tmp/verrex-verify/01-after-3-clicks.png" })
    const countAfter3 = await page.locator(".counter .count").innerText()
    console.log("count after 3 clicks:", JSON.stringify(countAfter3))

    // Reset via the demo's reset button (recreates the component → count 0)
    await page
      .locator('[data-demo="counter"]')
      .locator("..")
      .locator(".demo-refresh")
      .click()
    await page.waitForTimeout(50)
    const countAfterReset = await page.locator(".counter .count").innerText()
    console.log("count after reset:", JSON.stringify(countAfterReset))
    await page.screenshot({ path: "/tmp/verrex-verify/02-after-reset.png" })

    // Dump UserPage content
    const userName = await page.locator(".user-page h1").innerText()
    const postCount = await page.locator(".user-page .posts li").count()
    console.log("user name:", JSON.stringify(userName))
    console.log("post count:", postCount)
  },
})

writeFileSync("/tmp/verrex-verify/console.log", consoleLog.join("\n"))
console.log("DONE")
