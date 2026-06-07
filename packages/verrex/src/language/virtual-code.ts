import type { CodeInformation, VirtualCode } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { JsxRange } from "verrex/compiler"
import type * as ts from "typescript"

/**
 * The compiled representation of a `.vx` file.
 *
 * One instance per `.vx`, owned by Volar (returned from `createVirtualCode`
 * and indexed at `language.scripts.get(id).generated.root`). Downstream
 * consumers (`@verrex/ts-plugin`) read it back from Volar's own context and
 * `instanceof`-narrow to this class — there is no second index. The Volar
 * contract fields (`id`, `languageId`, `snapshot`, `mappings`,
 * `embeddedCodes`) live alongside the verrex-specific data (`source`,
 * `compiled`, `jsxRanges`) on the same object. Matches Vue's
 * `VueVirtualCode` pattern.
 *
 * Source ↔ generated offset translation is handled by Volar's own
 * `SourceMap` (which indexes the `mappings` array) — we don't need to
 * expose offset-conversion methods here.
 */
export class VerrexVirtualCode implements VirtualCode {
  readonly id = "verrex-ts"
  readonly languageId = "typescript"
  readonly embeddedCodes: VirtualCode[] = []
  readonly snapshot: ts.IScriptSnapshot
  readonly source: string
  readonly compiled: string
  readonly mappings: Mapping<CodeInformation>[]
  readonly jsxRanges: ReadonlyArray<JsxRange>

  // Fields are declared explicitly rather than via constructor parameter
  // properties so Node's `--experimental-strip-types` (used by verrex-check and
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
