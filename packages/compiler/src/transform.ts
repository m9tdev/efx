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
}

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
 * Wrap a JSX-expression's value in a `h.track(() => expr)` call so the
 * runtime can detect reactive reads inside it. Also rewrites every
 * `x.value` member access within `expr` to `h.read(x)` so AtomRef reads
 * are recorded against the current tracker.
 */
const wrapTracked = (expr: t.Expression): t.CallExpression => {
  const rewritten = rewriteValueReads(expr)
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
const rewriteValueReads = (expr: t.Expression): t.Expression => {
  const file = t.file(t.program([t.expressionStatement(expr)]))
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
      }
    },
    ConditionalExpression(path) {
      if (t.isIdentifier(path.node.test)) {
        path.node.test = wrapPeek(path.node.test)
      }
    },
    LogicalExpression(path) {
      if (t.isIdentifier(path.node.left)) path.node.left = wrapPeek(path.node.left)
      if (t.isIdentifier(path.node.right)) path.node.right = wrapPeek(path.node.right)
    },
    UnaryExpression(path) {
      if (path.node.operator === "!" && t.isIdentifier(path.node.argument)) {
        path.node.argument = wrapPeek(path.node.argument)
      }
    },
  })
  return (file.program.body[0] as t.ExpressionStatement).expression
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

/** Decide the tag expression: lowercase → string literal, otherwise identifier. */
const tagExpression = (name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): t.Expression => {
  if (t.isJSXNamespacedName(name)) {
    return t.stringLiteral(`${name.namespace.name}:${name.name.name}`)
  }
  if (t.isJSXMemberExpression(name)) {
    return jsxMemberToMember(name)
  }
  // JSXIdentifier
  const lower = /^[a-z]/.test(name.name)
  return lower ? t.stringLiteral(name.name) : t.identifier(name.name)
}

const jsxMemberToMember = (m: t.JSXMemberExpression): t.MemberExpression => {
  const object = t.isJSXMemberExpression(m.object)
    ? jsxMemberToMember(m.object)
    : t.identifier(m.object.name)
  return t.memberExpression(object, t.identifier(m.property.name))
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

/** Transform a JSX element or fragment node into an h(...) call expression. */
const transformJsxNode = (node: t.JSXElement | t.JSXFragment): t.CallExpression => {
  const tag: t.Expression = t.isJSXFragment(node)
    ? t.identifier("Fragment")
    : tagExpression(node.openingElement.name)

  const props: t.Expression = t.isJSXFragment(node)
    ? t.objectExpression([])
    : buildProps(node.openingElement.attributes)

  const childArgs: t.Expression[] = []
  for (const child of node.children) {
    const transformed = transformChild(child)
    if (transformed) childArgs.push(transformed)
  }

  return t.callExpression(t.identifier("h"), [tag, props, ...childArgs])
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
  }
}
