import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { coerceSync, isAtomRef } from "./coerce.ts"
import { plan } from "./reconcile.ts"
import { type Props, View } from "./View.ts"

// Subscribe to a ref and register the unsubscribe as a finalizer on the
// given scope. The teardown happens via scope close (full or cascade), so
// individual call sites never have to thread cleanup callbacks back up.
const subscribeRefScoped = <A>(
  ref: AtomRef.ReadonlyRef<A>,
  fn: (v: A) => void,
  scope: Scope.Scope,
): void => {
  const dispose = ref.subscribe(fn)
  Effect.runSync(Scope.addFinalizer(scope, Effect.sync(dispose)))
}

// AtomRegistry uses a different subscribe shape (registry.subscribe(atom, fn))
// than AtomRef. Same finalizer-register pattern; thin separate helper rather
// than overloading the shape.
const subscribeAtomScoped = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  fn: (v: A) => void,
  scope: Scope.Scope,
): void => {
  const dispose = registry.subscribe(atom, fn)
  Effect.runSync(Scope.addFinalizer(scope, Effect.sync(dispose)))
}

const applyProp = (
  el: Element,
  key: string,
  value: unknown,
  scope: Scope.Scope,
): void => {
  // Reactive prop: AtomRef → subscribe and re-apply on changes.
  if (isAtomRef(value)) {
    const ref = value as AtomRef.ReadonlyRef<unknown>
    let lastChildScope: Scope.Closeable | null = null
    const apply = (v: unknown) => {
      if (lastChildScope) {
        const e = Scope.closeUnsafe(lastChildScope, Exit.void)
        if (e) Effect.runFork(e)
      }
      lastChildScope = Scope.forkUnsafe(scope, "sequential")
      applyProp(el, key, v, lastChildScope)
    }
    apply(ref.value)
    subscribeRefScoped(ref, apply, scope)
    return
  }

  if (value == null || value === false) return
  // Event handler: onClick, onInput, etc.
  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const event = key.slice(2).toLowerCase()
    const handler = value as EventListener
    el.addEventListener(event, handler)
    Effect.runSync(
      Scope.addFinalizer(scope, Effect.sync(() => el.removeEventListener(event, handler))),
    )
    return
  }
  // class / className
  if (key === "class" || key === "className") {
    el.setAttribute("class", String(value))
    return
  }
  // style object
  if (key === "style" && typeof value === "object") {
    const style = (el as HTMLElement).style
    for (const [k, v] of Object.entries(value as Record<string, string>)) {
      style.setProperty(k, v)
    }
    return
  }
  // Boolean true → presence attribute
  if (value === true) {
    el.setAttribute(key, "")
    return
  }
  // Default: setAttribute
  el.setAttribute(key, String(value))
}

const applyProps = (el: Element, props: Props, scope: Scope.Scope): void => {
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue
    applyProp(el, k, v, scope)
  }
}

// Materialize a dynamic value into a DOM node under a fresh child scope forked
// from `parent`. Every dynamic subtree (a Reactive emit, a List row) goes
// through here so the "child scope is parent-LINKED, never an orphan" invariant
// lives in one place — closing `parent` cascades into the returned scope, so
// finalizers can't leak on an unexpected teardown path (see AGENTS.md).
const buildScopedChild = (
  value: unknown,
  parent: Scope.Scope,
  registry: AtomRegistry.AtomRegistry,
): { readonly node: Node; readonly scope: Scope.Closeable } => {
  const scope = Scope.forkUnsafe(parent, "sequential")
  const node = buildDom(coerceSync(value, scope), registry, scope)
  return { node, scope }
}

const closeScope = (scope: Scope.Closeable): void => {
  const e = Scope.closeUnsafe(scope, Exit.void)
  if (e) Effect.runFork(e)
}

