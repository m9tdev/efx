export {
  createVerrexLanguagePlugin,
  type TypeScriptConfig,
  type VerrexLanguagePluginOptions,
} from "./language-plugin.ts"
export { convertSourceMap } from "./source-map.ts"
export { VerrexVirtualCode } from "./virtual-code.ts"
export type { JsxRange } from "@verrex/core/compiler"
export { createVerrexServicePlugin } from "./service-plugin.ts"
export {
  SEVERITY_ERROR,
  SEVERITY_HINT,
  SEVERITY_WARNING,
  toGeneratedRange,
  toLspDiagnostics,
  toTsDiagnostics,
  VERREX_DIAGNOSTIC_CODE,
  VERREX_DIAGNOSTIC_SOURCE,
} from "./diagnostics.ts"
