# `@efx/compiler` — `.efx` → plain TypeScript

Single Babel transform. Takes `.efx` source (TypeScript with
angle-bracket `<div>...</div>` syntax — JSX-shape only, no JSX
semantics; see root [AGENTS.md](../../AGENTS.md)) and emits plain
TypeScript with every `<...>` expression rewritten as an
`h(tag, props, ...children)` call. The output contains zero angle
brackets — they are gone before tsc, Vite, or any other downstream
tool sees the file.

Entry point: `transformEfx(source, filename) → { code, map, jsxRanges, mappings }`.

- `code` — compiled TypeScript output.
- `map` — Babel V3 source map. Used by `@efx/vite-plugin` for HMR /
  dev-server source maps.
- `jsxRanges` — source-side metadata about each `JSXElement` /
  `JSXFragment` (opening/closing tag positions). Used by
  `@efx/ts-plugin/src/jsx-tags.ts` for `<Foo>` ↔ `</Foo>` document
  highlights.
- `mappings` — `CompilerMapping[]`: typed source↔generated spans
  with explicit lengths on both sides and a `kind` tag (`"user"` /
  `"h-call"` / `"punctuation"`). Built by `computeMappings` in
  `src/source-map.ts`. This is the single source of truth for
  position translation; `@efx/language` translates it directly into
  Volar's `Mapping<CodeInformation>[]` without touching `map` or
  `jsxRanges`. See "Source-map mappings" below.

## Why Babel, not tsc/swc

We need a parser that recognizes the angle-bracket source shape
but emits TypeScript with no trace of it left — because tsc's JSX
type-checker collapses generics to `JSX.Element` and erases the
`E`/`R` channel type variables that are the whole point. Babel's
`jsx` plugin (in combination with `typescript`) parses the shape
into a typed AST (`JSXElement`, `JSXFragment`, `JSXExpressionContainer`
node types — these are Babel-internal AST node names, not anything
that survives into our output); our transform rewrites those nodes
to plain `CallExpression`s before `generate()` produces output.
swc was rejected for weaker plugin ergonomics on this kind of
local AST rewrite.

## The three rewrites

Every JSX expression `{...}` triggers up to three local rewrites:

1. **Wrap in `h.track(() => ...)`** — *only if something else got
   rewritten*. See `wrapTracked` + `rewrote` flag in `transform.ts`.
   This is load-bearing: `h.track`'s return is `unknown`, which would
   destroy the typing of static expressions like
   `<Row item={item} />` (where `item` is a generic `T`). Static
   passes through with no wrap.

2. **`x.value` → `h.read(x)`** inside the wrapped expression. Tracks
   AtomRef reads. Skipped when `x.value` is on the LHS of an
   assignment (`x.value = ...` stays bare).

3. **Bare identifier in a test position → `h.peek(id)`**:
   `cond ? A : B` (ConditionalExpression.test),
   `a && b` / `a || b` (LogicalExpression operands),
   `!x` (UnaryExpression argument with `!`).
   `h.peek` is identity for non-AtomRef values; for AtomRefs it
   unwraps + tracks. Lets `{loading ? <X /> : <Y />}` work with
   `loading: AtomRef<boolean>`.

