// AsyncUserPage probe — the `Await` boundary (once form) on a real `.vx` file.
// Unlike UserPage (in-component fetch, blocking), AsyncUserPage shows a pending
// placeholder then swaps in the user body. Asserts the resolved success arm.
import { runProbe } from "./probe-harness.mjs"

await runProbe({
  viewport: { width: 900, height: 1600 },
  run: async (page) => {
    await page.waitForSelector(".async-user-page", { timeout: 5000 })
    // The success arm renders `.user-body` once the fetch resolves.
    await page.waitForSelector(".async-user-page .user-body h1", {
      timeout: 5000,
    })
    const name = await page
      .locator(".async-user-page .user-body h1")
      .innerText()
    const posts = await page
      .locator(".async-user-page .user-body .posts li")
      .count()
    console.log("name:", JSON.stringify(name))
    console.log("post count:", posts)
    console.log(
      name === "Ada Lovelace" && posts === 3
        ? "PASS: AsyncUserPage Await boundary resolved to the success arm"
        : "FAIL: unexpected AsyncUserPage content",
    )
  },
})
