// HMR probe: open the demo, edit Counter.efx in place, confirm the change
// appears in the browser without manual reload.
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const COUNTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/demo/src/Counter.efx",
)

const browser = await chromium.launch({
  executablePath: process.env.EFX_CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
})
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } })
const page = await ctx.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" })
await page.waitForSelector(".counter")

const initialText = await page.locator(".counter .count").innerText()
console.log("initial text:", JSON.stringify(initialText))

// Mutate the .efx file: change "clicks" to "CLICKED"
const original = readFileSync(COUNTER_PATH, "utf8")
const mutated = original.replace("clicks:", "CLICKED:")
writeFileSync(COUNTER_PATH, mutated, "utf8")

// Wait for Vite HMR to propagate
await page.waitForFunction(
  () => document.querySelector(".counter .count")?.textContent?.includes("CLICKED"),
  { timeout: 5000 },
).catch(() => null)

const afterEdit = await page.locator(".counter .count").innerText()
console.log("after edit text:", JSON.stringify(afterEdit))

// Restore the file
writeFileSync(COUNTER_PATH, original, "utf8")

await browser.close()

const ok = afterEdit.includes("CLICKED")
console.log(ok ? "HMR PASS" : "HMR FAIL")
process.exit(ok ? 0 : 1)
