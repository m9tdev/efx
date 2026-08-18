import { parse, type ParserOptions } from "@babel/parser"
import _traverse, { type NodePath, type Scope } from "@babel/traverse"
import * as t from "@babel/types"
import _generate from "@babel/generator"
import { computeMappings, type CompilerMapping } from "./source-map.ts"

// Babel's traverse/generate ship as CJS-default-export; in ESM contexts that
// surfaces as the actual function on `.default`.
const traverse: typeof _traverse =
  (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse
const generate: typeof _generate =
  (_generate as unknown as { default: typeof _generate }).default ?? _generate

export interface TransformOptions {
  /**
   * Whether Babel recovers from parse errors (emitting a partial AST) instead
   * of throwing. Defaults to `true` for the editor/language-service path,
   * which transforms routinely-unparseable mid-edit source. The build path
   * (`verrex/vite`) passes `false` so a real syntax error fails loudly —
   * a Vite error overlay in dev, a failed build in CI — rather than silently
   * shipping a recovered module.
   */
  readonly errorRecovery?: boolean
  /**
   * What to do with a verrex `get(...)` inside a nested function or event
   * handler (never reactive there). `"throw"` (default; the build path)
   * raises `GetInNestedFunctionError`. `"report"` (the language-service path)
   * keeps compiling — the call is left as written — and lists it in
   * `TransformResult.diagnostics`, so an editor or `verrex-check` shows the
   * error at its position instead of the whole file silently falling back
   * to its last good compile.
   */
  readonly getInNestedFunction?: "throw" | "report"
}

/** A compiler diagnostic, in SOURCE offsets (`[start, end)`). */
export interface TransformDiagnostic {
  readonly message: string
  readonly start: number
  readonly end: number
}

export interface TransformResult {
  readonly code: string
  readonly map: object | null
  readonly jsxRanges: ReadonlyArray<JsxRange>
  /**
   * Typed source↔generated mappings with explicit lengths on both sides and a
   * kind classification for each span. Computed from `map` + `jsxRanges`;
   * consumers should prefer this over re-processing the Babel source map.
   *
   * See `CompilerMapping` for the shape and `computeMappings` for the
   * algorithm.
   */
  readonly mappings: ReadonlyArray<CompilerMapping>
  /** Non-fatal errors found in `"report"` mode (empty in `"throw"` mode — those throw). */
  readonly diagnostics: ReadonlyArray<TransformDiagnostic>
}

/** Source-side span. All offsets are 0-based byte indices into the original `.vx` source. */
export interface TagPosition {
  readonly start: number
  readonly end: number
}

/** Tag span carrying the name sub-range — `<Foo`'s "Foo" lives at `nameStart..nameEnd`. */
export interface NamedTagPosition extends TagPosition {
  readonly nameStart: number
  readonly nameEnd: number
}

/** A `<Tag>...</Tag>` (or `<Tag />`) range. `closingTag` is `undefined` when `isSelfClosing`. */
export interface JsxElementRange {
  readonly kind: "element"
  readonly start: number
  readonly end: number
  readonly isSelfClosing: boolean
  readonly openingTag: NamedTagPosition
  readonly closingTag?: NamedTagPosition
}

/** A `<>...</>` fragment range. Tags have no name positions. */
export interface JsxFragmentRange {
  readonly kind: "fragment"
  readonly start: number
  readonly end: number
  readonly openingTag: TagPosition
  readonly closingTag: TagPosition
}

/**
 * Source-side metadata about a JSX node the compiler rewrote into an `h()` call.
 * Emitted in pre-order: outermost node first, then nested children in source order.
 *
 * Consumed by `@verrex/ts-plugin` to identify "inside-h()" positions, JSX punctuation,
 * and tag-pair partners without re-parsing the source or scanning the compiled
 * output with regex. The producer (Babel AST) has the exact positions; we report
 * them so consumers don't have to recover them.
 */
export type JsxRange = JsxElementRange | JsxFragmentRange

const PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: ["typescript", "jsx"],
}

