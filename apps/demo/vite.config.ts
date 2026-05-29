import { defineConfig } from "vite"
import { efx } from "@efx/vite-plugin"

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
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // `effect` ships a `/*#__PURE__*/` annotation in a position Rolldown
        // can't interpret (unstable/http/HttpRouter.js). It's a dead-code-
        // elimination hint in a dependency we don't control and don't import
        // — harmless, but noisy on every build. Match on `warning.id` (the
        // clean module path) rather than `message` (ANSI-colored, and could
        // contain the substring incidentally) so a real INVALID_ANNOTATION in
        // our own code still warns. Silences only effect's modules.
        if (
          warning.code === "INVALID_ANNOTATION" &&
          (warning.id?.includes("/effect/") ?? false)
        ) {
          return
        }
        defaultHandler(warning)
      },
    },
  },
  plugins: [efx()],
})
