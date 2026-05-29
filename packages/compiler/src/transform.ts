import { parse, type ParserOptions } from "@babel/parser"
import _traverse, { type NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import _generate from "@babel/generator"
import { computeMappings, type CompilerMapping } from "./source-map.ts"

// Babel's traverse/generate ship as CJS-default-export; in ESM contexts that
// surfaces as the actual function on `.default`.
const traverse: typeof _traverse =
  (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse
const generate: typeof _generate =
  (_generate as unknown as { default: typeof _generate }).default ?? _generate

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
}

/** Source-side span. All offsets are 0-based byte indices into the original `.efx` source. */
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
 * Consumed by `@efx/ts-plugin` to identify "inside-h()" positions, JSX punctuation,
 * and tag-pair partners without re-parsing the source or scanning the compiled
 * output with regex. The producer (Babel AST) has the exact positions; we report
 * them so consumers don't have to recover them.
 */
export type JsxRange = JsxElementRange | JsxFragmentRange

const PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: ["typescript", "jsx"],
  // Editor calls this on every keystroke; mid-edit source is routinely
  // unparseable (`count.` with no property name yet). Without recovery,
  // Babel throws → createVirtualCode propagates the throw → Volar has no
  // virtual code for the file → tsserver returns the project's global scope
  // for completion requests instead of the expected member list. With
  // recovery, Babel emits a partial AST and attaches errors to `ast.errors`
  // (which we don't read — downstream tsc surfaces real errors).
  errorRecovery: true,
}

/**
 * Convert a JSX attribute name to an object-property key.
 * JSX allows `data-foo` and `aria-bar` — wrap those in string literals.
 */
const attrName = (id: t.JSXIdentifier | t.JSXNamespacedName): t.Identifier | t.StringLiteral => {
  if (t.isJSXNamespacedName(id)) {
    return t.stringLiteral(`${id.namespace.name}:${id.name.name}`)
  }
  return /^[A-Za-z_$][\w$]*$/.test(id.name)
    ? t.identifier(id.name)
    : t.stringLiteral(id.name)
}

/**
 * Per-call mutable state, threaded through every helper that may emit a
 * `list(...)` call. `transformEfx` creates a fresh instance and reads
 * `wroteList` at the end to decide whether to auto-import `list`.
 */
interface RewriteState {
  wroteList: boolean
}

/**
 * Wrap a JSX-expression's value in a `h.track(() => expr)` call **only when
 * a `.value` read was found**. Static expressions like `{item}` or `{"hello"}`
 * pass through unchanged so their TypeScript type is preserved — h.track's
 * return is `unknown`, which would otherwise destroy the typing of component
 * props (`<Row item={item} />`, the prop's `item` type).
 *
 * The `.value.map(arrow → JSX)` rewrite does **not** trigger a wrap: the
 * resulting `list(...)` call subscribes inside `mount`, so wrapping in
 * `h.track` would add a redundant reactive layer. It flips `state.wroteList`
 * instead, which `transformEfx` reads to decide on the `list` auto-import.
 */
const wrapTracked = (expr: t.Expression, state: RewriteState): t.Expression => {
  const { expr: rewritten, rewroteRead } = rewriteTrackedExpression(expr, state)
  if (!rewroteRead) return rewritten
  return t.callExpression(
    t.memberExpression(t.identifier("h"), t.identifier("track")),
    [t.arrowFunctionExpression([], rewritten)],
  )
}

const hRead = (): t.MemberExpression =>
  t.memberExpression(t.identifier("h"), t.identifier("read"))

/**
 * True when an arrow body is a JSX expression — either directly
 * (`item => <Row/>`) or via a block whose only statement is `return <JSX/>`
 * (`item => { return <Row/> }`).
 */
const isJsxArrowBody = (body: t.BlockStatement | t.Expression): boolean => {
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return true
  if (t.isBlockStatement(body) && body.body.length === 1) {
    const stmt = body.body[0]
    if (t.isReturnStatement(stmt) && stmt.argument) {
      return t.isJSXElement(stmt.argument) || t.isJSXFragment(stmt.argument)
    }
  }
  return false
}

