import type { CodeInformation } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { JsxRange } from "@efx/compiler"

/**
 * Per-`.efx` compiled state captured when `createVirtualCode` runs.
 * The TS plugin's offset converters and tag-pair lookup read from
 * this cache without re-running the compiler.
 *
 * The shape is data-only by design — promoting it to a class
 * (so methods replace free-function accessors) is the next step
 * once a second consumer needs richer behaviour.
 */
export interface SourceMapCache {
  readonly source: string
  readonly compiled: string
  readonly mappings: Mapping<CodeInformation>[]
  readonly jsxRanges: ReadonlyArray<JsxRange>
}

const cache = new Map<string, SourceMapCache>()

export const setCache = (efxPath: string, entry: SourceMapCache): void => {
  cache.set(efxPath, entry)
}

export const getCache = (efxPath: string): SourceMapCache | undefined =>
  cache.get(efxPath)