/**
 * An `on*` attribute (length > 2, mirroring the runtime's `isHandlerKey` gate
 * in coerce.ts): a handler slot, never reader-wrapped.
 */
const isHandlerAttr = (key: t.Identifier | t.StringLiteral): boolean => {
  const name = t.isIdentifier(key) ? key.name : key.value
  return name.length > 2 && name.startsWith("on")
}

/**
 * Convert a JSX attribute name to an object-property key.
 * JSX allows `data-foo` and `aria-bar` — wrap those in string literals.
 */
const attrName = (
  id: t.JSXIdentifier | t.JSXNamespacedName,
): t.Identifier | t.StringLiteral => {
  if (t.isJSXNamespacedName(id)) {
    return t.stringLiteral(`${id.namespace.name}:${id.name.name}`)
  }
  return /^[A-Za-z_$][\w$]*$/.test(id.name)
    ? t.identifier(id.name)
    : t.stringLiteral(id.name)
}

/**
 * Per-call mutable state, threaded through every helper that may emit a
 * runtime call. `transformVerrex` creates a fresh instance and reads the
 * flags at the end to decide which runtime imports to auto-inject. `usedH`
 * is per-emission (an intrinsic `h(...)` or an `h.reader` wrap) — a file
 * whose JSX is all component tags emits direct calls and needs no `h` at all.
 */
interface RewriteState {
  readonly getInNestedFunction: "throw" | "report"
  readonly diagnostics: Array<TransformDiagnostic>
  usedH: boolean
  usedGet: boolean
  usedFragment: boolean
}

/**
 * The `get(...)` reactive expression (docs/reactivity-migration.md "One
 * dialect").
 *
 * A JSX expression — an intrinsic/component child, or an attribute that is
 * not an `on*` handler — that calls VERREX'S `get(...)` at its top level is
 * lowered to `h.reader(() => expr)`: `Atom.readable` under the hood with an
 * ambient reader, so `{get(count) * 2}` / `class={get(open) ? "a" : ""}`
 * re-run per dep change with one word (`get`) shared with atom bodies. No
 * `get` → the expression passes through untouched (static; its TypeScript
 * type survives, purely syntactically). NOTHING is injected into the
 * expression itself — `get` stays the real imported identifier (auto-
 * imported like `h`), so hover / go-to-def / rename are plain tsc.
 *
 * "Verrex's `get`" = the callee binds to the `@verrex/core` `get` import
 * (by IMPORTED name — an alias resolves), or is UNBOUND (the auto-import
 * case). A `get` bound to anything else — an `atom((get) => …)` param, a user
 * `const get`, a param named `get` inside the expression — is not ours: no
 * wrap. Nested JSX elements/fragments inside the expression are opaque to
 * this walk (they get their own reader when the traversal reaches them; a
 * nested reader's `get` is the same import, so nothing changes for it). A
 * verrex `get(...)` INSIDE a nested function within the expression
 * (`{items.map((i) => get(i).name)}`, `onclick={() => get(x)}`) is a
 * COMPILE ERROR — it would run outside any reader (and throw at runtime);
 * the fix is to move the `get` to the reader level or into the row's own
 * JSX. Type-only wrappers (`as` / `satisfies` / `!`) are transparent.
 */
const wrapReader = (
  expr: t.Expression,
  scope: Scope,
  state: RewriteState,
): t.Expression => {
  if (!hasVerrexGet(expr, scope, state)) return expr
  state.usedH = true
  state.usedGet = true
  return t.callExpression(
    t.memberExpression(t.identifier("h"), t.identifier("reader")),
    [t.arrowFunctionExpression([], expr)],
  )
}

/**
 * A handler attribute is a listener, not a reactive expression: a verrex
 * `get(...)` anywhere in it (`onclick={() => get(x)}`, `onclick={get(h)}`)
 * would never be tracked, so it is the same compile error as a nested
 * function. Returns the expression untouched otherwise.
 */
const rejectGetInHandler = (
  expr: t.Expression,
  scope: Scope,
  state: RewriteState,
): t.Expression => {
  if (hasVerrexGet(expr, scope, state)) onNestedGet(expr, state)
  return expr
}

