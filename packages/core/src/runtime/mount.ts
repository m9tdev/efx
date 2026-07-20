import { Cause, Context, Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import {
  coerceSync,
  type ErrorSink,
  getTrackDispose,
  isAtomRef,
  isHandlerKey,
  type SyncRunner,
} from "./coerce.ts"
import { plan } from "./reconcile.ts"
import { type BoundaryState, type Props, View, type ViewNode } from "./View.ts"

// Stable, scope-independent dependencies threaded through the whole build path.
// `scope` is passed separately because it changes per dynamic subtree; these
// three don't. `context` is the ambient Effect context captured at mount — used
// to run event-handler Effects with the app's services. `sink` is where a
// post-mount failure goes (see coerce.ts `ErrorSink`).
interface BuildCtx {
  readonly registry: AtomRegistry.AtomRegistry
  readonly context: Context.Context<never>
  readonly sink: ErrorSink
  // `Effect.runSyncExitWith(context)`, partially applied ONCE per context (the
  // curried runner allocates per application). It is a cache of `context`, so
  // it MUST stay paired with it — only the two BuildCtx constructors set it:
  // `mount` (root) and `withContext`. Don't hand-build a `{ ...ctx, context }`
  // that changes `context` without recomputing this; go through `withContext`.
  // The Element handler path never reads it (handlers consume only
  // `context`/`sink`), so that path doesn't derive a BuildCtx at all.
  readonly runSyncExit: SyncRunner
}

// Derive a node-scoped BuildCtx for a DYNAMIC-RENDER IR node that captured its
// construction context (Reactive re-renders, List rows, Boundary fallbacks) —
// these render through `coerceSync`, which needs the paired `runSyncExit`.
// Reference-equal captures (same fiber, no mid-tree provide) keep the parent
// ctx — no allocation on that path. (Static elements DON'T come here: their
// handlers need only context+sink, passed straight to `applyProps`.)
const withContext = (
  ctx: BuildCtx,
  context: Context.Context<never> | undefined,
): BuildCtx =>
  context === undefined || context === ctx.context
    ? ctx
    : {
        registry: ctx.registry,
        sink: ctx.sink,
        context,
        runSyncExit: Effect.runSyncExitWith(context),
      }

// The two deps a prop application consumes: the element's construction-captured
// `context` (the runtime side of FoldPropsR — a mid-tree provide is honored at
// dispatch) and the `sink` a handler failure routes to. They travel together
// through applyProps → applyProp → the recursive AtomRef re-dispatch, so they
// ride as one value. Deliberately NOT the full `BuildCtx`: the static-element
// path must not derive a node ctx + `runSyncExit` runner it would never read.
interface HandlerDeps {
  readonly context: Context.Context<never>
  readonly sink: ErrorSink
}

// Fire-and-forget an event-handler Effect. Runs on the element's captured
// context (so it sees the services ambient at construction — incl. a mid-tree
// Effect.provide), with the enclosing build `scope` provided INSIDE the effect
// so a handler's `Effect.addFinalizer`/`acquireRelease` has a Scope to register
// against at all (mirrors coerceSync's scope provision).
//
// MIND THE LIFETIME. `scope` is the scope this element was BUILT in, not a
// per-element or per-dispatch one — only dynamic nodes (Reactive emits, List
// rows) fork a scope of their own. So a handler's finalizers release when the
// enclosing dynamic subtree is torn down: element-lifetime inside a Reactive
// node or a list row, but APP-lifetime for a static element under no dynamic
// parent. A handler that acquires on every dispatch accumulates finalizers on
// that scope until it closes. #160 tracks giving each dispatch its own scope.
// Failures route to the sink; pure-interrupt causes (teardown) are dropped.
// Forked INTO the element's `scope` (via `Effect.forkIn`) so a long-lived
// handler is interrupted when the element is removed — and a torn-down handler
// can't report a stale failure back to a reset boundary.
const runHandlerEffect = (
  effect: Effect.Effect<unknown, unknown, never>,
  deps: HandlerDeps,
  scope: Scope.Scope,
): void => {
  Effect.runForkWith(deps.context)(
    Effect.forkIn(
      Effect.matchCause(Effect.provideService(effect, Scope.Scope, scope), {
        onFailure: (cause) => {
          if (!Cause.hasInterruptsOnly(cause)) deps.sink(cause)
        },
        onSuccess: () => {},
      }),
      scope,
    ),
  )
}

// Subscribe to a ref and register the unsubscribe as a finalizer on the
// given scope. The teardown happens via scope close (full or cascade), so
// individual call sites never have to thread cleanup callbacks back up.
const subscribeRefScoped = <A>(
  ref: AtomRef.ReadonlyRef<A>,
  fn: (v: A) => void,
  scope: Scope.Scope,
): void => {
  const dispose = ref.subscribe(fn)
  // If `ref` is a `h.track` derived, also tear down its own
  // derived→underlying-ref subscriptions on scope close — `h.track` has no
  // scope to do it itself. No-op for user refs / asyncRef state (untagged).
  const trackDispose = getTrackDispose(ref as AtomRef.ReadonlyRef<unknown>)
  Effect.runSync(
    Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        dispose()
        trackDispose?.()
      }),
    ),
  )
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