**The test-position rewrite (#3) is leaf-local.** It only fires
when the test is a bare identifier. Composite test expressions —
`x.length > 0`, `items.find(...)`, `a.value === b.value` — are
NOT auto-tracked. They won't react to AtomRef changes unless the
user puts `.value` somewhere in the expression (the `.value`
rewrite #2 fires through composites on the object side, so
`arr[0].value` does work).

Whether the test-position rule should extend to simple shapes
like `x.length` is an open question — predictability and easy
debugging are the current rationale, not a closed decision. If
you change it, update this section.

## Auto-injected imports

If any JSX rewrote to an `h()` call, the transform ensures
`import { h } from "@efx/runtime"` exists. If `<>...</>` was used,
`Fragment` is added too. `ensureRuntimeImports` finds an existing
import from `@efx/runtime` and appends to it; otherwise it prepends
a new declaration. Names already imported under their own identifier
(no alias) are skipped to avoid duplicates.

## Tag dispatch

- Lowercase identifier → string literal (`<div>` → `h("div", ...)`)
- Uppercase identifier → identifier reference (`<Counter>` → `h(Counter, ...)`)
- `JSXMemberExpression` → member expression (`<X.Y>` → `h(X.Y, ...)`)
- `JSXNamespacedName` → string literal with `:` (`<svg:rect>`)
- Fragment (`<>`) → `h(Fragment, {}, ...children)`

## JSX text whitespace

`transformChild` collapses newlines-surrounded whitespace via
`replace(/\s*\n\s*/g, "")`. Pure-whitespace nodes drop. Internal
spaces inside non-newline text are preserved. This matches React's
JSX whitespace rules closely enough for the cases the demo
exercises — diverge with care.

## Babel ESM gotcha

`@babel/traverse` and `@babel/generator` ship CJS-default-export.
In ESM the actual function lives on `.default`. The
`traverse`/`generate` consts at the top of `transform.ts` resolve
this for both module shapes — don't simplify them without testing
under ESM consumption.

## Source location preservation

`copyLoc(target, source)` propagates `loc`/`start`/`end` from JSX
AST nodes onto the emitted `h(...)` call's pieces. Applied at:

- `tagExpression` — the string literal / identifier replacing the
  JSX tag name (`<Counter>` → `Counter` identifier, with its
  source location intact).
- `jsxMemberToMember` — every node in a `<X.Y.Z>` chain.

This is **load-bearing for the TS plugin's go-to-definition**.
Babel's source map otherwise collapses to the start of each JSX
expression, and clicking on `<UserPage userId="42" />` lands you
on the `<` instead of the `UserPage` identifier. The TS plugin's
Volar mappings derive directly from this map.

If you add a new node kind to the emit (e.g., a future
`h.something(...)` call from a new compiler rewrite), wrap its
constructors in `copyLoc` against the source node they replace.

## `jsxRanges` — source-side metadata for tag-pair matching

Alongside `code`, `map`, and `mappings`, the transform emits one
`JsxRange` per `JSXElement` / `JSXFragment` the parser saw, in
source order (pre-order: outer before nested). Each range carries:

- `start` / `end` — the full node span (`<div>...</div>`)
- `openingTag.start` / `.end` — the `<...>` part
- `openingTag.nameStart` / `.nameEnd` — just the tag name span
  (covers dotted names: `<Foo.Bar>` → name is `Foo.Bar`)
- `closingTag` — same shape, omitted when `isSelfClosing`
- Fragments (`kind: "fragment"`) have no name positions; their
  `openingTag` is `<>`, `closingTag` is `</>`

This exists so consumers (today: `@efx/ts-plugin/src/jsx-tags.ts`)
don't have to re-discover JSX structure by regex-scanning the
source. The Babel AST already knows these positions; we report
them. Anti-pattern: anywhere in the workspace running a JSX-shaped
regex against `.efx` content — consume `jsxRanges` instead.

`jsxRanges` is ALSO used internally by `computeMappings` to
classify each source position as `"user"` / `"h-call"` /
`"punctuation"` — but external consumers should reach for
`mappings` (which has the classification baked in) over rebuilding
that classifier from `jsxRanges`.

## Source-map mappings — typed source↔generated spans

`computeMappings(map, source, generated, jsxRanges)` in
`src/source-map.ts` produces the `mappings` array. The algorithm
in five steps:

1. Decode Babel's V3 mappings into `(genOffset, srcOffset, srcChar)`
   segments via `@jridgewell/sourcemap-codec`.
2. Dedupe by source offset (first segment wins) — Babel sometimes
   emits multiple generated points for the same source point.
3. Compute source-side spans by sorting segments by source offset
   and taking consecutive differences.
4. Compute generated-side spans by sorting INDEPENDENTLY by
   generated offset and taking differences. Source and generated
   spans **can differ** because Babel transforms shift byte counts:
   - `(n) =>` → `n =>` (single-arg arrow paren strip): source `((`
     of 2 chars maps to generated `(` of 1 char.
   - `x.value` → `h.read(x)`: source 7 chars → generated 9 chars.
   - `<div>...</div>` → `h("div", ..., ...)`: source 5 chars
     (opening tag) → generated 8+ chars.
5. Classify each mapping's `kind` via `jsxRanges` intersection:
   - JSX angle bracket `<` / `>` / `/` inside an opening or closing
     tag span → `"punctuation"` (no semantic, no navigation —
     cursor on `<` shouldn't jump into `h.ts`).
   - Inside any JSX node range → `"h-call"` (semantic features kept
     but highlight suppressed — cursor on a tag name shouldn't
     highlight every `h` identifier).
   - Otherwise → `"user"` (full features).

The lengths-on-both-sides design is **load-bearing**: a regression
where only source lengths were tracked caused inlay-hint positions
to drift one column to the left (`( : numbern)` instead of
`(n: number)`). See `src/source-map.test.ts` — that test asserts
the exact `(source: 2, generated: 1)` shape for the PR #12 case.

`@efx/language` uses `mappings` directly and never re-decodes the
Babel source map. The bidirectional length asymmetry is captured
once, here, in the compiler.

## Tests

`src/transform.test.ts` — 28 cases via `vitest`. Coverage includes:
each rewrite category, wrap-skip when nothing rewrote, import
injection / dedup, JSX whitespace, tag dispatch shapes, spread
attributes, source maps. Run with `pnpm --filter @efx/compiler test`.

## What this package does NOT do

- No type checking. That's tsc's job (post-transform).
- No reactivity wiring. `h.track`/`read`/`peek` live in
  `@efx/runtime`; the compiler only emits *calls* to them.
- No `CodeInformation` profile assignment. The compiler classifies
  each span as `"user"` / `"h-call"` / `"punctuation"` (a
  Volar-free taxonomy); `@efx/language` translates kind → Volar
  `CodeInformation`. Keeps the compiler Volar-agnostic.
- No file watching, no caching. Pure function of `(source, filename)`.
  Callers cache.

## Anti-patterns

- Don't add a rewrite that fires on composite expressions
  (`x.length`, `arr[0].value`, etc.). The lossy-but-predictable
  "rewrite only bare identifiers / `.value` reads" rule is what
  keeps the system debuggable.
- Don't emit `h.track(...)` unconditionally — generics die.
- Don't auto-import anything except `h` and `Fragment`. Users
  manage their own imports.
- Don't depend on `@babel/preset-*`. We use parser + traverse +
  generate directly to keep the bundle small (the ts-plugin ships
  this transform inside its dist).