/**
 * A verrex `get(...)` where it can't be reactive: throw (build), or report
 * it at its source position (editor/check) and leave the call as written.
 */
const onNestedGet = (node: t.Node, state: RewriteState): void => {
  if (state.getInNestedFunction === "throw")
    throw new GetInNestedFunctionError(node)
  // Import `get` anyway: the ONE useful error is ours, not TS2304.
  state.usedGet = true
  const message = GetInNestedFunctionError.describe(node)
  state.diagnostics.push({
    message,
    start: node.start ?? 0,
    end: node.end ?? node.start ?? 0,
  })
}

class GetInNestedFunctionError extends Error {
  /** The message without a position (a diagnostic carries its own range). */
  static describe(_node: t.Node): string {
    return (
      "get(...) inside a nested function or event handler is not reactive — it would run " +
      "outside the reader. Move the get(...) to the JSX expression level, or into the " +
      "nested JSX it renders."
    )
  }
  constructor(node: t.Node) {
    const loc = node.loc?.start
    super(
      `${GetInNestedFunctionError.describe(node)} ` +
        `(${loc ? `${loc.line}:${loc.column + 1}` : "unknown position"})`,
    )
    this.name = "GetInNestedFunctionError"
  }
}

/** Is `get` at this scope verrex's (`@verrex/core` import or unbound)? */
const getIsVerrex = (scope: Scope): boolean => {
  const binding = scope.getBinding("get")
  if (!binding) return true
  const path = binding.path
  if (!path.isImportSpecifier()) return false
  const decl = path.parentPath
  if (!decl.isImportDeclaration() || decl.node.source.value !== RUNTIME_PKG)
    return false
  const imported = path.node.imported
  return (t.isIdentifier(imported) ? imported.name : imported.value) === "get"
}

/**
 * Walk `expr` for verrex `get(...)` calls. True when at least one sits at
 * the expression's top level (→ wrap); throws `GetInNestedFunctionError` on
 * one inside a nested function. Shadowing introduced INSIDE the expression
 * (a nested function's `get` param, a `const get` in a block) is tracked;
 * shadowing from the enclosing scope is `getIsVerrex(scope)`.
 */
const hasVerrexGet = (
  expr: t.Expression,
  scope: Scope,
  state: RewriteState,
): boolean => {
  if (!getIsVerrex(scope)) return false
  let top = false
  const walk = (
    node: t.Node | null | undefined,
    depth: number,
    shadowed: boolean,
  ): void => {
    if (node == null || shadowed) return
    // Nested JSX gets its own reader later — opaque here.
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return
    if (
      (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
      t.isIdentifier(node.callee, { name: "get" })
    ) {
      if (depth > 0) {
        onNestedGet(node, state)
        return
      }
      top = true
      // Still walk the arguments (`get(get(a))` — inner is also top-level).
    }
    if (t.isFunction(node)) {
      const shadows = node.params.some((p) => bindsName(p, "get"))
      walk(node.body, depth + 1, shadows)
      return
    }
    // Generic child walk over Babel's VISITOR_KEYS.
    const keys = t.VISITOR_KEYS[node.type] ?? []
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const c of child) walk(c as t.Node, depth, shadowed)
      } else if (child && typeof (child as t.Node).type === "string") {
        walk(child as t.Node, depth, shadowed)
      }
    }
  }
  walk(expr, 0, false)
  return top
}

/** Does a function parameter pattern bind `name`? (identifier, default, rest, destructuring) */
const bindsName = (p: t.Node, name: string): boolean => {
  if (t.isIdentifier(p)) return p.name === name
  if (t.isAssignmentPattern(p)) return bindsName(p.left, name)
  if (t.isRestElement(p)) return bindsName(p.argument, name)
  if (t.isArrayPattern(p))
    return p.elements.some((e) => e != null && bindsName(e, name))
  if (t.isObjectPattern(p))
    return p.properties.some((pr) =>
      t.isRestElement(pr)
        ? bindsName(pr.argument, name)
        : bindsName(pr.value, name),
    )
  return false
}

