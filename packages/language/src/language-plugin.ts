import type { LanguagePlugin, VirtualCode } from "@volar/language-core"
import type * as ts from "typescript"
import { transformEfx } from "@efx/compiler"
import { convertSourceMap } from "./source-map.ts"
import { EfxVirtualCode } from "./virtual-code.ts"

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
  resolveHiddenExtensions?: boolean
}

/**
 * Build a Volar LanguagePlugin describing `.vx` files for a given Volar host.
 *
 * The factory takes `asFileName` because different Volar hosts identify scripts
 * differently: tsserver passes string paths, `@volar/kit` (used by efx-check)
 * passes `URI` instances. Internally we always pass to the compiler by
 * file-path string, so the host-specific identity collapses here. This is the
 * plugin's only axis of variation.
 *
 * The `EfxVirtualCode` instance returned from `createVirtualCode` is the one
 * Volar owns and indexes (`language.scripts.get(id).generated.root`). Downstream
 * consumers read it back from Volar's own context rather than a side-channel
 * cache — there is no second index to keep in sync (matches Vue's
 * `VueVirtualCode` pattern, where `typescript-plugin` resolves the root through
 * `language.scripts`).
 */
export function createEfxLanguagePlugin<T>(
  asFileName: (scriptId: T) => string,
): LanguagePlugin<T, EfxVirtualCode> & { typescript: TypeScriptConfig } {
  return {
    getLanguageId(scriptId) {
      if (asFileName(scriptId).endsWith(".vx")) {
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
      const mappings = convertSourceMap(result.mappings)
      return new EfxVirtualCode(source, result.code, mappings, result.jsxRanges)
    },

    typescript: {
      extraFileExtensions: [
        {
          extension: "vx",
          // `isMixedContent: true` + `Deferred` script kind = the Vue/Astro pattern:
          // tells tsc that .vx is a host-described file format whose actual script
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
