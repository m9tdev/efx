import type { LanguagePlugin, VirtualCode } from "@volar/language-core"
import type * as ts from "typescript"
import { transformEfx } from "@efx/compiler"
import { convertSourceMap } from "./source-map.ts"
import { EfxVirtualCode, setEfxVirtualCode } from "./virtual-code.ts"

// Volar's typescript property type isn't in the public LanguagePlugin interface
// but is expected by createLanguageServicePlugin
export interface TypeScriptConfig {
  extraFileExtensions: Array<{
    extension: string
    isMixedContent: boolean
    scriptKind: ts.ScriptKind
  }>
  getServiceScript(root: VirtualCode): {
    code: VirtualCode
    extension: string
    scriptKind: ts.ScriptKind
  }
}

/**
 * Build a Volar LanguagePlugin describing `.efx` files for a given Volar host.
 *
 * The factory takes `asFileName` because different Volar hosts identify scripts
 * differently: tsserver passes string paths, `@volar/kit` (used by efx-check)
 * passes `URI` instances. Internally we always cache and pass to the compiler
 * by file-path string, so the host-specific identity collapses here.
 *
 * The `EfxVirtualCode` instance returned here is the same instance the cache
 * holds — Volar and downstream consumers share one object per `.efx` file
 * (matches Vue's `VueVirtualCode` pattern).
 */
export function createEfxLanguagePlugin<T>(
  asFileName: (scriptId: T) => string,
): LanguagePlugin<T, EfxVirtualCode> & { typescript: TypeScriptConfig } {
  return {
    getLanguageId(scriptId) {
      if (asFileName(scriptId).endsWith(".efx")) {
        return "efx"
      }
      return undefined
    },

    createVirtualCode(scriptId, languageId, snapshot) {
      if (languageId !== "efx") {
        return undefined
      }

      const fileName = asFileName(scriptId)
      const source = snapshot.getText(0, snapshot.getLength())
      const result = transformEfx(source, fileName)
      const mappings = convertSourceMap(result.map, source, result.code, result.jsxRanges)
      const vc = new EfxVirtualCode(source, result.code, mappings, result.jsxRanges)
      setEfxVirtualCode(fileName, vc)
      return vc
    },

    typescript: {
      extraFileExtensions: [
        {
          extension: "efx",
          // `isMixedContent: true` + `Deferred` script kind = the Vue/Astro pattern:
          // tells tsc that .efx is a host-described file format whose actual script
          // content is supplied by the LanguagePlugin via `getServiceScript`.
          // The `parseJsonSourceFileConfigFileContent` glob expander only matches
          // include-paths against custom extensions when this pair is set this way.
          isMixedContent: true,
          scriptKind: 7 as ts.ScriptKind.Deferred,
        },
      ],

      getServiceScript(root: VirtualCode) {
        return {
          code: root,
          extension: ".ts",
          scriptKind: 3 as ts.ScriptKind.TS,
        }
      },
    },
  }
}