/**
 * Match `Component.make(fn)` — one argument, member callee `Component.make`
 * — so the name-injection pass can append the declared name. Anything else
 * (already-named, aliased import, computed access) is left alone.
 */
const matchNamelessComponentMake = (node: t.Node): t.CallExpression | null =>
  t.isCallExpression(node) &&
  node.arguments.length === 1 &&
  t.isMemberExpression(node.callee) &&
  !node.callee.computed &&
  t.isIdentifier(node.callee.object, { name: "Component" }) &&
  t.isIdentifier(node.callee.property, { name: "make" })
    ? node
    : null

/** Build the props object from JSX attributes. */
const buildProps = (
  attrs: ReadonlyArray<t.JSXAttribute | t.JSXSpreadAttribute>,
  scope: Scope,
  state: RewriteState,
): t.Expression => {
  const properties: Array<t.ObjectProperty | t.SpreadElement> = []
  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) {
      // A spread is not a reactive expression (there is no single value to
      // wrap): a verrex `get` in it is the nested-function error.
      properties.push(
        t.spreadElement(rejectGetInHandler(attr.argument, scope, state)),
      )
      continue
    }
    const key = attrName(attr.name)
    let value: t.Expression
    if (attr.value == null) {
      value = t.booleanLiteral(true)
    } else if (t.isStringLiteral(attr.value)) {
      value = attr.value
    } else if (t.isJSXExpressionContainer(attr.value)) {
      value = t.isJSXEmptyExpression(attr.value.expression)
        ? t.booleanLiteral(true)
        : // Handler props are functions; a `get` inside one is the nested-
          // function error, but a bare `onclick={handler}` must never be
          // wrapped — it isn't reactive, it's a listener.
          isHandlerAttr(key)
          ? rejectGetInHandler(attr.value.expression, scope, state)
          : wrapReader(attr.value.expression, scope, state)
    } else {
      // JSXElement/JSXFragment values are exotic — fall back to recursive transform
      value = transformJsxNode(
        attr.value as t.JSXElement | t.JSXFragment,
        scope,
        state,
      )
    }
    properties.push(
      t.objectProperty(
        key,
        value,
        t.isStringLiteral(key) /* computed when string-keyed */,
      ),
    )
  }
  return t.objectExpression(properties)
}

/** Copy source location from one node to another for source map accuracy. */
const copyLoc = <T extends t.Node>(target: T, source: t.Node): T => {
  if (source.loc) {
    target.loc = source.loc
  }
  const srcStart = (source as { start?: number | null }).start
  const srcEnd = (source as { end?: number | null }).end
  if (typeof srcStart === "number") {
    ;(target as { start?: number | null }).start = srcStart
  }
  if (typeof srcEnd === "number") {
    ;(target as { end?: number | null }).end = srcEnd
  }
  return target
}

/**
 * The single source of truth for the tag-dispatch rule: a lowercase first
 * letter means intrinsic element. Used by `tagExpression` (string literal vs
 * identifier) and `isComponentTag` (h() vs direct call) — keep it one
 * predicate so the two can't drift.
 */
const isIntrinsicName = (name: string): boolean => /^[a-z]/.test(name)

/** Decide the tag expression: lowercase → string literal, otherwise identifier. */
const tagExpression = (
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): t.Expression => {
  if (t.isJSXNamespacedName(name)) {
    const lit = t.stringLiteral(`${name.namespace.name}:${name.name.name}`)
    return copyLoc(lit, name)
  }
  if (t.isJSXMemberExpression(name)) {
    return jsxMemberToMember(name)
  }
  // JSXIdentifier - preserve location for go-to-definition
  const lower = isIntrinsicName(name.name)
  const expr = lower ? t.stringLiteral(name.name) : t.identifier(name.name)
  return copyLoc(expr, name)
}