// Props that must be written as DOM *properties*, not attributes. After user
// interaction the dirty value flag makes the `value` attribute and property
// diverge permanently — setAttribute then changes nothing visible. Same story
// for the boolean trio.
const FORM_BOOL_PROPS = new Set(["checked", "selected", "indeterminate"])
// `value` is restricted by tag — `key in el` alone over-matches elements with a
// numeric `value` IDL (<li>, <progress>, <meter>), where a string property
// write is wrong and the no-op guard is permanently defeated.
const VALUE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "OPTION"])
const isFormProp = (el: Element, key: string): boolean =>
  key === "value"
    ? VALUE_TAGS.has(el.tagName)
    : FORM_BOOL_PROPS.has(key) && key in el

// Handlers consume only `HandlerDeps` (the captured context + the sink); they
// never touch the full `BuildCtx`, so the static-Element path passes that pair
// instead of deriving a node-scoped ctx + runner it would never use.
const applyProp = (
  el: Element,
  key: string,
  value: unknown,
  deps: HandlerDeps,
  scope: Scope.Scope,
  deferred?: Array<() => void>,
): void => {
  // Reactive prop: AtomRef → subscribe and re-apply on changes.
  if (isAtomRef(value)) {
    const ref = value as AtomRef.ReadonlyRef<unknown>
    let lastChildScope: Scope.Closeable | null = null
    const apply = (v: unknown, defer?: Array<() => void>) => {
      if (lastChildScope) {
        const e = Scope.closeUnsafe(lastChildScope, Exit.void)
        if (e) Effect.runFork(e)
      }
      lastChildScope = Scope.forkUnsafe(scope, "sequential")
      applyProp(el, key, v, deps, lastChildScope, defer)
    }
    // Deferred initial apply reads `ref.value` at drain time, not now — a
    // capture of the current value could go stale (user code running during
    // the children build may set the ref; the subscription's immediate write
    // must not be clobbered by a stale deferred one).
    if (deferred && isFormProp(el, key)) deferred.push(() => apply(ref.value))
    else apply(ref.value)
    subscribeRefScoped(ref, (v) => apply(v), scope)
    return
  }

  if (isFormProp(el, key)) {
    const rec = el as unknown as Record<string, unknown>
    // `false` maps to "" like null — `value={cond && str}` must not
    // display "false".
    const next =
      key === "value"
        ? value == null || value === false
          ? ""
          : String(value)
        : Boolean(value)
    const write = () => {
      // Guard the write — assigning `value` unconditionally resets the caret
      // to the end, breaking mid-string editing.
      if (rec[key] !== next) rec[key] = next
    }
    // At initial build, children don't exist yet — `select.value = ...` would
    // be a silent no-op. Defer to after the appendChild loop; reactive
    // re-applications (no `deferred`) run immediately.
    if (deferred) deferred.push(write)
    else write()
    return
  }

  if (value == null || value === false) {
    el.removeAttribute(key)
    return
  }
  // Event handler: onClick, onInput, etc. (`isHandlerKey` — the gate shared
  // with h()'s capture predicate and mirrored by the type fold). The handler
  // may return an Effect — run it (on the element's captured context, so it
  // gets the services ambient at construction) and route its failure to the
  // sink. A handler that returns anything else (a plain imperative
  // `ref.set(...)`) just runs as before; non-Effect results are ignored.
  if (isHandlerKey(key) && typeof value === "function") {
    const event = key.slice(2).toLowerCase()
    const userHandler = value as (event: Event) => unknown
    const listener: EventListener = (e) => {
      const result = userHandler(e)
      if (Effect.isEffect(result)) {
        runHandlerEffect(
          result as Effect.Effect<unknown, unknown, never>,
          deps,
          scope,
        )
      }
    }
    el.addEventListener(event, listener)
    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => el.removeEventListener(event, listener)),
      ),
    )
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

