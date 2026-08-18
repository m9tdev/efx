export {
  createVerrexLanguagePlugin,
  type TypeScriptConfig,
  type VerrexLanguagePluginOptions,
} from "./language-plugin.ts"
export { convertSourceMap } from "./source-map.ts"
export { VerrexVirtualCode } from "./virtual-code.ts"
export type { JsxRange } from "@verrex/core/compiler"
export {
  createVerrexServicePlugin,
  toGeneratedRange,
} from "./service-plugin.ts"
