import type { Plugin } from "vite"
import { transformEfx } from "@effx/compiler"

const EFX_RE = /\.efx(?:\?[^.]*)?$/

/**
 * Vite plugin that handles `.efx` files.
 *
 * Pipeline per `.efx` request:
 *   1. Plugin's `transform` hook compiles JSX → `h()` calls via @effx/compiler.
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
    async transform(code, id) {
      if (!EFX_RE.test(id)) return null
      const result = transformEfx(code, id)
      return { code: result.code, map: result.map as never }
    },
  }
}

export default efx
