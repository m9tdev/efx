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
    const sel = '[data-demo="boundary"]'
    const demo = page.locator(sel)
    await demo.waitFor({ state: "attached" })
    // Poll for content rather than fixed sleeps (a cold dev server compiles .vx on
    // first request, so timings vary). Case-insensitive — the fallback label is
    // upper-cased by CSS (text-transform), which `innerText` reflects.
    const waitForText = (re) =>
      page.waitForFunction(
        ({ s, src, fl }) => new RegExp(src, fl).test(document.querySelector(s)?.innerText ?? ""),
        { s: sel, src: re.source, fl: re.flags },
        { timeout: 5000 },
      )
    const demoText = async () => (await demo.innerText()).replace(/\s+/g, " ").trim()
    // The demo's own "↻ reset" button (recreates the whole demo → re-rolls the
    // flaky request). It's a sibling of the mount container, in the same panel.
    const panel = page.locator(".tour-demo", { has: page.locator(sel) })

    // 1) tag-map (object form): the flaky request ~50% fails with a random tagged
    //    error (caught + unwrapped) and ~50% succeeds. Drive it — `retry` from an
    //    error, the panel's reset from a success — until BOTH outcomes are seen,
    //    proving the tag-map catches, retry re-runs, and success recovers.
    await waitForText(/HttpError \d+|succeeded/i).catch(() => {})
    const observe = async () => {
      const t = await demo.innerText()
      const m = t.match(/HttpError\s+(\d+)/i)
      if (m) return { kind: "error", status: m[1] }
      if (/succeeded/i.test(t)) return { kind: "success" }
      return { kind: "unknown" }
    }
    const kinds = new Set()
    const statuses = new Set()
    let retryReRan = false
    for (let i = 0; i < 20 && !(kinds.has("error") && kinds.has("success")); i++) {
      const o = await observe()
      kinds.add(o.kind)
      if (o.status) statuses.add(o.status)
      if (o.kind === "error") {
        const before = await demo.innerText()
        await demo.locator(".retry").first().click()
        await page.waitForTimeout(200)
        if ((await demo.innerText()) !== before) retryReRan = true
      } else if (o.kind === "success") {
        await panel.locator(".demo-refresh").click()
        await page.waitForTimeout(200)
      } else {
        break
      }
    }
    console.log("\n[tag-map] kinds:", [...kinds].join(", "), "| statuses:", [...statuses].join(", "))
    const tagMapCaught = kinds.has("error") // caught + unwrapped a typed error
    const sawSuccess = kinds.has("success") // ~50% path recovers
    const tagMapHandled = !kinds.has("unknown") // never an unhandled crash/blank

    console.log("\n[on load]\n" + (await demoText()))

    // 2) catch-all (function form): child rendered its working button.
    const crashBtn = demo.locator(".crash")
    const crashVisible = (await crashBtn.count()) > 0

    // 3) Click "crash me" → the catch-all's handler Effect fails → fallback swaps in.
    await crashBtn.click()
    await waitForText(/catch-all caught/i).catch(() => {})
    const afterCrash = await demoText()
    console.log("\n[after crash]\n" + afterCrash)
    const catchAllCaught = /catch-all caught/i.test(afterCrash) && /BoomError/i.test(afterCrash)
    const crashGone = (await demo.locator(".crash").count()) === 0

    // 4) Reset → the catch-all re-runs construction; the working button returns.
    await demo.locator(".reset").first().click()
    await demo.locator(".crash").first().waitFor({ state: "attached", timeout: 5000 }).catch(() => {})
    const recovered = (await demo.locator(".crash").count()) > 0
    console.log("\n[after reset] crash button back:", recovered)

    await page.screenshot({ path: "scripts/.catch-probe.png", fullPage: false })

    const results = { tagMapCaught, sawSuccess, tagMapHandled, retryReRan, crashVisible, catchAllCaught, crashGone, recovered }
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
