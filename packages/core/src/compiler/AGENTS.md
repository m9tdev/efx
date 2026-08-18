# `@verrex/core/compiler` — `.vx` → plain TypeScript

Single Babel transform. Takes `.vx` source (TypeScript with
angle-bracket `<div>...</div>` syntax — JSX-shape only, no JSX
semantics; see root [AGENTS.md](../../../../AGENTS.md)) and emits plain
TypeScript with every `<...>` expression rewritten as a call:
intrinsic elements become `h(tag, props, ...children)`, component tags
become DIRECT calls (`MyComp({ ...attrs, children: [...] })` — see
"Tag dispatch"). The output contains zero angle brackets — they are
gone before tsc, Vite, or any other downstream tool sees the file.

Entry point: `transformVerrex(source, filename) → { code, map, jsxRanges, mappings }`.

- `code` — compiled TypeScript output.
- `map` — Babel V3 source map. Used by `@verrex/core/vite` for HMR /
  dev-server source maps.
- `jsxRanges` — source-side metadata about each `JSXElement` /
  `JSXFragment` (opening/closing tag positions). Used by
  `@verrex/ts-plugin/src/jsx-tags.ts` for `<Foo>` ↔ `</Foo>` document
  highlights.
- `mappings` — `CompilerMapping[]`: typed source↔generated spans
  with explicit lengths on both sides and a `kind` tag (`"user"` /
  `"h-call"` / `"punctuation"`). Built by `computeMappings` in
  `source-map.ts`. This is the single source of truth for
  position translation; `@verrex/core/language` translates it directly into
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

## The one reactive rewrite: `get(...)` → `h.reader`

(docs/reactivity-migration.md "One dialect"; `wrapReader` / `hasVerrexGet`
in `transform.ts`.) A JSX expression `{…}` — an intrinsic or component
child, or an attribute that is not an `on*` handler — that calls VERREX'S
`get(...)` at its top level is lowered to `h.reader(() => expr)`. That is
`Atom.readable` under the hood with an ambient reader: the expression
re-runs per dep change and the renderer subscribes. NOTHING is injected
into the expression: `get` stays the real imported identifier (auto-imported
like `h`), so hover / go-to-def / rename / highlights are plain tsc — no
source-map games.

```tsx
<span>{get(count) * 2}</span>            → h("span", {}, h.reader(() => get(count) * 2))
<div class={get(open) ? "a" : ""} />     → h("div", { class: h.reader(() => get(open) ? "a" : "") })
<Row item={get(x)} />                    → Row({ item: h.reader(() => get(x)) })
```

Rules, all name/scope-based (no types, no atom analysis):

- **No `get` → untouched.** `{item}`, `{count + 1}` pass through as they
  are, so a static expression keeps its TypeScript type (the reason we
  never wrap unconditionally: generics die).
- **"Verrex's `get`"** = the callee `get` binds to the `@verrex/core` `get`
  import, or is unbound (auto-import case) — `getIsVerrex(scope)`. Bound to
  anything else (an `atom((get) => …)` param — effect-atom's explicit `get`
  simply shadows the import there — a user `const get`, an import from
  elsewhere, a param named `get` inside the expression) → not ours, no wrap.
  An ALIASED verrex import (`import { get as g }`) is not recognised (the
  walk keys on the identifier `get`); documented limitation.
- **Nested JSX is opaque** to the walk (it gets its own reader when the
  traversal reaches it; same import, so nothing changes). Type-only wrappers
  (`as` / `satisfies` / `!`) are walked through.
- **A verrex `get(...)` inside a nested function within the expression is a
  COMPILE ERROR** (`GetInNestedFunctionError`, position included):
  `{items.map((i) => get(i).name)}` would run outside any reader (and throw
  at runtime). Same for handler attributes (`onclick={() => get(x)}`,
  `onclick={get(h)}` — `rejectGetInHandler`), and for spread children /
  spread attributes (`{...get(xs)}`, `{...get(p)}` — no single value to
  wrap): a listener/spread is not a reactive expression. The fix is always
  "move the `get` to the expression level, or into the row's own JSX".
  Optional-call `get?.(a)` counts as `get(a)`.
  **Two policies** (`options.getInNestedFunction`): `"throw"` (default; the
  Vite build path — overlay/failed build) or `"mark"` (the language plugin,
  i.e. editors + `verrex-check`): the call is rewritten to
  `(get as unknown as GetInNestedFunction)(x)` (type exported by
  `@verrex/core`, auto-imported `type`-only) so the TYPE-CHECKER reports
  "not callable" AT the source `get` — a throw there would drop the whole
  file to its last-good compile, invisible in the editor.
