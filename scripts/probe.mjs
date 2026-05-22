// Drive the demo with Playwright to verify reactivity + capture screenshots.
import { chromium } from "playwright-core"
import { writeFileSync } from "node:fs"

const browser = await chromium.launch({
  executablePath: "/etc/profiles/per-user/mathieu/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
})

const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } })
const page = await ctx.newPage()

const consoleLog = []
page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`))
page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`))

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" })
// Wait for the async fetch + Counter to render
await page.waitForSelector(".user-page h1")
await page.waitForSelector(".counter")

await page.screenshot({ path: "/tmp/efx-verify/00-initial.png" })

const countBefore = await page.locator(".counter .count").innerText()
console.log("count before:", JSON.stringify(countBefore))

// Click the [+] button three times
const plusBtn = page.locator(".counter button").first()
await plusBtn.click()
await plusBtn.click()
await plusBtn.click()

await page.screenshot({ path: "/tmp/efx-verify/01-after-3-clicks.png" })
const countAfter3 = await page.locator(".counter .count").innerText()
console.log("count after 3 clicks:", JSON.stringify(countAfter3))

// Click reset
await page.locator(".counter button").nth(1).click()
await page.waitForTimeout(50)
const countAfterReset = await page.locator(".counter .count").innerText()
console.log("count after reset:", JSON.stringify(countAfterReset))
await page.screenshot({ path: "/tmp/efx-verify/02-after-reset.png" })

// Dump UserPage content
const userName = await page.locator(".user-page h1").innerText()
const postCount = await page.locator(".user-page .posts li").count()
console.log("user name:", JSON.stringify(userName))
console.log("post count:", postCount)

writeFileSync("/tmp/efx-verify/console.log", consoleLog.join("\n"))

await browser.close()
console.log("DONE")
