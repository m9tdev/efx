import { defineConfig } from "vite"
import { efx } from "@effx/vite-plugin"

export default defineConfig({
  root: ".",
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Vite 7+ blocks non-localhost hosts by default; allow any so the LAN /
    // Tailscale URLs the user is on can hit the dev server.
    allowedHosts: true,
  },
  resolve: {
    // Prefer .efx over .ts so dev mode resolves source files through our plugin.
    extensions: [".efx", ".ts", ".tsx", ".mjs", ".js", ".mts", ".cts"],
  },
  plugins: [efx()],
})