- `get` is auto-imported (`state.usedGet`) alongside `h`. `import type { … }`
  declarations and `type` specifiers are ignored when deciding what is
  already imported (a type import satisfies nothing at runtime).

Gone with this (docs/reactivity-migration.md steps 5/6): the `.value` →
`h.read` rewrite, the `h.track` wrap, the whole-body `.value` pass, the
`.value.map → list` sugar and its `isSelfTrackingCall` skip set. `.value`
is now plain member access the compiler never touches.

## Component-name injection

Pass 3 (after the JSX pass) rewrites
`const Counter = Component.make(fn)` → `Component.make(fn, "Counter")`,
injecting the _declared_ name as the span name so users don't repeat the
export name (`matchNamelessComponentMake` + the `VariableDeclarator`
visitor in `transformVerrex`). Deliberately narrow and additive:

- Fires only on the exact callee shape `Component.make` with exactly one
  argument, bound by a plain identifier declarator (`const X = …`,
  exported or not). A second argument already present (an explicit name)
  is left alone.
- Matched by name on the `Component.make` member shape — an aliased import
  (`import { Component as C }`) defeats it, which **fails soft**: the
  component still works, its span is just anonymous. No diagnostic.
- `Component` is NOT auto-imported (it only appears in this rewrite when
  the user already wrote the call, so they already import it).

## Auto-injected imports

If any JSX rewrote to an `h()` call **or** an `h.reader(...)` wrap, the
transform ensures `import { h } from "@verrex/core"` exists (tracked via
`usedH` in `transformVerrex`); `get` is added when a reader was emitted
(`usedGet`). `Fragment` is added when `<>...</>` is used. `ensureRuntimeImports` finds an
existing import from `verrex` and appends to it; otherwise it
prepends a new declaration. Names already imported under their own
identifier (no alias) are skipped to avoid duplicates.

## Tag dispatch

- Lowercase identifier → intrinsic: `<div>` → `h("div", props, ...children)`
- `JSXNamespacedName` → intrinsic: `<svg:rect>` → `h("svg:rect", ...)`
- Uppercase identifier → DIRECT call (`isComponentTag`):
  `<Counter/>` → `Counter()` (zero-arg when no attrs and no children, so
  propless `function* ()` components typecheck);
  `<Foo bar={1}>kid</Foo>` → `Foo({ bar: 1, children: [...] })`
- `JSXMemberExpression` → direct call regardless of case
  (`<X.Y>` → `X.Y({...})` — components by JSX convention)
- Fragment (`<>`) → `Fragment({ children: [...] })` — `Fragment` is itself a
  direct-call component (generic over the children tuple, coerces raw
  children; see runtime AGENTS.md)

