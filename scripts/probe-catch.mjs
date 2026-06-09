// Probe for step 07 — the `Catch` boundary demo (both forms).
// Verifies the tag-map caught a typed HttpError on load, and the catch-all
// catches a live event-handler failure on click + recovers on reset.
import { runProbe } from "./probe-harness.mjs"

const errors = []

await runProbe({
  onConsole: (msg) => {
    // Ignore network-resource noise (e.g. the missing /favicon.ico 404) — we only
    // care about real JS console errors and page errors.
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) {
      errors.push(msg.text())
    }
  },
  run: async (page) => {
    const demo = page.locator('[data-demo="boundary"]')
    await demo.waitFor({ state: "attached" })
    // Let construction + the outer demo wrapper settle.
    await page.waitForTimeout(300)

    const text0 = (await demo.innerText()).replace(/\s+/g, " ").trim()
    console.log("\n[on load]\n" + text0)

    // 1) tag-map form caught a typed HttpError at construction, unwrapped (status).
    const tagMapCaught = /HttpError 404/.test(text0)
    // 2) catch-all child rendered its working button.
    const crashBtn = demo.locator(".crash")
    const crashVisible = (await crashBtn.count()) > 0

    // 3) Click "crash me" → the catch-all's handler Effect fails → fallback swaps in.
    await crashBtn.click()
    await page.waitForTimeout(300)
    const textAfterCrash = (await demo.innerText()).replace(/\s+/g, " ").trim()
    console.log("\n[after crash]\n" + textAfterCrash)
    const catchAllCaught = /catch-all caught/.test(textAfterCrash) && /BoomError/.test(textAfterCrash)
    const crashGone = (await demo.locator(".crash").count()) === 0

    // 4) Reset → the catch-all re-runs construction; the working button returns.
    await demo.locator(".reset").first().click()
    await page.waitForTimeout(300)
    const recovered = (await demo.locator(".crash").count()) > 0
    console.log("\n[after reset] crash button back:", recovered)

    await page.screenshot({ path: "scripts/.catch-probe.png", fullPage: false })

    const results = { tagMapCaught, crashVisible, catchAllCaught, crashGone, recovered }
    console.log("\n[results]", JSON.stringify(results, null, 2))
    const ok = Object.values(results).every(Boolean) && errors.length === 0
    if (!ok) {
      console.error("\nFAIL", { results, consoleErrors: errors })
      process.exitCode = 1
    } else {
      console.log("\nPASS — both Catch forms work in the browser")
    }
  },
})
