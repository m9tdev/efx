import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // In-process DOM so component mounts/interactions run without a browser.
    environment: "happy-dom",
  },
})