const jsxMemberToMember = (m: t.JSXMemberExpression): t.MemberExpression => {
  const object = t.isJSXMemberExpression(m.object)
    ? jsxMemberToMember(m.object)
    : copyLoc(t.identifier(m.object.name), m.object)
  const property = copyLoc(t.identifier(m.property.name), m.property)
  return copyLoc(t.memberExpression(object, property), m)
}

/**
 * Collapse JSX text whitespace per the JSX spec — a faithful port of Babel's
 * `cleanJSXElementLiteralChild`. Tabs become spaces; leading spaces are trimmed
 * on every line but the first, trailing spaces on every line but the last;
 * blank lines drop; surviving lines join with a single space.
 *
 * The load-bearing difference from the old newline-stripping regex: a newline
 * between two words collapses to one space, not to nothing — so multi-line prose
 * reads "whose point" instead of "whosepoint". Whitespace adjacent to an
 * element/expression boundary still trims to nothing, so (exactly as in React)
 * a tag on its own line concatenates unless the source adds an explicit space.
 */
const cleanJsxText = (value: string): string => {
  const lines = value.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i]!)) lastNonEmpty = i
  }
  let out = ""
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, " ")
    if (i !== 0) line = line.replace(/^ +/, "")
    if (i !== lines.length - 1) line = line.replace(/ +$/, "")
    if (line === "") continue
    out += i !== lastNonEmpty ? line + " " : line
  }
  return out
}

/** Transform a single JSX child node into an expression. */
const transformChild = (
  child: t.JSXElement["children"][number],
  scope: Scope,
  state: RewriteState,
): t.Expression | t.SpreadElement | null => {
  if (t.isJSXText(child)) {
    const text = cleanJsxText(child.value)
    if (text === "") return null
    return t.stringLiteral(text)
  }
  if (t.isJSXExpressionContainer(child)) {
    return t.isJSXEmptyExpression(child.expression)
      ? null
      : wrapReader(child.expression, scope, state)
  }
  if (t.isJSXSpreadChild(child)) {
    // `{...items}` expands as individual children (JSX semantics): emit a
    // real SpreadElement — valid both as an `h(...)` call argument and as a
    // `children: [...]` array element. A bare passthrough would land the
    // whole array as ONE child and pick up a redundant Fragment wrapper
    // from coerceAsync's array peel.
    // Not a reactive expression either (see the spread attribute above).
    return copyLoc(
      t.spreadElement(rejectGetInHandler(child.expression, scope, state)),
      child,
    )
  }
  return transformJsxNode(child, scope, state)
}

const RUNTIME_PKG = "@verrex/core"

const ensureRuntimeImports = (
  program: t.Program,
  wanted: Set<string>,
): void => {
  // First pass: find an existing import from the runtime; drop names that
  // are already imported under their own identifier (no `as` alias).
  let existing: t.ImportDeclaration | undefined
  for (const node of program.body) {
    if (!t.isImportDeclaration(node)) continue
    if (node.source.value !== RUNTIME_PKG) continue
    // A type-only declaration (`import type { h }`) satisfies nothing at
    // runtime and can't take value specifiers — skip it entirely.
    if (node.importKind === "type") continue
    existing = node
    for (const spec of node.specifiers) {
      if (
        t.isImportSpecifier(spec) &&
        spec.importKind !== "type" &&
        t.isIdentifier(spec.imported) &&
        spec.imported.name === spec.local.name
      ) {
        wanted.delete(spec.local.name)
      }
    }
    break
  }

  if (wanted.size === 0) return

  const newSpecs = [...wanted].map((name) =>
    t.importSpecifier(t.identifier(name), t.identifier(name)),
  )

  if (existing) {
    existing.specifiers.push(...newSpecs)
  } else {
    program.body.unshift(
      t.importDeclaration(newSpecs, t.stringLiteral(RUNTIME_PKG)),
    )
  }
}

/**
 * Build a JsxRange from a Babel AST node. Reads `start`/`end` from the parser —
 * always set when the AST came from `@babel/parser` with positions enabled.
 */