const applyProps = (
  el: Element,
  props: Props,
  deps: HandlerDeps,
  scope: Scope.Scope,
  deferred?: Array<() => void>,
): void => {
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue
    applyProp(el, k, v, deps, scope, deferred)
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
  ctx: BuildCtx,
): { readonly node: Node; readonly scope: Scope.Closeable } => {
  const scope = Scope.forkUnsafe(parent, "sequential")
  const node = buildDom(
    coerceSync(value, scope, ctx.sink, ctx.runSyncExit),
    ctx,
    scope,
  )
  return { node, scope }
}

const closeScope = (scope: Scope.Closeable): void => {
  const e = Scope.closeUnsafe(scope, Exit.void)
  if (e) Effect.runFork(e)
}

const buildDom = (view: ViewNode, ctx: BuildCtx, scope: Scope.Scope): Node => {
  switch (view._tag) {
    case "Empty":
      return document.createComment("")

    case "Text":
      return document.createTextNode(view.value)

    case "Element": {
      const el = document.createElement(view.tag)
      // Handlers run on the context captured when h() built this element
      // (h captures only when a handler prop exists), so a mid-tree
      // Effect.provide is honored at click time (the runtime side of
      // FoldPropsR). Pass the `HandlerDeps` pair — handlers need only those,
      // so the static-element path never derives a node ctx/runner. Children
      // keep the ambient ctx. Hand-built nodes (no capture) fall back to
      // mount's context.
      // Form-control property writes are deferred past the children loop:
      // `select.value` assigned before its <option>s exist silently no-ops.
      const deferred: Array<() => void> = []
      applyProps(
        el,
        view.props,
        { context: view.context ?? ctx.context, sink: ctx.sink },
        scope,
        deferred,
      )
      for (const child of view.children) {
        el.appendChild(buildDom(child, ctx, scope))
      }
      for (const write of deferred) write()
      return el
    }

    case "Fragment": {
      // We can't return a DocumentFragment directly because replacing it later
      // requires a stable reference. Wrap in a span with display:contents.
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"
      for (const child of view.children) {
        wrapper.appendChild(buildDom(child, ctx, scope))
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
      // Every emission builds on this node's construction-captured context
      // (mid-tree provides reach REBUILDS, not just first paint). Once per
      // node, reused per emission.
      const nodeCtx = withContext(ctx, view.context)

      const render = (next: unknown): void => {
        // Build NEW subtree first (subscribing any refs it needs), THEN tear
        // down the OLD subtree. The reverse order would unsubscribe many
        // listeners and resubscribe many — the documented "diff, not
        // unsub-all-then-resub" hazard (see h.ts AGENTS.md) extends here.
        const { node, scope: newScope } = buildScopedChild(next, scope, nodeCtx)
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(node, currentNode)
        }
        if (renderChildScope) closeScope(renderChildScope)
        renderChildScope = newScope
        currentNode = node
      }

      // Initial synchronous render
      if (Atom.isAtom(view.source)) {
        render(ctx.registry.get(view.source))
        subscribeAtomScoped(ctx.registry, view.source, render, scope)
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
      // Rows build on the list's construction-captured context — the runtime
      // side of list()'s folded row R (see ViewList.context).
      const nodeCtx = withContext(ctx, view.context)
      // Snapshot the array (not just the reference!) — CollectionImpl mutates
      // its internal array in place on push/remove, so comparing references
      // would never detect structural changes. This is the planner's `prev`.
      let snapshot: Array<AtomRef.AtomRef<unknown>> = []

      // A plan's `before` is a row key; resolve it to the reference node.
      const nodeBefore = (key: AtomRef.AtomRef<unknown> | null): Node | null =>
        key === null ? null : (rendered.get(key)?.node ?? null)

      const setIndex = (row: Row, index: number): void => {
        if (row.indexRef.value !== index) row.indexRef.set(index)
      }

      // The diff itself lives in the pure `plan` (see reconcile.ts); this is the
      // interpreter — it just applies the ops to real DOM + scopes.
      const reconcile = (
        next: ReadonlyArray<AtomRef.AtomRef<unknown>>,
      ): void => {
        for (const op of plan(snapshot, next)) {
          switch (op.op) {
            case "remove": {
              // Close the row scope first (firing the row's finalizers) THEN
              // detach the DOM, so user releases that observe DOM still see it.
              const row = rendered.get(op.key)
              if (row) {
                closeScope(row.rowScope)
                if (row.node.parentNode === wrapper)
                  wrapper.removeChild(row.node)
                rendered.delete(op.key)
              }
              break
            }
            case "insert": {
              const indexRef = AtomRef.make(op.index)
              const { node, scope: rowScope } = buildScopedChild(
                view.render(op.key, indexRef),
                scope,
                nodeCtx,
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

    case "Boundary": {
      // The child subtree renders with a sink that reports into THIS boundary
      // (live failures flip its state to `error`); the fallback renders with the
      // ambient `ctx` sink, so a failure in the fallback bubbles to the next
      // boundary outward. `setAmbient` hands the boundary the parent sink so a
      // tag-selective boundary can escalate a cause it doesn't handle.
      // Same build-NEW → swap → close-OLD ordering as Reactive.
      view.setAmbient(ctx.sink)
      const childCtx: BuildCtx = { ...ctx, sink: view.report }
      // The fallback builds on the boundary's construction context (the ok
      // content needs no swap — it was built by the boundary's drain fiber,
      // which inherits that context) while keeping the AMBIENT sink, so a
      // failure in the fallback still bubbles outward.
      const fallbackCtx = withContext(ctx, view.context)
      let currentNode: Node = document.createComment("boundary-pending")
      let contentScope: Scope.Closeable | null = null

      const render = (st: BoundaryState): void => {
        const built =
          st._tag === "ok"
            ? buildScopedChild(st.view, scope, childCtx)
            : buildScopedChild(
                view.handler(st.cause, view.reset),
                scope,
                fallbackCtx,
              )
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(built.node, currentNode)
        }
        if (contentScope) closeScope(contentScope)
        contentScope = built.scope
        currentNode = built.node
      }

      render(view.state.value)
      subscribeRefScoped(view.state, render, scope)
      return currentNode
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
 *
 * Post-mount failures (a reactive re-render or an event-handler Effect that
 * fails) that aren't caught by a `Catch` boundary are routed to a root
 * error sink that logs via `Effect.logError` on the captured context.
 *
 * **Requires `Effect<View<never>, never, R>`** — the app must have every error
 * discharged: construction failures off the Effect `E` channel (via
 * `Effect.catchCause` or a `Catch` boundary) and live failures off the
 * `View<E>` channel (via `Catch`). A leftover error is a compile error here
 * that names it — the runtime counterpart of a forgotten `Layer` naming a service.
 */
export const mount = <R>(
  app: Effect.Effect<View<never>, never, R>,
  el: HTMLElement,
): Effect.Effect<void, never, R | AtomRegistry.AtomRegistry | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    // The real ambient context (carries the app's provided services). Typed
    // `never` so it threads without a generic — handler Effects are cast to
    // `R = never` at the run site; the services are present at runtime.
    const context = yield* Effect.context<never>()
    const sink: ErrorSink = (cause) => {
      Effect.runForkWith(context)(Effect.logError(cause))
    }
    const ctx: BuildCtx = {
      registry,
      context,
      sink,
      runSyncExit: Effect.runSyncExitWith(context),
    }
    const view = yield* app
    const scope = yield* Effect.scope
    const node = buildDom(view, ctx, scope)
    el.replaceChildren()
    el.appendChild(node)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (node.parentNode === el) el.removeChild(node)
      }),
    )
  })
