// Verifies the production bundle works end-to-end (port 8765).
import { chromium } from "playwright-core"

const URL = process.env.EFX_URL ?? "http://localhost:8765/"

const browser = await chromium.launch({
  executablePath: process.env.EFX_CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
})
const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } })
const page = await ctx.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForSelector(".todos ul")

// Counter
const plus = page.locator(".counter button").first()
await plus.click(); await plus.click(); await plus.click()
const counterText = await page.locator(".counter .count").innerText()
console.log("counter after 3 clicks:", counterText.trim())

// LiveUser
await page.locator(".live-user button", { hasText: "Grace (7)" }).click()
await page.waitForTimeout(300)
const liveUser = await page.locator(".live-user .user-card strong").innerText()
console.log("liveuser after Grace:", liveUser)

// Todos
const todoCount = await page.locator(".todos ul li").count()
await page.locator(".todos ul li").nth(1).locator(".toggle").click()
await page.waitForTimeout(50)
const toggledClass = await page.locator(".todos ul li").nth(1).getAttribute("class")
console.log("todos initial count:", todoCount)
console.log("todos #2 class after toggle:", toggledClass)

await browser.close()
console.log("DONE")
