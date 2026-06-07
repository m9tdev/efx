// HMR probe: open the demo, edit Counter.vx in place, confirm the change
// appears in the browser without manual reload.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { runProbe } from "./probe-harness.mjs"

const COUNTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/demo/src/Counter.vx",
)

const original = readFileSync(COUNTER_PATH, "utf8")

let afterEdit
try {
  await runProbe({
    viewport: { width: 900, height: 700 },
    run: async (page) => {
      await page.waitForSelector(".counter")

      const initialText = await page.locator(".counter .count").innerText()
      console.log("initial text:", JSON.stringify(initialText))

      // Mutate the .vx file: change "clicks" to "CLICKED"
      writeFileSync(COUNTER_PATH, original.replace("clicks:", "CLICKED:"), "utf8")

      // Wait for Vite HMR to propagate
      await page.waitForFunction(
        () => document.querySelector(".counter .count")?.textContent?.includes("CLICKED"),
        { timeout: 5000 },
      ).catch(() => null)

      afterEdit = await page.locator(".counter .count").innerText()
      console.log("after edit text:", JSON.stringify(afterEdit))
    },
  })
} finally {
  // Restore the file even if the probe (or harness) threw.
  writeFileSync(COUNTER_PATH, original, "utf8")
}

const ok = afterEdit?.includes("CLICKED")
console.log(ok ? "HMR PASS" : "HMR FAIL")
process.exit(ok ? 0 : 1)
