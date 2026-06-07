import { runProbe } from "./probe-harness.mjs"

await runProbe({
  viewport: { width: 900, height: 1500 },
  onConsole: (m) => { if (m.type() === "error") console.error("[console]", m.text()) },
  run: async (page) => {
    await page.waitForSelector(".todos ul")

    const list = page.locator(".todos ul li")

    console.log("initial item count:", await list.count())
    const initialTexts = await list.locator(".text").allInnerTexts()
    console.log("initial texts:", initialTexts)
    console.log("initial remaining:", (await page.locator(".todos .remaining").innerText()).trim())

    await page.screenshot({ path: "/tmp/verrex-verify/08-todos-initial.png" })

    // Capture the DOM node of the first item BEFORE we touch anything else,
    // so we can confirm later that toggling didn't replace it.
    const firstNodeId = await list.first().evaluate((el) => {
      el.setAttribute("data-probe-id", "first-row")
      return el.getAttribute("data-probe-id")
    })
    console.log("tagged first row:", firstNodeId)

    // Toggle the second item (index 1 — "use it for something")
    await list.nth(1).locator(".toggle").click()
    await page.waitForTimeout(50)
    const secondClass = await list.nth(1).getAttribute("class")
    console.log("after toggling #2, its class:", secondClass)
    console.log("remaining after toggle:", (await page.locator(".todos .remaining").innerText()).trim())

    // Verify first row's DOM node was NOT touched
    const firstStillTagged = await list.first().getAttribute("data-probe-id")
    console.log("first row still tagged (proves no full rebuild):", firstStillTagged === "first-row")

    // Add a todo
    await page.locator(".todos .controls button", { hasText: "add todo" }).click()
    await page.waitForTimeout(50)
    console.log("after add, item count:", await list.count())
    const addedText = await list.last().locator(".text").innerText()
    console.log("added text:", addedText)

    // Remove first item
    await list.first().locator(".remove").click()
    await page.waitForTimeout(50)
    console.log("after remove first, item count:", await list.count())
    const newFirstText = await list.first().locator(".text").innerText()
    console.log("new first text:", newFirstText)

    await page.screenshot({ path: "/tmp/verrex-verify/09-todos-after.png" })
  },
})

console.log("DONE")
