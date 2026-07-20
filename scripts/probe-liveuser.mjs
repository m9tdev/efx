import { runProbe } from "./probe-harness.mjs"

await runProbe({
  viewport: { width: 900, height: 1300 },
  run: async (page) => {
    await page.waitForSelector(".live-user")

    // Initial state — should show Ada
    let live = await page.locator(".live-user .user-card strong").innerText()
    const initial = live
    console.log("initial:", live)

    await page.screenshot({ path: "/tmp/verrex-verify/04-live-initial.png" })

    // Click Grace (7)
    await page.locator(".live-user button", { hasText: "Grace (7)" }).click()
    await page.waitForTimeout(900)
    live = await page.locator(".live-user .user-card strong").innerText()
    const grace = live
    console.log("after Grace click:", live)
    await page.screenshot({ path: "/tmp/verrex-verify/05-live-grace.png" })

    // Click Bad id — should produce a failure state, no .user-card
    await page.locator(".live-user button", { hasText: "Bad id" }).click()
    await page.waitForTimeout(900)
    const errEl = await page.locator(".live-user .error").count()
    const sawError = errEl > 0
    console.log("error state visible:", sawError)
    const errText =
      errEl > 0
        ? await page.locator(".live-user .error").first().innerText()
        : "(no error element)"
    console.log("error text:", errText.slice(0, 80))
    await page.screenshot({ path: "/tmp/verrex-verify/06-live-error.png" })

    // Click Ada (42) again — should recover to success
    await page.locator(".live-user button", { hasText: "Ada (42)" }).click()
    await page.waitForTimeout(900)
    live = await page
      .locator(".live-user .user-card strong")
      .innerText()
      .catch(() => "(none)")
    console.log("after Ada recovery:", live)
    await page.screenshot({ path: "/tmp/verrex-verify/07-live-recover.png" })

    // Assert, don't just narrate. This probe only logged its observations and
    // always exited 0, so it stayed "green" while sampling the pre-refetch DOM
    // at 400ms against a 600ms service — every reading was the stale previous
    // user and nothing could notice.
    const results = {
      initialAda: initial === "Ada Lovelace",
      refetchedGrace: grace === "Grace Hopper",
      badIdShowsError: sawError,
      recoveredToAda: live === "Ada Lovelace",
    }
    console.log("\n[results]", JSON.stringify(results, null, 2))
    if (!Object.values(results).every(Boolean)) {
      console.error("\nFAIL", results)
      process.exitCode = 1
    } else {
      console.log("\nPASS — asyncRef refetches and recovers on trigger change")
    }
  },
})
