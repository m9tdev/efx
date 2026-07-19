import type {
  CodeInformation,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core"
import type * as ts from "typescript"
import { transformVerrex } from "@verrex/core/compiler"
import { convertSourceMap } from "./source-map.ts"
import { VerrexVirtualCode } from "./virtual-code.ts"

// The capability profile for last-good fallback mappings. They refer to the
// PREVIOUS source text, so every offset is suspect by the edit delta:
// - completion stays on — completions/signature help are the whole point of
//   keeping a language service alive mid-edit, are cursor-anchored, and a
//   slightly-off result is transient UI;
// - semantic (inlay hints, hover, semantic tokens) and verification
//   (diagnostics) are off — they DECORATE positions, and a shifted hint
//   renders inside the wrong token (a `: HttpError` hint chopping an
//   identifier apart);
// - navigation (rename!) and format are off — they WRITE at mapped offsets,
//   and a stale offset would edit the wrong code.
//
// Residual risk, accepted: completion is itself a write path (auto-import
// additionalTextEdits land at the import block's mapped offsets). Those
// offsets only shift when the breaking edit sits ABOVE the imports — mid-edit
// deltas almost always sit below them — and disabling completion would gut
// the fallback's purpose.
const FALLBACK_DATA: CodeInformation = {
  verification: false,
  completion: true,
  semantic: false,
  navigation: false,
  structure: false,
  format: false,
}

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

export interface VerrexLanguagePluginOptions {
  /**
   * What to do when the compiler throws on unparseable source. Babel's
   * `errorRecovery` absorbs most mid-edit states, but some token sequences
   * are unrecoverable and throw — and an editor host recompiles on every
   * keystroke, so a throw here fails the whole tsserver request the user
   * just made (surfaced as `-32603 ... SyntaxError` noise in the editor).
   *
   * - `"recover"` (default — editor hosts): degrade to the file's last good
   *   compile served with completion-only mappings (see `FALLBACK_DATA`), so
   *   cross-file types stay stable and completions keep working until the
   *   source parses again; an empty module if the file has never compiled.
   * - `"throw"` (batch hosts: verrex-check): propagate, keeping failures
   *   loud — a checker must never silently report against stale output.
   */
  readonly onTransformError?: "recover" | "throw"
}

/**
 * Build a Volar LanguagePlugin describing `.vx` files for a given Volar host.
 *
 * The factory takes `asFileName` because different Volar hosts identify scripts
 * differently: tsserver passes string paths, `@volar/kit` (used by verrex-check)
 * passes `URI` instances. Internally we always pass to the compiler by
 * file-path string, so the host-specific identity collapses here.
 *
 * The `VerrexVirtualCode` instance returned from `createVirtualCode` is the one
 * Volar owns and indexes (`language.scripts.get(id).generated.root`). Downstream
 * consumers read it back from Volar's own context rather than a side-channel
 * cache — there is no second index to keep in sync (matches Vue's
 * `VueVirtualCode` pattern, where `typescript-plugin` resolves the root through
 * `language.scripts`).
 */
export function createVerrexLanguagePlugin<T>(
  asFileName: (scriptId: T) => string,
  options: VerrexLanguagePluginOptions = {},
): LanguagePlugin<T, VerrexVirtualCode> & { typescript: TypeScriptConfig } {
  const onTransformError = options.onTransformError ?? "recover"
  // Last successful compile per file, the "recover" fallback. Bounded by the
  // project's .vx file count (evicted via disposeVirtualCode); entries are
  // the size of the compiled output. No jsxRanges: the fallback never serves
  // them (see below).
  const lastGood = new Map<
    string,
    Pick<VerrexVirtualCode, "compiled" | "mappings">
  >()

  return {
    getLanguageId(scriptId) {
      if (asFileName(scriptId).endsWith(".vx")) {
        return "verrex"
      }
      return undefined
    },

    createVirtualCode(scriptId, languageId, snapshot) {
      if (languageId !== "verrex") {
        return undefined
      }

      const fileName = asFileName(scriptId)
      const source = snapshot.getText(0, snapshot.getLength())
      try {
        const result = transformVerrex(source, fileName)
        const mappings = convertSourceMap(result.mappings)
        lastGood.set(fileName, { compiled: result.code, mappings })
        return new VerrexVirtualCode(
          source,
          result.code,
          mappings,
          result.jsxRanges,
        )
      } catch (error) {
        if (onTransformError === "throw") {
          // Babel's message carries only line:col — name the file for batch
          // hosts (a multi-file `verrex-check --watch` pass reports this
          // message verbatim).
          throw new Error(
            `${fileName}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
        const cached = lastGood.get(fileName)
        if (cached) {
          // The cached mappings refer to the previous source text, so they're
          // served with FALLBACK_DATA: completion-only (see above) — features
          // that decorate or write at mapped positions stay off until the
          // source parses again. jsxRanges are dropped, not served stale:
          // the ts-plugin consumes them directly off the instance (tag-pair
          // highlights), bypassing the mapping gates, and shifted ranges
          // would decorate the wrong tokens — the failure FALLBACK_DATA
          // exists to prevent.
          const mappings = cached.mappings.map((mapping) => ({
            ...mapping,
            data: FALLBACK_DATA,
          }))
          return new VerrexVirtualCode(source, cached.compiled, mappings, [])
        }
        // Never compiled successfully (file created mid-edit): an empty
        // module keeps the script in the project with no false claims.
        return new VerrexVirtualCode(source, "export {}\n", [], [])
      }
    },

    // Volar calls this when a script is removed; without it the lastGood
    // entry would outlive the file, and a path recreated with unparseable
    // content would be served the dead file's exports as current.
    disposeVirtualCode(scriptId) {
      lastGood.delete(asFileName(scriptId))
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
