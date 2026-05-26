import type { LanguagePlugin, VirtualCode } from "@volar/language-core"
import type * as ts from "typescript"
import { transformEfx } from "@efx/compiler"
import { convertSourceMap } from "./source-map.ts"
import { setCache } from "./virtual-code.ts"

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
 * Compilation runs once per `createVirtualCode` invocation; the result
 * is stashed in the SourceMapCache so the proxy wrapper can convert
 * offsets without re-running the compiler.
 */
export const efxLanguagePlugin: LanguagePlugin<string> & { typescript: TypeScriptConfig } = {
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
    const compiled = result.code
    const jsxRanges = result.jsxRanges

    // Convert Babel source map to Volar mappings
    const mappings = convertSourceMap(result.map, source, compiled, jsxRanges)

    // Cache source map data for offset conversion in definition results
    setCache(scriptId, { source, compiled, mappings, jsxRanges })

    const virtualCode: VirtualCode = {
      id: "efx-ts",
      languageId: "typescript",
      snapshot: {
        getText: (start, end) => compiled.slice(start, end),
        getLength: () => compiled.length,
        getChangeRange: () => undefined,
      },
      mappings,
      embeddedCodes: [],
    }

    return virtualCode
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
