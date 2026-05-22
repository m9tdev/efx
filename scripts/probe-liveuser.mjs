import { chromium } from "playwright-core"

const browser = await chromium.launch({
  executablePath: "/etc/profiles/per-user/mathieu/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
})

const ctx = await browser.newContext({ viewport: { width: 900, height: 1300 } })
const page = await ctx.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" })
await page.waitForSelector(".live-user")

// Initial state — should show Ada
let live = await page.locator(".live-user .user-card strong").innerText()
console.log("initial:", live)

await page.screenshot({ path: "/tmp/effx-verify/04-live-initial.png" })

// Click Grace (7)
await page.locator(".live-user button", { hasText: "Grace (7)" }).click()
await page.waitForTimeout(400)
live = await page.locator(".live-user .user-card strong").innerText()
console.log("after Grace click:", live)
await page.screenshot({ path: "/tmp/effx-verify/05-live-grace.png" })

// Click Bad id — should produce a failure state, no .user-card
await page.locator(".live-user button", { hasText: "Bad id" }).click()
await page.waitForTimeout(400)
const errEl = await page.locator(".live-user .error").count()
console.log("error state visible:", errEl > 0)
const errText = errEl > 0 ? await page.locator(".live-user .error").first().innerText() : "(no error element)"
console.log("error text:", errText.slice(0, 80))
await page.screenshot({ path: "/tmp/effx-verify/06-live-error.png" })

// Click Ada (42) again — should recover to success
await page.locator(".live-user button", { hasText: "Ada (42)" }).click()
await page.waitForTimeout(400)
live = await page.locator(".live-user .user-card strong").innerText().catch(() => "(none)")
console.log("after Ada recovery:", live)
await page.screenshot({ path: "/tmp/effx-verify/07-live-recover.png" })

await browser.close()
console.log("DONE")
