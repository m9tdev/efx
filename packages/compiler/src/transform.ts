import { parse, type ParserOptions } from "@babel/parser"
import _traverse, { type NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import _generate from "@babel/generator"

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
 * Wrap a JSX-expression's value in a `h.track(() => expr)` call **only when
 * the rewriter found something to track** (a `.value` read or a bare
 * identifier in a test position). Static expressions like `{item}` or
 * `{"hello"}` pass through unchanged so their TypeScript type is preserved
 * — h.track's return is `unknown`, which would otherwise destroy the typing
 * of component props (`<Row item={item} />`, the prop's `item` type).
 */
const wrapTracked = (expr: t.Expression): t.Expression => {
  const { expr: rewritten, rewrote } = rewriteValueReads(expr)
  if (!rewrote) return rewritten
  return t.callExpression(
    t.memberExpression(t.identifier("h"), t.identifier("track")),
    [t.arrowFunctionExpression([], rewritten)],
  )
}

const hMember = (name: "read" | "peek") =>
  t.memberExpression(t.identifier("h"), t.identifier(name))

const wrapPeek = (id: t.Identifier): t.CallExpression =>
  t.callExpression(hMember("peek"), [id])

/**
 * In-place AST rewrites inside a tracked JSX expression:
 *
 *   - `x.value` (read) → `h.read(x)` — tracks AtomRef reads via `.value`.
 *   - bare `x` in a test position (`x ? … : …`, `x && …`, `!x`, etc.) →
 *     `h.peek(x)` — for non-AtomRef `x`, identity; for AtomRef, unwraps
 *     value and tracks. Lets `{loading ? <A/> : <B/>}` work without `.value`.
 *
 * Both rewrites are leaf-local; composite expressions like `x.length > 0`
 * are left alone (the user can add `.value` explicitly).
 */
const rewriteValueReads = (expr: t.Expression): { expr: t.Expression; rewrote: boolean } => {
  const file = t.file(t.program([t.expressionStatement(expr)]))
  let rewrote = false
  traverse(file, {
    MemberExpression(path) {
      const n = path.node
      if (
        !n.computed &&
        t.isIdentifier(n.property) &&
        n.property.name === "value" &&
        !(t.isAssignmentExpression(path.parent) && path.parent.left === n)
      ) {
        path.replaceWith(t.callExpression(hMember("read"), [n.object as t.Expression]))
        rewrote = true
      }
    },
    ConditionalExpression(path) {
      if (t.isIdentifier(path.node.test)) {
        path.node.test = wrapPeek(path.node.test)
        rewrote = true
      }
    },
    LogicalExpression(path) {
      if (t.isIdentifier(path.node.left)) {
        path.node.left = wrapPeek(path.node.left)
        rewrote = true
      }
      if (t.isIdentifier(path.node.right)) {
        path.node.right = wrapPeek(path.node.right)
        rewrote = true
      }
    },
    UnaryExpression(path) {
      if (path.node.operator === "!" && t.isIdentifier(path.node.argument)) {
        path.node.argument = wrapPeek(path.node.argument)
        rewrote = true
      }
    },
  })
  return {
    expr: (file.program.body[0] as t.ExpressionStatement).expression,
    rewrote,
  }
}

/** Build the props object from JSX attributes. */
const buildProps = (attrs: ReadonlyArray<t.JSXAttribute | t.JSXSpreadAttribute>): t.Expression => {
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
        : wrapTracked(attr.value.expression)
    } else {
      // JSXElement/JSXFragment values are exotic — fall back to recursive transform
      value = transformJsxNode(attr.value as t.JSXElement | t.JSXFragment)
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
      : wrapTracked(child.expression)
  }
  if (t.isJSXSpreadChild(child)) {
    // Rare; treat as a passthrough spread.
    return child.expression
  }
  return transformJsxNode(child)
}

const RUNTIME_PKG = "@efx/runtime"

const ensureRuntimeImports = (program: t.Program, wantFragment: boolean): void => {
  const wanted = new Set(["h"])
  if (wantFragment) wanted.add("Fragment")

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
const transformJsxNode = (node: t.JSXElement | t.JSXFragment): t.CallExpression => {
  const tag: t.Expression = t.isJSXFragment(node)
    ? copyLoc(t.identifier("Fragment"), node)
    : tagExpression(node.openingElement.name)

  const props: t.Expression = t.isJSXFragment(node)
    ? t.objectExpression([])
    : buildProps(node.openingElement.attributes)

  const childArgs: t.Expression[] = []
  for (const child of node.children) {
    const transformed = transformChild(child)
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

  let usedH = false
  let usedFragment = false

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      usedH = true
      path.replaceWith(transformJsxNode(path.node))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      usedH = true
      usedFragment = true
      path.replaceWith(transformJsxNode(path.node))
    },
  })

  // Auto-inject the runtime imports the rewritten code now depends on.
  // Looks for an existing `import … from "@efx/runtime"` and adds the
  // missing names there; otherwise prepends a new import. Keeps the user's
  // imports untouched and avoids duplicate specifiers.
  if (usedH) ensureRuntimeImports(ast.program, usedFragment)

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

  return {
    code: result.code,
    map: (result.map as object | null) ?? null,
    jsxRanges,
  }
}
