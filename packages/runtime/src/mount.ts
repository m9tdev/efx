import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { type Props, View } from "./View.ts"

const ATOM_REF_TYPE_ID = "~effect/reactivity/AtomRef"
const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && ATOM_REF_TYPE_ID in u

type Rendered = {
  readonly node: Node
  readonly cleanup: () => void
}

const noop = () => {}

const VIEW_TAGS = new Set(["Empty", "Text", "Element", "Fragment", "Reactive"])
const isView = (u: unknown): u is View =>
  typeof u === "object" && u !== null && "_tag" in u &&
  VIEW_TAGS.has((u as { _tag: string })._tag)

/**
 * Synchronously coerce an arbitrary value (typically read from a reactive
 * source) into a View.
 *
 * If the value is an `Effect<View, never, never>`, we `runSync` it — this
 * lets users write JSX (which compiles to `h(...)` returning an `Effect`)
 * inside e.g. `Atom.map(AsyncResult.match({...}))` matchers, instead of
 * hand-building `View.Element` trees. Effects with E or R can't be runSync'd
 * and surface as a Text node with a diagnostic.
 */
const valueToView = (v: unknown): View => {
  if (v == null || v === false || v === true) return View.Empty()
  if (typeof v === "string") return View.Text({ value: v })
  if (typeof v === "number" || typeof v === "bigint") {
    return View.Text({ value: String(v) })
  }
  if (isView(v)) return v
  if (Effect.isEffect(v)) {
    const exit = Effect.runSyncExit(v as Effect.Effect<unknown, unknown, never>)
    return Exit.match(exit, {
      onSuccess: (val) => valueToView(val),
      onFailure: (cause) =>
        View.Text({ value: `[effect failed: ${String(cause)}]` }),
    })
  }
  if (Array.isArray(v)) {
    return View.Fragment({ children: v.map(valueToView) })
  }
  return View.Text({ value: String(v) })
}

const applyProp = (el: Element, key: string, value: unknown): (() => void) | undefined => {
  if (value == null || value === false) return undefined
  // Event handler: onClick, onInput, etc.
  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const event = key.slice(2).toLowerCase()
    const handler = value as EventListener
    el.addEventListener(event, handler)
    return () => el.removeEventListener(event, handler)
  }
  // class / className
  if (key === "class" || key === "className") {
    el.setAttribute("class", String(value))
    return undefined
  }
  // style object
  if (key === "style" && typeof value === "object") {
    const style = (el as HTMLElement).style
    for (const [k, v] of Object.entries(value as Record<string, string>)) {
      style.setProperty(k, v)
    }
    return undefined
  }
  // Boolean true → presence attribute
  if (value === true) {
    el.setAttribute(key, "")
    return undefined
  }
  // Default: setAttribute
  el.setAttribute(key, String(value))
  return undefined
}

const applyProps = (el: Element, props: Props): Array<() => void> => {
  const cleanups: Array<() => void> = []
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue
    const c = applyProp(el, k, v)
    if (c) cleanups.push(c)
  }
  return cleanups
}

const buildDom = (view: View, registry: AtomRegistry.AtomRegistry): Rendered => {
  switch (view._tag) {
    case "Empty":
      return { node: document.createComment(""), cleanup: noop }

    case "Text":
      return { node: document.createTextNode(view.value), cleanup: noop }

    case "Element": {
      const el = document.createElement(view.tag)
      const cleanups = applyProps(el, view.props)
      for (const child of view.children) {
        const r = buildDom(child, registry)
        el.appendChild(r.node)
        cleanups.push(r.cleanup)
      }
      return {
        node: el,
        cleanup: () => { for (const c of cleanups) c() },
      }
    }

    case "Fragment": {
      // We can't return a DocumentFragment directly because replacing it later
      // requires a stable reference. Wrap in a span with display:contents.
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"
      const cleanups: Array<() => void> = []
      for (const child of view.children) {
        const r = buildDom(child, registry)
        wrapper.appendChild(r.node)
        cleanups.push(r.cleanup)
      }
      return {
        node: wrapper,
        cleanup: () => { for (const c of cleanups) c() },
      }
    }

    case "Reactive": {
      // Placeholder; will be replaced on first render.
      let currentNode: Node = document.createComment("reactive-pending")
      let currentCleanup: () => void = noop

      const render = (next: unknown): void => {
        const r = buildDom(valueToView(next), registry)
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(r.node, currentNode)
        }
        currentCleanup()
        currentNode = r.node
        currentCleanup = r.cleanup
      }

      // Initial synchronous render
      if (Atom.isAtom(view.source)) {
        render(registry.get(view.source))
      } else if (isAtomRef(view.source)) {
        render(view.source.value)
      }

      // Subscribe for future updates
      const dispose = Atom.isAtom(view.source)
        ? registry.subscribe(view.source, render)
        : isAtomRef(view.source)
          ? view.source.subscribe(render)
          : noop

      return {
        node: currentNode,
        cleanup: () => { dispose(); currentCleanup() },
      }
    }
  }
}

/**
 * Run the app Effect, build the DOM, and attach to the target element.
 *
 * The mount itself runs in a Scope; closing that scope tears down all
 * subscriptions and removes the rendered DOM.
 */
export const mount = <E, R>(
  app: Effect.Effect<View, E, R>,
  el: HTMLElement,
): Effect.Effect<void, E, R | AtomRegistry.AtomRegistry | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const view = yield* app
    const rendered = buildDom(view, registry)
    el.replaceChildren()
    el.appendChild(rendered.node)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rendered.cleanup()
        if (rendered.node.parentNode === el) {
          el.removeChild(rendered.node)
        }
      })
    )
  })
