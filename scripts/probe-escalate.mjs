// Probe for step 08 — `Async` open form (no failure arm) escalating to the
// page-level `Catch`. Verifies: content renders on load; a failing auto-tracked
// REFETCH (Bad id) swaps in the boundary banner naming HttpError; the id
// buttons outside the boundary survive the swap; retry after picking a good id
// re-runs construction and recovers.
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

    // 1. Happy path renders through the boundary untouched.
    await waitForText(/Ada Lovelace/)
    console.log("PASS: content rendered (Ada Lovelace)")

    // 2. Bad id → the refetch fails post-mount; the failure rides the live
    //    channel to the page boundary, which swaps in the banner.
    await demo.locator("button", { hasText: "Bad id" }).click()
    await waitForText(/page boundary caught/i)
    await waitForText(/HttpError/)
    console.log("PASS: refetch failure escalated to the boundary banner")

    // 3. The controls outside the boundary survived the swap; pick a good id
    //    and retry → reset re-runs construction → fresh fetch succeeds.
    await demo.locator("button", { hasText: "Grace (7)" }).click()
    await demo.locator("button.retry", { hasText: "retry" }).click()
    await waitForText(/Grace Hopper/)
    console.log("PASS: retry after fixing the id recovered (Grace Hopper)")

    if (errors.length > 0) {
      console.error("FAIL: console errors:", errors)
      process.exitCode = 1
    } else {
      console.log("PASS: no console errors")
    }
  },
})