/**
 * Match `<expr>.value.map(<arrow>)` exactly. The arrow's JSX-ness is checked
 * separately by `isJsxArrowBody` — this just confirms the call shape.
 */
const matchValueMapCall = (
  node: t.CallExpression,
): { source: t.Expression; arrow: t.ArrowFunctionExpression } | null => {
  if (!t.isMemberExpression(node.callee) || node.callee.computed) return null
  if (!t.isIdentifier(node.callee.property, { name: "map" })) return null
  const valueAccess = node.callee.object
  if (!t.isMemberExpression(valueAccess) || valueAccess.computed) return null
  if (!t.isIdentifier(valueAccess.property, { name: "value" })) return null
  if (node.arguments.length !== 1) return null
  const arg = node.arguments[0]
  if (!t.isArrowFunctionExpression(arg)) return null
  if (!isJsxArrowBody(arg.body)) return null
  if (t.isSuper(valueAccess.object)) return null
  return { source: valueAccess.object, arrow: arg }
}

/**
 * In-place AST rewrites inside a tracked JSX expression:
 *
 *   - `<expr>.value.map(arrow → JSX)` → `list(<expr>, arrow)` — keyed
 *     reactive iteration. Caught before the bare `.value` rewrite so the
 *     `.value` doesn't get turned into an `h.read` we'd then have to undo.
 *     Flips `state.wroteList` so `transformEfx` adds the import, then
 *     `path.skip()`s the new list's children: any `.value` reads inside the
 *     arrow body belong to inner JSX expressions and will get their own
 *     `h.track` wrap when the outer JSX traversal reaches them. Descending
 *     here would (a) wrap this `list(...)` in a redundant `h.track`, and
 *     (b) strand the inner `h.read` calls outside any active tracking scope.
 *   - `x.value` (read) → `h.read(x)` — tracks AtomRef reads via `.value`.
 *     Sets local `rewroteRead`, which triggers the surrounding `h.track`
 *     wrap in `wrapTracked`.
 */
const rewriteTrackedExpression = (
  expr: t.Expression,
  state: RewriteState,
): { expr: t.Expression; rewroteRead: boolean } => {
  const file = t.file(t.program([t.expressionStatement(expr)]))
  let rewroteRead = false
  traverse(file, {
    CallExpression(path) {
      const matched = matchValueMapCall(path.node)
      if (!matched) return
      const newCall = t.callExpression(t.identifier("list"), [matched.source, matched.arrow])
      path.replaceWith(copyLoc(newCall, path.node))
      state.wroteList = true
      path.skip()
    },
    MemberExpression(path) {
      // Rewrite `obj.value` → `h.read(obj)` for *reads only*. Anything that
      // writes to `.value` (assignment LHS `=`/`+=`/etc., `++`/`--`) is left
      // bare so the emitted JS stays well-formed (`h.read(obj)++` would be
      // a SyntaxError). For AtomRefs this is also exactly what the user
      // wants surfaced — TypeScript's own `ts(2540) Cannot assign to
      // 'value' because it is a read-only property` already fires at the
      // right position. No custom diagnostic needed.
      const n = path.node
      if (n.computed) return
      if (!t.isIdentifier(n.property)) return
      if (n.property.name !== "value") return
      const parent = path.parent
      if (t.isAssignmentExpression(parent) && parent.left === n) return
      if (t.isUpdateExpression(parent) && parent.argument === n) return
      path.replaceWith(t.callExpression(hRead(), [n.object as t.Expression]))
      rewroteRead = true
    },
  })
  return {
    expr: (file.program.body[0] as t.ExpressionStatement).expression,
    rewroteRead,
  }
}