const buildDom = (view: View, registry: AtomRegistry.AtomRegistry, scope: Scope.Scope): Node => {
  switch (view._tag) {
    case "Empty":
      return document.createComment("")

    case "Text":
      return document.createTextNode(view.value)

    case "Element": {
      const el = document.createElement(view.tag)
      applyProps(el, view.props, scope)
      for (const child of view.children) {
        el.appendChild(buildDom(child, registry, scope))
      }
      return el
    }

    case "Fragment": {
      // We can't return a DocumentFragment directly because replacing it later
      // requires a stable reference. Wrap in a span with display:contents.
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"
      for (const child of view.children) {
        wrapper.appendChild(buildDom(child, registry, scope))
      }
      return wrapper
    }

    case "Reactive": {
      // Placeholder; will be replaced on first render.
      let currentNode: Node = document.createComment("reactive-pending")
      // Rolling child scope: tracks the in-flight subtree's finalizers.
      // On parent close, the fork-cascade closes whatever is current — no
      // explicit teardown needed here.
      let renderChildScope: Scope.Closeable | null = null

      const render = (next: unknown): void => {
        // Build NEW subtree first (subscribing any refs it needs), THEN tear
        // down the OLD subtree. The reverse order would unsubscribe many
        // listeners and resubscribe many — the documented "diff, not
        // unsub-all-then-resub" hazard (see h.ts AGENTS.md) extends here.
        const { node, scope: newScope } = buildScopedChild(next, scope, registry)
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(node, currentNode)
        }
        if (renderChildScope) closeScope(renderChildScope)
        renderChildScope = newScope
        currentNode = node
      }

      // Initial synchronous render
      if (Atom.isAtom(view.source)) {
        render(registry.get(view.source))
        subscribeAtomScoped(registry, view.source, render, scope)
      } else if (isAtomRef(view.source)) {
        render(view.source.value)
        subscribeRefScoped(view.source, render, scope)
      }

      return currentNode
    }

    case "List": {
      // Wrapper element holds the rendered rows. `display: contents` makes the
      // wrapper invisible to CSS so list items still get the right styling
      // from their actual parent (e.g. `<ul>`).
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"

      // Per-row: its DOM node, its own scope (holds every finalizer the row
      // registered — subscriptions, user `acquireRelease` releases), and a
      // reactive index ref the planner's `keep`/`move` ops update. Keyed by
      // AtomRef identity so reactivity is preserved across reorders/inserts.
      type Row = {
        readonly node: Node
        readonly rowScope: Scope.Closeable
        readonly indexRef: AtomRef.AtomRef<number>
      }
      const rendered = new Map<AtomRef.AtomRef<unknown>, Row>()
      // Snapshot the array (not just the reference!) — CollectionImpl mutates
      // its internal array in place on push/remove, so comparing references
      // would never detect structural changes. This is the planner's `prev`.
      let snapshot: Array<AtomRef.AtomRef<unknown>> = []

      // A plan's `before` is a row key; resolve it to the reference node.
      const nodeBefore = (key: AtomRef.AtomRef<unknown> | null): Node | null =>
        key === null ? null : rendered.get(key)?.node ?? null

      const setIndex = (row: Row, index: number): void => {
        if (row.indexRef.value !== index) row.indexRef.set(index)
      }

      // The diff itself lives in the pure `plan` (see reconcile.ts); this is the
      // interpreter — it just applies the ops to real DOM + scopes.
      const reconcile = (next: ReadonlyArray<AtomRef.AtomRef<unknown>>): void => {
        for (const op of plan(snapshot, next)) {
          switch (op.op) {
            case "remove": {
              // Close the row scope first (firing the row's finalizers) THEN
              // detach the DOM, so user releases that observe DOM still see it.
              const row = rendered.get(op.key)
              if (row) {
                closeScope(row.rowScope)
                if (row.node.parentNode === wrapper) wrapper.removeChild(row.node)
                rendered.delete(op.key)
              }
              break
            }
            case "insert": {
              const indexRef = AtomRef.make(op.index)
              const { node, scope: rowScope } = buildScopedChild(
                view.render(op.key, indexRef),
                scope,
                registry,
              )
              rendered.set(op.key, { node, rowScope, indexRef })
              wrapper.insertBefore(node, nodeBefore(op.before))
              break
            }
            case "move": {
              const row = rendered.get(op.key)
              if (row) {
                wrapper.insertBefore(row.node, nodeBefore(op.before))
                setIndex(row, op.index)
              }
              break
            }
            case "keep": {
              const row = rendered.get(op.key)
              if (row) setIndex(row, op.index)
              break
            }
          }
        }
        snapshot = Array.from(next)
      }

      reconcile(view.source.value)

      // Re-reconcile only on structural changes. CollectionImpl also notifies
      // on per-item value updates (which are handled separately by each row's
      // own reactive bindings) — those are no-ops here. This is a pure perf
      // short-circuit, not a correctness gate: a redundant reconcile would just
      // plan all-`keep`. Don't tighten it into something the diff relies on.
      subscribeRefScoped(
        view.source,
        (next) => {
          const structural =
            next.length !== snapshot.length ||
            next.some((ref, i) => ref !== snapshot[i])
          if (structural) reconcile(next)
        },
        scope,
      )

      return wrapper
    }
  }
}

/**
 * Run the app Effect, build the DOM, and attach to the target element.
 *
 * Cleanup is handled entirely through the ambient `Scope`. Every subscription,
 * event listener, and per-row `acquireRelease` registers a finalizer on this
 * scope (directly or via a forked child). Closing the surrounding scope
 * cascades to every child scope and runs all finalizers.
 */
export const mount = <E, R>(
  app: Effect.Effect<View, E, R>,
  el: HTMLElement,
): Effect.Effect<void, E, R | AtomRegistry.AtomRegistry | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const view = yield* app
    const scope = yield* Effect.scope
    const node = buildDom(view, registry, scope)
    el.replaceChildren()
    el.appendChild(node)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (node.parentNode === el) el.removeChild(node)
      })
    )
  })
