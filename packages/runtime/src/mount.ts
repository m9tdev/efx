import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { isView, type Props, View } from "./View.ts"

const ATOM_REF_TYPE_ID = "~effect/reactivity/AtomRef"
const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && ATOM_REF_TYPE_ID in u

type Rendered = {
  readonly node: Node
  readonly cleanup: () => void
}

const noop = () => {}

/**
 * Synchronously coerce an arbitrary value (typically read from a reactive
 * source) into a View. If `scope` is provided and the value is an Effect,
 * the effect is run with that scope, so `Effect.acquireRelease` /
 * `Effect.addFinalizer` inside the effect register releases against it.
 */
const valueToView = (v: unknown, scope?: Scope.Closeable): View => {
  if (v == null || v === false || v === true) return View.Empty()
  if (typeof v === "string") return View.Text({ value: v })
  if (typeof v === "number" || typeof v === "bigint") {
    return View.Text({ value: String(v) })
  }
  if (isView(v)) return v
  if (Effect.isEffect(v)) {
    const provided = scope
      ? Effect.provideService(v as Effect.Effect<unknown, unknown, Scope.Scope>, Scope.Scope, scope)
      : (v as Effect.Effect<unknown, unknown, never>)
    const exit = Effect.runSyncExit(provided)
    return Exit.match(exit, {
      onSuccess: (val) => valueToView(val, scope),
      onFailure: (cause) =>
        View.Text({ value: `[effect failed: ${String(cause)}]` }),
    })
  }
  if (Array.isArray(v)) {
    return View.Fragment({ children: v.map((x) => valueToView(x, scope)) })
  }
  return View.Text({ value: String(v) })
}

const applyProp = (el: Element, key: string, value: unknown): (() => void) | undefined => {
  // Reactive prop: AtomRef → subscribe and re-apply on changes.
  if (isAtomRef(value)) {
    const ref = value as AtomRef.ReadonlyRef<unknown>
    let lastCleanup: (() => void) | undefined
    const apply = (v: unknown) => {
      lastCleanup?.()
      lastCleanup = applyProp(el, key, v)
    }
    apply(ref.value)
    const dispose = ref.subscribe(apply)
    return () => { dispose(); lastCleanup?.() }
  }

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

    case "List": {
      // Wrapper element holds the rendered rows. `display: contents` makes the
      // wrapper invisible to CSS so list items still get the right styling
      // from their actual parent (e.g. `<ul>`).
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"

      // Per-item: rendered DOM + cleanup, keyed by AtomRef identity so
      // reactivity is preserved across reorders/inserts.
      const rendered = new Map<AtomRef.AtomRef<unknown>, Rendered>()
      // Snapshot the array (not just the reference!) — CollectionImpl mutates
      // its internal array in place on push/remove, so comparing references
      // would never detect structural changes.
      let snapshot: Array<AtomRef.AtomRef<unknown>> = []

      const reconcile = (next: ReadonlyArray<AtomRef.AtomRef<unknown>>): void => {
        const nextSet = new Set(next)

        // Drop rows whose ref is gone.
        for (const [ref, r] of rendered) {
          if (!nextSet.has(ref)) {
            r.cleanup()
            if (r.node.parentNode === wrapper) wrapper.removeChild(r.node)
            rendered.delete(ref)
          }
        }

        // Build any new rows and place each in its current position.
        // Each new row gets its own Scope so `Effect.acquireRelease` inside
        // the row component registers releases that fire on row removal.
        let cursor: ChildNode | null = wrapper.firstChild
        next.forEach((ref, i) => {
          let r = rendered.get(ref)
          if (!r) {
            const rowScope = Scope.makeUnsafe()
            const rowView = valueToView(view.render(ref, i), rowScope)
            const built = buildDom(rowView, registry)
            r = {
              node: built.node,
              cleanup: () => {
                built.cleanup()
                // Close the row's scope, firing any acquireRelease releases.
                const closeExit = Scope.closeUnsafe(rowScope, Exit.void)
                if (closeExit) Effect.runFork(closeExit)
              },
            }
            rendered.set(ref, r)
          }
          if (cursor !== r.node) {
            wrapper.insertBefore(r.node, cursor)
          } else {
            cursor = cursor.nextSibling
          }
        })

        snapshot = Array.from(next)
      }

      reconcile(view.source.value)

      const dispose = view.source.subscribe((next) => {
        // Re-reconcile only on structural changes. CollectionImpl also
        // notifies on per-item value updates (which are handled separately
        // by each row's own reactive bindings) — those are no-ops here.
        const structural =
          next.length !== snapshot.length ||
          next.some((ref, i) => ref !== snapshot[i])
        if (structural) reconcile(next)
      })

      return {
        node: wrapper,
        cleanup: () => {
          dispose()
          for (const r of rendered.values()) r.cleanup()
        },
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