/** Build the props object from JSX attributes. */
const buildProps = (
  attrs: ReadonlyArray<t.JSXAttribute | t.JSXSpreadAttribute>,
  state: RewriteState,
): t.Expression => {
  const properties: Array<t.ObjectProperty | t.SpreadElement> = []
  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) {
      properties.push(t.spreadElement(attr.argument))
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
        : wrapTracked(attr.value.expression, state)
    } else {
      // JSXElement/JSXFragment values are exotic — fall back to recursive transform
      value = transformJsxNode(attr.value as t.JSXElement | t.JSXFragment, state)
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

/** Decide the tag expression: lowercase → string literal, otherwise identifier. */
const tagExpression = (name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): t.Expression => {
  if (t.isJSXNamespacedName(name)) {
    const lit = t.stringLiteral(`${name.namespace.name}:${name.name.name}`)
    return copyLoc(lit, name)
  }
  if (t.isJSXMemberExpression(name)) {
    return jsxMemberToMember(name)
  }
  // JSXIdentifier - preserve location for go-to-definition
  const lower = /^[a-z]/.test(name.name)
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

/** Transform a single JSX child node into an expression. */
const transformChild = (
  child: t.JSXElement["children"][number],
  state: RewriteState,
): t.Expression | null => {
  if (t.isJSXText(child)) {
    // Collapse JSX whitespace per JSX spec: trim trailing newlines, keep
    // internal whitespace, drop pure-whitespace nodes.
    const text = child.value
      .replace(/\s*\n\s*/g, "") // collapse newline-surrounded whitespace
    if (text === "") return null
    return t.stringLiteral(text)
  }
  if (t.isJSXExpressionContainer(child)) {
    return t.isJSXEmptyExpression(child.expression)
      ? null
      : wrapTracked(child.expression, state)
  }
  if (t.isJSXSpreadChild(child)) {
    // Rare; treat as a passthrough spread.
    return child.expression
  }
  return transformJsxNode(child, state)
}

const RUNTIME_PKG = "@efx/runtime"

const ensureRuntimeImports = (program: t.Program, wanted: Set<string>): void => {
  // First pass: find an existing import from the runtime; drop names that
  // are already imported under their own identifier (no `as` alias).
  let existing: t.ImportDeclaration | undefined
  for (const node of program.body) {
    if (!t.isImportDeclaration(node)) continue
    if (node.source.value !== RUNTIME_PKG) continue
    existing = node
    for (const spec of node.specifiers) {
      if (
        t.isImportSpecifier(spec) &&
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

/** Transform a JSX element or fragment node into an h(...) call expression. */
const transformJsxNode = (
  node: t.JSXElement | t.JSXFragment,
  state: RewriteState,
): t.CallExpression => {
  const tag: t.Expression = t.isJSXFragment(node)
    ? copyLoc(t.identifier("Fragment"), node)
    : tagExpression(node.openingElement.name)

  const props: t.Expression = t.isJSXFragment(node)
    ? t.objectExpression([])
    : buildProps(node.openingElement.attributes, state)

  const childArgs: t.Expression[] = []
  for (const child of node.children) {
    const transformed = transformChild(child, state)
    if (transformed) childArgs.push(transformed)
  }

  // Preserve location on the h() call for source map accuracy
  const hCall = t.callExpression(t.identifier("h"), [tag, props, ...childArgs])
  return copyLoc(hCall, node)
}

/**
 * Compile `.efx` source (TypeScript + JSX-shape syntax) into plain
 * TypeScript with every JSX node rewritten as an `h()` call.
 *
 * The output is what `tsc` and Vite see — neither ever encounters JSX.
 * TypeScript's JSX type-checker is therefore never engaged; channel
 * propagation comes from `h()`'s generic signature alone.
 */
export const transformEfx = (source: string, filename: string): TransformResult => {
  const ast = parse(source, {
    ...PARSER_OPTIONS,
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

  const state: RewriteState = { wroteList: false }
  let usedH = false
  let usedFragment = false

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      usedH = true
      path.replaceWith(transformJsxNode(path.node, state))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      usedH = true
      usedFragment = true
      path.replaceWith(transformJsxNode(path.node, state))
    },
  })

  // Auto-inject the runtime imports the rewritten code now depends on.
  // Looks for an existing `import … from "@efx/runtime"` and adds the
  // missing names there; otherwise prepends a new import. Keeps the user's
  // imports untouched and avoids duplicate specifiers.
  if (usedH) {
    const wanted = new Set(["h"])
    if (usedFragment) wanted.add("Fragment")
    if (state.wroteList) wanted.add("list")
    ensureRuntimeImports(ast.program, wanted)
  }

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
  }
}