const collectJsxRange = (node: t.JSXElement | t.JSXFragment): JsxRange => {
  if (t.isJSXFragment(node)) {
    return {
      kind: "fragment",
      start: node.start!,
      end: node.end!,
      openingTag: {
        start: node.openingFragment.start!,
        end: node.openingFragment.end!,
      },
      closingTag: {
        start: node.closingFragment.start!,
        end: node.closingFragment.end!,
      },
    }
  }
  const opening = node.openingElement
  const closing = node.closingElement
  const base: JsxElementRange = {
    kind: "element",
    start: node.start!,
    end: node.end!,
    isSelfClosing: opening.selfClosing,
    openingTag: {
      start: opening.start!,
      end: opening.end!,
      nameStart: opening.name.start!,
      nameEnd: opening.name.end!,
    },
  }
  if (!closing) return base
  return {
    ...base,
    closingTag: {
      start: closing.start!,
      end: closing.end!,
      nameStart: closing.name.start!,
      nameEnd: closing.name.end!,
    },
  }
}

/**
 * True when the JSX tag names a component (the compiler lowers it to a
 * direct call) rather than an intrinsic element (routed through `h`).
 * Components are capitalized identifiers (`<MyComp/>` — same first-letter
 * rule `tagExpression` uses) and member expressions (`<X.Y/>` — components
 * by JSX convention regardless of case). Namespaced names (`<svg:rect/>`)
 * are intrinsic.
 */
const isComponentTag = (
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): boolean =>
  t.isJSXMemberExpression(name) ||
  (t.isJSXIdentifier(name) && !isIntrinsicName(name.name))

/**
 * Transform a JSX element or fragment node into its compiled call:
 *
 *  - intrinsic element → `h("tag", props, ...children)` (unchanged)
 *  - component tag     → direct call: `MyComp({ ...attrs, children: [...] })`,
 *    `MyComp({ ...attrs })`, or `MyComp()` when there are no attrs and no
 *    children (so zero-param components stay callable)
 *  - fragment          → `Fragment({ children: [...] })` (Fragment is itself
 *    a component since #71; it coerces the raw children)
 *
 * Direct calls are what let a generic component's type parameter infer at
 * the call site, and what makes the component's channels fold as an
 * ordinary Effect child of the surrounding `h()` — no `Tag*` fold types.
 * JSX children always win over an explicit `children={...}` attr (React
 * semantics; a duplicate key would also be a TS error in the emitted
 * object literal).
 */
const transformJsxNode = (
  node: t.JSXElement | t.JSXFragment,
  scope: Scope,
  state: RewriteState,
): t.CallExpression => {
  const childArgs: Array<t.Expression | t.SpreadElement> = []
  for (const child of node.children) {
    const transformed = transformChild(child, scope, state)
    if (transformed) childArgs.push(transformed)
  }

  const isFragment = t.isJSXFragment(node)
  if (isFragment || isComponentTag(node.openingElement.name)) {
    const callee: t.Expression = isFragment
      ? copyLoc(t.identifier("Fragment"), node)
      : tagExpression(node.openingElement.name)
    if (isFragment) state.usedFragment = true

    const props = isFragment
      ? t.objectExpression([])
      : (buildProps(
          node.openingElement.attributes,
          scope,
          state,
        ) as t.ObjectExpression)
    if (childArgs.length > 0) {
      props.properties = props.properties.filter(
        (p) =>
          !(
            t.isObjectProperty(p) &&
            (t.isIdentifier(p.key, { name: "children" }) ||
              t.isStringLiteral(p.key, { value: "children" }))
          ),
      )
      props.properties.push(
        t.objectProperty(
          t.identifier("children"),
          t.arrayExpression(childArgs),
        ),
      )
    }
    // No attrs, no children → zero-arg call, so propless `function* ()`
    // components typecheck. Fragment always takes its (required) props arg.
    const args = !isFragment && props.properties.length === 0 ? [] : [props]
    return copyLoc(t.callExpression(callee, args), node)
  }

  state.usedH = true
  const tag = tagExpression(node.openingElement.name)
  const props = buildProps(node.openingElement.attributes, scope, state)
  // Preserve location on the h() call for source map accuracy
  const hCall = t.callExpression(t.identifier("h"), [tag, props, ...childArgs])
  return copyLoc(hCall, node)
}

