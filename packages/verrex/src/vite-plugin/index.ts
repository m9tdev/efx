import { readFile } from "node:fs/promises"
import { type Plugin, transformWithOxc } from "vite"
import { transformVerrex } from "verrex/compiler"

const VERREX_RE = /\.vx(?:\?[^.]*)?$/
const VERREX_PATH_RE = /\.vx$/
// Match URL path that ends in .vx (with or without an existing query).
const VERREX_URL_RE = /\.vx(\?.*)?$/
const HAS_IMPORT_RE = /[?&]import(=|&|$)/

/**
 * Vite plugin that handles `.vx` files.
 *
 * Pipeline per `.vx` request (the plugin owns the whole transform):
 *   1. `verrex/compiler`'s `transformVerrex` rewrites JSX → `h()` calls. Output is
 *      plain TypeScript (no JSX nodes left), with a source map back to `.vx`.
 *   2. Vite's `transformWithOxc` strips the TypeScript types → JavaScript,
 *      chaining the Babel map (passed as `inMap`) so the final map still
 *      points at the original `.vx` source.
 *
 * We return `moduleType: 'js'` so Rolldown treats the result as plain
 * JavaScript instead of trying to infer a language from the unknown `.vx`
 * extension (Vite 8's Rolldown/Oxc pipeline errors with "Failed to detect the
 * lang" otherwise). Owning both steps keeps the plugin bundler-agnostic — it
 * no longer leans on Vite's built-in transformer to finish `.vx` files, which
 * is what broke across the esbuild → oxc swap.
 *
 * TypeScript's JSX type checker never sees the JSX — it sees only the emitted
 * call expressions and runs ordinary generic inference on `h`'s signature.
 */
export function verrex(): Plugin {
  return {
    name: "vite-plugin-verrex",
    enforce: "pre",
    // Server middleware: every request for a `.vx` URL gets `?import`
    // appended (if not already present) before any of Vite's built-in
    // middleware runs. This forces `.vx` through the module pipeline
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
          VERREX_URL_RE.test(req.url) &&
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
      if (!path || !VERREX_PATH_RE.test(path)) return null
      return await readFile(path, "utf-8")
    },
    async transform(code, id) {
      if (!VERREX_RE.test(id)) return null
      // 1. JSX → h() (still TypeScript). `errorRecovery: false` so a genuine
      //    syntax error throws here — Vite surfaces it as an error overlay in
      //    dev and fails the build in CI, rather than the compiler silently
      //    recovering and us shipping a broken module. (The editor path keeps
      //    the default recovery; see verrex/compiler's TransformOptions.)
      const { code: tsCode, map: babelMap } = transformVerrex(code, id, {
        errorRecovery: false,
      })
      // 2. TypeScript → JavaScript. `lang: "ts"` tells Oxc the input is TS
      //    (it can't infer that from the `.vx` id); `inMap` chains the Babel
      //    map so the final map still resolves to the original `.vx`.
      const stripped = await transformWithOxc(
        tsCode,
        id,
        { lang: "ts" },
        babelMap ?? undefined,
      )
      // Spread `map` only when present — `exactOptionalPropertyTypes` rejects
      // an explicit `map: undefined` against the transform result type.
      return {
        code: stripped.code,
        moduleType: "js",
        ...(stripped.map ? { map: stripped.map } : {}),
      }
    },
  }
}

export default verrex
