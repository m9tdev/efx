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
        : attr.value.expression
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
    return t.isJSXEmptyExpression(child.expression) ? null : child.expression
  }
  if (t.isJSXSpreadChild(child)) {
    // Rare; treat as a passthrough spread.
    return child.expression
  }
  return transformJsxNode(child)
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

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      // Replace the JSX expression with its h() call equivalent.
      path.replaceWith(transformJsxNode(path.node))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      path.replaceWith(transformJsxNode(path.node))
    },
  })

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