The direct-call lowering (#71) is why generic components keep their type
parameter at JSX call sites and why the `Tag*` fold families no longer
exist — a component's channels are just its call's Effect type, folding
into the surrounding `h()` as an ordinary child. Children pass RAW in the
`children` array prop (coercion happens where the component embeds them);
JSX children win over an explicit `children={...}` attr (React semantics
— and a duplicate literal key would be a TS error in the emitted object).
Consequence for imports: `h` is auto-imported per-emission (an intrinsic
element or an `h.reader` wrap) — a component-only
file imports nothing.

## JSX text whitespace

`transformChild` runs JSX text through `cleanJsxText`, a faithful port
of Babel's `cleanJSXElementLiteralChild`: tabs → spaces, leading spaces
trimmed on every line but the first, trailing spaces on every line but
the last, blank lines dropped, surviving lines joined with a single
space. Pure-whitespace nodes drop.

The subtlety that bit us: a newline _between two words_ must collapse to
one space, not to nothing — otherwise multi-line prose renders
`whosepoint`. Whitespace adjacent to an element/expression
boundary still trims to nothing, so — exactly as in React — a tag on its
own line concatenates with neighbouring text unless the source adds an
explicit `{" "}`.

(Watch the JSDoc on `cleanJsxText`: don't write the literal
newline-stripping regex inside a block comment — the `*` `/` it contains
closes the comment early. The function comment spells the rule out in
prose for that reason.)

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

This exists so consumers (today: `@verrex/ts-plugin/src/jsx-tags.ts`)
don't have to re-discover JSX structure by regex-scanning the
source. The Babel AST already knows these positions; we report
them. Anti-pattern: anywhere in the workspace running a JSX-shaped
regex against `.vx` content — consume `jsxRanges` instead.

`jsxRanges` is ALSO used internally by `computeMappings` to
classify each source position as `"user"` / `"h-call"` /
`"punctuation"` — but external consumers should reach for
`mappings` (which has the classification baked in) over rebuilding
that classifier from `jsxRanges`.

## Source-map mappings — typed source↔generated spans

`computeMappings(map, source, generated, jsxRanges)` in
`source-map.ts` produces the `mappings` array. The algorithm
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
   - `{get(x) * 2}` → `h.reader(() => get(x) * 2)`: the reader wrap widens the span (the wrapper text has no source loc; `get` maps onto `get`).
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

The lengths-on-both-sides design is **load-bearing**: tracking only
source lengths makes inlay-hint positions drift one column left
(`( : numbern)` instead of `(n: number)`). `source-map.test.ts` pins
the exact `(source: 2, generated: 1)` shape.

`@verrex/core/language` uses `mappings` directly and never re-decodes the
Babel source map. The bidirectional length asymmetry is captured
once, here, in the compiler.

## Tests

`transform.test.ts` via `vitest`. Coverage includes: JSX → `h()`, the
`get(...)` reader sugar (wrap / no-wrap / shadowing / nested JSX /
nested-function error / handler error), import injection / dedup, JSX
whitespace, tag dispatch shapes, spread attributes, source maps. Run with `pnpm --filter @verrex/core test`.

## What this package does NOT do

- No type checking. That's tsc's job (post-transform).
- No reactivity wiring. `h.reader` lives in `@verrex/core`; the compiler
  only emits _calls_ to it.
- No `CodeInformation` profile assignment. The compiler classifies
  each span as `"user"` / `"h-call"` / `"punctuation"` (a
  Volar-free taxonomy); `@verrex/core/language` translates kind → Volar
  `CodeInformation`. Keeps the compiler Volar-agnostic.
- No file watching, no caching. Pure function of `(source, filename)`.
  Callers cache.

## Parse-error tolerance

`@babel/parser` runs with `errorRecovery: true`. The editor calls
`transformVerrex` on every keystroke; mid-edit source is routinely
unparseable (`count.` with no property name yet). Without recovery,
Babel throws → `createVirtualCode` propagates → Volar has no virtual
code for the file → tsserver returns the project's _global scope_
(999 entries — every DOM ambient declaration) for completion
requests instead of the member list the user expects.

With recovery, Babel emits a partial AST for _recoverable_ errors and
attaches them to `ast.errors`. We don't read that array — downstream
`tsc` will surface real errors as diagnostics. But recovery is **not a
no-throw guarantee**: Babel still hard-throws on fatal states, including
the most common mid-edit ones — `count.` at EOF, an unterminated tag
("Unexpected token"), `<div>{x.}</div>`. Recovery only helps when a
following token exists to recover _into_ (`x.` followed by `return` parses
as `x.return`). Callers that must survive the hard-throws wrap this call:
the language plugin degrades to the file's last good compile
(`onTransformError: "recover"`, #102). The build path passes
`errorRecovery: false` so a genuine syntax error throws loudly instead of
shipping a recovered/garbage module.

## Anti-patterns

- Don't add a rewrite that fires on shapes other than a free
  `get(...)` call. The name-based rule is what keeps the system
  debuggable — no types, no atom analysis.
- Don't emit `h.reader(...)` unconditionally — generics die.
- Don't auto-import anything except `h`, `get` and `Fragment`.
  Users manage their own imports.
- Don't depend on `@babel/preset-*`. We use parser + traverse +
  generate directly to keep the bundle small (the ts-plugin ships
  this transform inside its dist).
- Don't remove `errorRecovery: true` from the parser options. See
  "Parse-error tolerance" above — completions silently regress to
  the project global scope without it.
