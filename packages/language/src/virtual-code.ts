import type { CodeInformation, VirtualCode } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { JsxRange } from "@efx/compiler"
import type * as ts from "typescript"

/**
 * The compiled-and-cached representation of a `.efx` file.
 *
 * One instance per `.efx`: shared between Volar (which holds it as the
 * `VirtualCode` returned from `createVirtualCode`) and downstream
 * consumers (`@efx/ts-plugin/jsx-tags`, which reads `jsxRanges` for
 * tag-pair highlights). No duplication — the Volar contract fields
 * (`id`, `languageId`, `snapshot`, `mappings`, `embeddedCodes`) live
 * alongside the efx-specific data (`source`, `compiled`, `jsxRanges`)
 * on the same object. Matches Vue's `VueVirtualCode` pattern.
 *
 * Source ↔ generated offset translation is handled by Volar's own
 * `SourceMap` (which indexes the `mappings` array) — we don't need to
 * expose offset-conversion methods here.
 */
export class EfxVirtualCode implements VirtualCode {
  readonly id = "efx-ts"
  readonly languageId = "typescript"
  readonly embeddedCodes: VirtualCode[] = []
  readonly snapshot: ts.IScriptSnapshot
  readonly source: string
  readonly compiled: string
  readonly mappings: Mapping<CodeInformation>[]
  readonly jsxRanges: ReadonlyArray<JsxRange>

  // Fields are declared explicitly rather than via constructor parameter
  // properties so Node's `--experimental-strip-types` (used by efx-check and
  // its tests, which load `.ts` directly) accepts the file. Parameter
  // properties (`constructor(readonly x: T)`) aren't pure type syntax —
  // they desugar into field assignments — and strip-only mode rejects them.
  constructor(
    source: string,
    compiled: string,
    mappings: Mapping<CodeInformation>[],
    jsxRanges: ReadonlyArray<JsxRange>,
  ) {
    this.source = source
    this.compiled = compiled
    this.mappings = mappings
    this.jsxRanges = jsxRanges
    this.snapshot = {
      getText: (start, end) => compiled.slice(start, end),
      getLength: () => compiled.length,
      getChangeRange: () => undefined,
    }
  }
}

/**
 * Per-consumer cache of compiled `.efx` files keyed by script path. The
 * LanguagePlugin's `createVirtualCode` writes through it; downstream
 * consumers (ts-plugin's service-proxy + jsx-tags) read from it. One
 * registry per consumer (one per tsserver session, one per `runCheck`
 * call) — invocations don't share state through a module-level singleton.
 */
export class VirtualCodeRegistry {
  private readonly cache = new Map<string, EfxVirtualCode>()

  set(efxPath: string, vc: EfxVirtualCode): void {
    this.cache.set(efxPath, vc)
  }

  get(efxPath: string): EfxVirtualCode | undefined {
    return this.cache.get(efxPath)
  }
}
