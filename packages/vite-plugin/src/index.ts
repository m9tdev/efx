import { readFile } from "node:fs/promises"
import type { Plugin } from "vite"
import { transformEfx } from "@efx/compiler"

const EFX_RE = /\.efx(?:\?[^.]*)?$/
const EFX_PATH_RE = /\.efx$/
// Match URL path that ends in .efx (with or without an existing query).
const EFX_URL_RE = /\.efx(\?.*)?$/
const HAS_IMPORT_RE = /[?&]import(=|&|$)/

/**
 * Vite plugin that handles `.efx` files.
 *
 * Pipeline per `.efx` request:
 *   1. Plugin's `transform` hook compiles JSX → `h()` calls via @efx/compiler.
 *      Output is plain TypeScript (no JSX nodes left).
 *   2. Vite's built-in esbuild step strips TypeScript types. We extend its
 *      `include` glob so .efx files go through the same TS pipeline as .ts.
 *
 * TypeScript's JSX type checker never sees the JSX — it sees only the emitted
 * call expressions and runs ordinary generic inference on `h`'s signature.
 */
export function efx(): Plugin {
  return {
    name: "vite-plugin-efx",
    enforce: "pre",
    config() {
      return {
        esbuild: {
          include: [/\.efx$/, /\.tsx?$/],
          loader: "ts",
        },
      }
    },
    // Server middleware: every request for a `.efx` URL gets `?import`
    // appended (if not already present) before any of Vite's built-in
    // middleware runs. This forces `.efx` through the module pipeline
    // — where our `load`/`transform` hooks fire and Vite sets
    // Content-Type: text/javascript — instead of through the static-
    // asset middleware (which serves an empty Content-Type that real
    // browsers reject under strict-MIME).
    //
    // Handles both initial document loads AND HMR re-fetches that
    // include `?t=<ts>` cache-bust queries.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (
          req.url &&
          EFX_URL_RE.test(req.url) &&
          !HAS_IMPORT_RE.test(req.url)
        ) {
          req.url = req.url.includes("?")
            ? `${req.url}&import`
            : `${req.url}?import`
        }
        next()
      })
    },
    // Explicit `load` hook for completeness — handles the `?import` form.
    async load(id) {
      const path = id.split("?")[0]
      if (!path || !EFX_PATH_RE.test(path)) return null
      return await readFile(path, "utf-8")
    },
    async transform(code, id) {
      if (!EFX_RE.test(id)) return null
      const result = transformEfx(code, id)
      return { code: result.code, map: result.map as never }
    },
  }
}

export default efx