/**
 * Compile `.vx` source (TypeScript + JSX-shape syntax) into plain
 * TypeScript with every JSX node rewritten as an `h()` call.
 *
 * The output is what `tsc` and Vite see — neither ever encounters JSX.
 * TypeScript's JSX type-checker is therefore never engaged; channel
 * propagation comes from `h()`'s generic signature alone.
 */
export const transformVerrex = (
  source: string,
  filename: string,
  options: TransformOptions = {},
): TransformResult => {
  const ast = parse(source, {
    ...PARSER_OPTIONS,
    // The editor/language-service path (default) wants error recovery: it
    // calls this on every keystroke over routinely-unparseable mid-edit
    // source. With recovery Babel emits a partial AST for RECOVERABLE errors
    // and attaches them to `ast.errors` (which we don't read — tsc surfaces
    // the real errors). But recovery is not a no-throw guarantee: Babel still
    // hard-throws on fatal states, including the most common mid-edit ones
    // (`count.` at EOF, an unterminated tag → "Unexpected token"). Callers
    // that must survive those wrap this call — the language plugin degrades
    // to the file's last good compile (`onTransformError: "recover"`). The
    // build path passes `false` so a genuine syntax error throws loudly here
    // instead of silently emitting a recovered/garbage module that the
    // bundler would then ship.
    errorRecovery: options.errorRecovery ?? true,
    sourceFilename: filename,
  })

  // Pre-pass: collect a JsxRange for every JSXElement/JSXFragment in source order.
  // The rewrite pass below uses path.replaceWith, which only visits outermost JSX
  // (nested children get rewritten recursively inside transformJsxNode and are no
  // longer JSX nodes by the time Babel would visit them). Collecting separately
  // beforehand is the cleanest way to see every node.
  const jsxRanges: JsxRange[] = []
  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      jsxRanges.push(collectJsxRange(path.node))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      jsxRanges.push(collectJsxRange(path.node))
    },
  })

  const state: RewriteState = {
    getInNestedFunction: options.getInNestedFunction ?? "throw",
    diagnostics: [],
    usedH: false,
    usedGet: false,
    usedFragment: false,
  }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      path.replaceWith(transformJsxNode(path.node, path.scope, state))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      path.replaceWith(transformJsxNode(path.node, path.scope, state))
    },
  })

  // Pass 3 — Component-name injection: `const Counter = Component.make(fn)`
  // gains the declared name as a second argument — `Component.make(fn,
  // "Counter")` — so the span is named without the user repeating the export
  // name. Purely additive, single call-site shape (see
  // `matchNamelessComponentMake`); anything that doesn't match fails soft (no
  // named span). Runs on the LIVE AST after the JSX pass.
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id) || path.node.init == null) return
      const call = matchNamelessComponentMake(path.node.init)
      if (call) call.arguments.push(t.stringLiteral(path.node.id.name))
    },
  })

  // Auto-inject the runtime imports the rewritten code now depends on.
  // Looks for an existing `import … from "@verrex/core"` and adds the
  // missing names there; otherwise prepends a new import. Keeps the user's
  // imports untouched and avoids duplicate specifiers. `h` is needed if the
  // JSX pass emitted `h(...)` or an `h.reader(...)` wrap.
  const wanted = new Set<string>()
  if (state.usedH) wanted.add("h")
  if (state.usedGet) wanted.add("get")
  if (state.usedFragment) wanted.add("Fragment")
  if (wanted.size > 0) ensureRuntimeImports(ast.program, wanted)

  const result = generate(
    ast,
    {
      sourceMaps: true,
      sourceFileName: filename,
      retainLines: false,
      jsescOption: { minimal: true },
    },
    source,
  )

  const map = (result.map as object | null) ?? null
  const mappings = computeMappings(map, source, result.code, jsxRanges)

  return {
    code: result.code,
    map,
    jsxRanges,
    mappings,
    diagnostics: state.diagnostics,
  }
}
