// Probe for step 08 — `Async` failure homes: the tag-map arm splits per tag,
// the open-form block beside it escalates everything, and the fake endpoint
// REALLY rate-limits (2 requests/second across both blocks, counted at
// request-creation time). Verifies: both blocks render on load; a leaf-handled
// HttpError (Bad id) renders the leaf fallback WITHOUT touching the page
// tag-map boundary while the SAME failure escalates the open-form block to its
// catch-all banner; the tag-map fetch loop stays live (good id recovers with
// no reset) while the open form needs its catch-all's reset; leaf retry shows
// the loading arm (waiting → initial) then re-fails; the spam button trips the
// real limiter and RateLimited rides the residual to the page tag map
// (unwrapped, typed retryAfterMs); after the window passes the boundary retry
// recovers. Every id click costs one request PER BLOCK, so steps that must not
// be limited settle for >1s (the window) first.
import { runProbe, waitForText as waitForTextIn } from "./probe-harness.mjs"

const errors = []

await runProbe({
  onConsole: (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) {
      errors.push(msg.text())
    }
  },
  run: async (page) => {
    const sel = '[data-demo="escalate"]'
    const demo = page.locator(sel)
    await demo.waitFor({ state: "attached" })
    const waitForText = (re) => waitForTextIn(page, sel, re)
    const settle = () => page.waitForTimeout(1100) // let the 1s rate window clear

    // 1. Happy path renders through both blocks untouched.
    await waitForText(/Ada Lovelace/)
    await demo.locator(".open-ok", { hasText: "Ada Lovelace" }).waitFor()
    console.log("PASS: both blocks rendered (Ada Lovelace)")

    // 2. Bad id → tag-map block: HttpError matched at the leaf, page tag-map
    //    boundary untouched. Open-form block: the SAME HttpError escalates to
    //    its catch-all banner, Cause.pretty naming the tag.
    await settle()
    await demo.locator("button", { hasText: "Bad id" }).click()
    await waitForText(/handled at the leaf — HttpError 404/)
    if (await demo.locator(".page-fallback").count()) {
      throw new Error("page tag-map boundary rendered for a leaf-handled tag")
    }
    await demo.locator(".open-fallback").waitFor()
    await waitForText(/HttpError/)
    console.log("PASS: leaf handled in place; open form escalated to catch-all")

    // 3. Tag-map fetch loop stayed live: another id recovers with NO reset.
    //    The open-form boundary swapped its Async away — it stays on the
    //    banner until ITS reset re-runs construction with the fixed id.
    await settle()
    await demo.locator("button", { hasText: "Grace (7)" }).click()
    await waitForText(/Grace Hopper/)
    await settle()
    await demo.locator(".open-fallback button.retry").click()
    await demo.locator(".open-ok", { hasText: "Grace Hopper" }).waitFor()
    console.log("PASS: leaf recovered on dep change; open form recovered via reset")

    // 4. Leaf retry re-runs the same fetch: the loading arm shows while the
    //    re-run is in flight (failure-waiting renders `initial`), then the
    //    still-failing fetch brings the fallback back.
    await settle()
    await demo.locator("button", { hasText: "Bad id" }).click()
    await demo.locator(".content .leaf-fallback").waitFor()
    await settle() // a limited retry would escalate as RateLimited instead
    await demo.locator(".content button.leaf-retry").click()
    await demo.locator(".content .loading").waitFor()
    await demo.locator(".content .leaf-fallback").waitFor()
    console.log("PASS: leaf retry re-ran the fetch (loading shown, still retryable)")

    // 5. Spam → three refetch rounds back-to-back exceed 2 req/s (the open
    //    block is escalated → dead, so only the tag-map block is stamping):
    //    a REAL RateLimited. Not in the leaf map → rides the residual to the
    //    page boundary's tag map, which renders the unwrapped, typed payload.
    //    (.caught is CSS-uppercased → /i.)
    await settle()
    await demo.locator("button.spam").click()
    await waitForText(/429 rate-limited/) // the request log narrates the limiter
    await waitForText(/page boundary caught: RateLimited/i)
    await waitForText(/retry in \d+ms/)
    await demo.locator(".open-fallback").waitFor()
    console.log("PASS: real rate limit tripped (logged); residual escalated to the page tag map")

    // 6. Controls outside the boundaries survived; the window passes, page
    //    boundary reset re-runs construction → recovers (three flips from
    //    "999" end on "7" → Grace).
    await settle()
    await demo.locator(".page-fallback button.retry").click()
    await waitForText(/Grace Hopper/)
    console.log("PASS: page boundary retry recovered after the window passed")

    if (errors.length > 0) {
      console.error("FAIL: console errors:", errors)
      process.exitCode = 1
    } else {
      console.log("PASS: no console errors")
    }
  },
})
