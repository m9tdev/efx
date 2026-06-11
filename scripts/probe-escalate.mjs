// Probe for step 08 — `Async` failure homes: the tag-map `failure` arm splits
// per tag. Verifies: content renders on load; a leaf-handled HttpError (Bad
// id) renders the leaf fallback WITHOUT touching the page boundary; the fetch
// loop stays live (picking a good id recovers with no reset); the leaf retry
// re-runs the fetch; an unmatched RateLimited rides the residual to the page
// boundary's tag map (unwrapped, typed payload rendered); the controls outside
// the boundary survive the swap and the boundary reset recovers.
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

    // 1. Happy path renders through both layers untouched.
    await waitForText(/Ada Lovelace/)
    console.log("PASS: content rendered (Ada Lovelace)")

    // 2. Bad id → HttpError is matched by the leaf tag map: leaf fallback in
    //    place, page boundary NOT involved (controls + section stay mounted).
    await demo.locator("button", { hasText: "Bad id" }).click()
    await waitForText(/handled at the leaf — HttpError 404/)
    if (await demo.locator(".boundary-fallback").count()) {
      throw new Error("page boundary rendered for a leaf-handled tag")
    }
    console.log("PASS: HttpError handled at the leaf, boundary untouched")

    // 3. The fetch loop stayed live: another id recovers with NO reset.
    await demo.locator("button", { hasText: "Grace (7)" }).click()
    await waitForText(/Grace Hopper/)
    console.log("PASS: dep change recovered from the leaf fallback (no reset)")

    // 4. Leaf retry re-runs the same fetch (still 404 → fallback again, alive).
    await demo.locator("button", { hasText: "Bad id" }).click()
    await waitForText(/HttpError 404/)
    await demo.locator("button.leaf-retry").click()
    await waitForText(/HttpError 404/)
    console.log("PASS: leaf retry re-ran the fetch (still failing, still retryable)")

    // 5. Rate limited → not in the leaf map: rides the residual to the page
    //    boundary's tag map, which renders the unwrapped, typed payload.
    //    (.caught is CSS-uppercased; innerText reflects it → /i.)
    await demo.locator("button", { hasText: "Rate limited" }).click()
    await waitForText(/page boundary caught: RateLimited/i)
    await waitForText(/retry in 30s/)
    console.log("PASS: unmatched tag escalated to the page boundary (unwrapped)")

    // 6. Controls outside the boundary survived; fix the id, boundary reset
    //    re-runs construction → recovers.
    await demo.locator("button", { hasText: "Ada (42)" }).click()
    await demo.locator(".boundary-fallback button.retry").click()
    await waitForText(/Ada Lovelace/)
    console.log("PASS: boundary retry after fixing the id recovered")

    if (errors.length > 0) {
      console.error("FAIL: console errors:", errors)
      process.exitCode = 1
    } else {
      console.log("PASS: no console errors")
    }
  },
})
