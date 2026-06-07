// Smoke test. The full integration test would need a `ts.server.ProjectService`
// (the real tsserver path) because `ts.createLanguageService` filters files by
// extension before plugins can override script-kind. So we verify the plugin
// loads + has the expected shape; the real-world flow is verified by running
// it in an editor against the demo.
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ts = require("typescript")
const plugin = require(resolve(__dirname, "../dist/index.cjs"))

describe("ts-plugin: shape", () => {
  it("loads as a CommonJS module", () => {
    expect(typeof plugin).toBe("function")
  })

  it("plugin factory returns a `create` function", () => {
    const factory = plugin({ typescript: ts })
    expect(typeof factory.create).toBe("function")
  })
})
