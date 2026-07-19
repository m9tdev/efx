// Shared Playwright harness for probe-*.mjs specs.
import { chromium } from "playwright-core"

/**
 * Poll until `sel`'s innerText matches `re` (or `timeout` ms elapse). Poll for
 * content rather than fixed sleeps — a cold dev server compiles .vx on first
 * request, so timings vary. Match against `innerText` (it reflects CSS
 * `text-transform`, so pass a case-insensitive regex for upper-cased labels).
 */
export const waitForText = (page, sel, re, timeout = 5000) =>
  page.waitForFunction(
    ({ s, src, fl }) =>
      new RegExp(src, fl).test(document.querySelector(s)?.innerText ?? ""),
    { s: sel, src: re.source, fl: re.flags },
    { timeout },
  )

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
