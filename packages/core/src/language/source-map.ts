import type { CodeInformation } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { CompilerMapping, CompilerMappingKind } from "@verrex/core/compiler"

/**
 * Translate the compiler's typed `CompilerMapping[]` into Volar's
 * `Mapping<CodeInformation>[]`.
 *
 * All the heavy lifting (decoding Babel's V3 source map, deduplicating
 * segments, computing source AND generated span lengths, intersecting with
 * `jsxRanges` to classify each region) lives in `verrex/compiler/src/source-map`.
 * This function is intentionally trivial: kind → `CodeInformation` profile,
 * and copy the offset/length pairs across.
 */
export function convertSourceMap(
  mappings: ReadonlyArray<CompilerMapping>,
): Mapping<CodeInformation>[] {
  return mappings.map((m) => ({
    sourceOffsets: [m.source.offset],
    generatedOffsets: [m.generated.offset],
    lengths: [m.source.length],
    generatedLengths: [m.generated.length],
    data: PROFILE_BY_KIND[m.kind],
  }))
}

const fullData: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  format: true,
}

// h() internals: keep semantic features but suppress highlight (cursor on a
// tag name shouldn't highlight every `h` identifier in the file). Matches the
// Vue tactic for `<template>` content.
const noHighlightData: CodeInformation = {
  verification: true,
  completion: true,
  semantic: { shouldHighlight: () => false },
  navigation: true,
  structure: true,
  format: true,
}

// JSX punctuation (`<`/`>`/`/`): no semantic, no completion, no navigation —
// cursor on `<` shouldn't navigate to `h`'s definition.
const structuralOnlyData: CodeInformation = {
  verification: true,
  completion: false,
  semantic: false,
  navigation: false,
  structure: true,
  format: true,
}

const PROFILE_BY_KIND: Record<CompilerMappingKind, CodeInformation> = {
  user: fullData,
  "h-call": noHighlightData,
  punctuation: structuralOnlyData,
}
