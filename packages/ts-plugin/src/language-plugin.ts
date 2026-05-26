import type { LanguagePlugin, VirtualCode } from "@volar/language-core"
import type * as ts from "typescript"
import { transformEfx } from "@efx/compiler"
import { convertSourceMap } from "./source-map.ts"
import { EfxVirtualCode, setEfxVirtualCode } from "./virtual-code.ts"

// Volar's typescript property type isn't in the public LanguagePlugin interface
// but is expected by createLanguageServicePlugin
interface TypeScriptConfig {
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
 * Volar language plugin describing `.efx` files: how to identify them,
 * how to produce a virtual TypeScript code from one, and which extension
 * TypeScript should associate with the result.
 *
 * The `EfxVirtualCode` instance returned here is the same instance the
 * cache holds — Volar and our internal consumers share one object per
 * `.efx` file (matches Vue's VueVirtualCode pattern).
 */
export const efxLanguagePlugin: LanguagePlugin<string, EfxVirtualCode> & { typescript: TypeScriptConfig } = {
  getLanguageId(scriptId) {
    if (scriptId.endsWith(".efx")) {
      return "efx"
    }
    return undefined
  },

  createVirtualCode(scriptId, languageId, snapshot) {
    if (languageId !== "efx") {
      return undefined
    }

    const source = snapshot.getText(0, snapshot.getLength())
    const result = transformEfx(source, scriptId)
    const mappings = convertSourceMap(result.map, source, result.code, result.jsxRanges)
    const vc = new EfxVirtualCode(source, result.code, mappings, result.jsxRanges)
    setEfxVirtualCode(scriptId, vc)
    return vc
  },

  typescript: {
    extraFileExtensions: [
      {
        extension: "efx",
        isMixedContent: false,
        scriptKind: 3 as ts.ScriptKind.TS,
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
