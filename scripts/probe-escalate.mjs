// Probe for step 08 — `On` failure homes over `atom`s: the tag block's
// `HttpError` arm handles that tag at the leaf, the open block beside it has
// no failure arm so everything bubbles, and the fake endpoint REALLY
// rate-limits (2 requests/second across both atoms, counted at
// request-creation time). Verifies: both blocks render on load; a
// leaf-handled HttpError (Bad id) renders the leaf fallback WITHOUT touching
// the page tag-arm boundary while the SAME failure escalates the open block
// to its catch-all banner; the tag block's atom recovers on a dep change with
// no reset while the open form needs its banner's refresh+reset; leaf retry
// (`Atom.refresh`) shows the waiting arm then re-fails; spam ×3 (three manual
// refreshes of the top atom) trips the limiter and RateLimited rides the
// residual to the page tag arm; the page banner's refresh+reset then
// re-fetches the STILL-SELECTED id. Every id click costs one request PER
// ATOM, so steps that must not be limited settle >1s first.
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

    // 3. Tag-map handle recovers on the dep change with NO reset. The
    //    open-form handle ALSO refetched (data outlives the swapped view),
    //    but its banner stays until refetch+reset re-renders it.
    await settle()
    await demo.locator("button", { hasText: "Grace (7)" }).click()
    await waitForText(/Grace Hopper/)
    await settle()
    await demo.locator(".open-fallback button.retry").click()
    await demo.locator(".open-ok", { hasText: "Grace Hopper" }).waitFor()
    console.log(
      "PASS: leaf recovered on dep change; open form recovered via reset",
    )

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
    console.log(
      "PASS: leaf retry re-ran the fetch (loading shown, still retryable)",
    )

    // 5. Spam ×3 → three manual refetches of the top handle for the CURRENT
    //    id (999): the third exceeds 2 req/s — a REAL RateLimited. Not in the
    //    leaf map → rides the residual to the page boundary's tag map, which
    //    renders the unwrapped, typed payload. (.caught is CSS-uppercased → /i.)
    await settle()
    await demo.locator("button.spam").click()
    await waitForText(/429 rate-limited/) // the request log narrates the limiter
    await waitForText(/page boundary caught: RateLimited/i)
    await waitForText(/retry in \d+ms/)
    await demo.locator(".open-fallback").waitFor()
    console.log(
      "PASS: real rate limit tripped (logged); residual escalated to the page tag map",
    )

    // 6. Spam never touched the selection: the page banner's refetch+reset
    //    re-fetches the STILL-SELECTED Bad id → 404 → handled at the leaf
    //    again. (Necessary-refetch proof for the page banner: reset alone
    //    would re-escalate the stale RateLimited, never reach the leaf.)
    await settle()
    await demo.locator(".page-fallback button.retry").click()
    await demo.locator(".content .leaf-fallback").waitFor()
    console.log(
      "PASS: page banner refetch+reset kept the selected id (404 → leaf)",
    )

    // 7. Necessary-refetch proof for the OPEN banner: its handle has been
    //    failed (404) since step 4 — no dep change recovered it — so reset
    //    alone would re-escalate instantly with no loading window. The
    //    refetch flips waiting synchronously, so the rebuild must show the
    //    loading arm before the re-failure brings the banner back.
    await settle()
    await demo.locator(".open-fallback button.retry").click()
    await demo.locator(".contrast .loading").waitFor()
    await demo.locator(".open-fallback").waitFor()
    console.log(
      "PASS: open banner refetch engaged (loading shown), re-escalated on 404",
    )

    // 8. A good id, then the open banner's retry recovers it too — no stale
    //    banner left at exit.
    await settle()
    await demo.locator("button", { hasText: "Ada (42)" }).click()
    await waitForText(/Ada Lovelace/)
    await settle()
    await demo.locator(".open-fallback button.retry").click()
    await demo.locator(".open-ok", { hasText: "Ada Lovelace" }).waitFor()
    console.log("PASS: both blocks recovered (no stale banner at exit)")

    if (errors.length > 0) {
      console.error("FAIL: console errors:", errors)
      process.exitCode = 1
    } else {
      console.log("PASS: no console errors")
    }
  },
})
