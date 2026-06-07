// Shared Playwright harness for probe-*.mjs specs.
import { chromium } from "playwright-core"

export async function runProbe({
  url = "http://localhost:5173/",
  viewport = { width: 900, height: 1100 },
  onConsole,
  onPageError = (e) => console.error("[pageerror]", e.message),
  run,
}) {
  const browser = await chromium.launch({
    executablePath: process.env.VERREX_CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  })
  try {
    const ctx = await browser.newContext({ viewport })
    const page = await ctx.newPage()
    page.on("pageerror", onPageError)
    if (onConsole) page.on("console", onConsole)
    await page.goto(url, { waitUntil: "networkidle" })
    return await run(page, ctx)
  } finally {
    await browser.close()
  }
}
