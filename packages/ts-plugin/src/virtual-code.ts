import type { CodeInformation, VirtualCode } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { JsxRange } from "@efx/compiler"
import type * as ts from "typescript"

/**
 * The compiled-and-cached representation of a `.efx` file.
 *
 * One instance per `.efx`: shared between Volar (which holds it as the
 * `VirtualCode` returned from `createVirtualCode`) and this plugin's
 * internal consumers (service-proxy.ts, jsx-tags.ts). No duplication —
 * the Volar contract fields (`id`, `languageId`, `snapshot`, `mappings`,
 * `embeddedCodes`) live alongside the efx-specific data (`source`,
 * `compiled`, `jsxRanges`) on the same object.
 *
 * Offset conversion is a method, not a free function, so callers that
 * already have the instance avoid an extra cache lookup.
 */
export class EfxVirtualCode implements VirtualCode {
  readonly id = "efx-ts"
  readonly languageId = "typescript"
  readonly embeddedCodes: VirtualCode[] = []
  readonly snapshot: ts.IScriptSnapshot

  constructor(
    readonly source: string,
    readonly compiled: string,
    readonly mappings: Mapping<CodeInformation>[],
    readonly jsxRanges: ReadonlyArray<JsxRange>,
  ) {
    this.snapshot = {
      getText: (start, end) => compiled.slice(start, end),
      getLength: () => compiled.length,
      getChangeRange: () => undefined,
    }
  }

  /**
   * Find the source offset corresponding to a compiled-side offset.
   * Mappings are point-to-point — we pick the closest mapping at or
   * before the query and apply the delta.
   */
  compiledToSourceOffset(compiledOffset: number): number | null {
    let bestMapping: { generatedOffset: number; sourceOffset: number } | null = null
    for (const mapping of this.mappings) {
      const genOff = mapping.generatedOffsets[0]
      if (genOff === undefined) continue
      if (genOff <= compiledOffset) {
        if (!bestMapping || genOff > bestMapping.generatedOffset) {
          const srcOff = mapping.sourceOffsets[0]
          if (srcOff === undefined) continue
          bestMapping = { generatedOffset: genOff, sourceOffset: srcOff }
        }
      }
    }
    if (!bestMapping) return null
    const delta = compiledOffset - bestMapping.generatedOffset
    return bestMapping.sourceOffset + delta
  }

  /** The inverse of `compiledToSourceOffset`. */
  sourceToCompiledOffset(sourceOffset: number): number | null {
    let bestMapping: { generatedOffset: number; sourceOffset: number } | null = null
    for (const mapping of this.mappings) {
      const srcOff = mapping.sourceOffsets[0]
      if (srcOff === undefined) continue
      if (srcOff <= sourceOffset) {
        if (!bestMapping || srcOff > bestMapping.sourceOffset) {
          const genOff = mapping.generatedOffsets[0]
          if (genOff === undefined) continue
          bestMapping = { generatedOffset: genOff, sourceOffset: srcOff }
        }
      }
    }
    if (!bestMapping) return null
    const delta = sourceOffset - bestMapping.sourceOffset
    return bestMapping.generatedOffset + delta
  }
}

// Module-level cache keyed by `.efx` script path. Sole writer is
// `language-plugin.ts`; readers go through `getEfxVirtualCode`.
const cache = new Map<string, EfxVirtualCode>()

export const setEfxVirtualCode = (efxPath: string, vc: EfxVirtualCode): void => {
  cache.set(efxPath, vc)
}

export const getEfxVirtualCode = (efxPath: string): EfxVirtualCode | undefined =>
  cache.get(efxPath)
