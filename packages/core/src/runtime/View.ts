import { Data } from "effect"
import type { Cause, Context } from "effect"
import type { Atom } from "effect/unstable/reactivity"
import type { AtomRef } from "effect/unstable/reactivity"

export type Props = Readonly<Record<string, unknown>>

/**
 * Phantom carrier for a View's runtime-error channel `E` — the errors a live
 * subtree can still produce after construction (an async refetch, a reactive
 * re-render, an event-handler Effect), routed to the nearest `Catch`.
 *
 * Covariant via `() => E`, which gives exactly the variance the thesis needs:
 *  - `View<HttpError>` is NOT assignable to `View<never>`, so `mount` requiring
 *    `View<never>` is a compile error until every error is discharged by a
 *    boundary (it names the error — the runtime counterpart of a forgotten Layer);
 *  - a phantom-free `ViewNode` (what the constructors produce) IS assignable to
 *    any `View<E>` (the marker is optional and absent), so construction needs no
 *    casts and `View.Empty()` stays a no-arg call.
 *
 * Kept off the variant interfaces (so `Data.taggedEnum` constructor args don't
 * gain a phantom field) and mixed in only via `View<E> = ViewNode & ViewErr<E>`.
 * The fold (`ChildE` in types/Fold.ts) reads it directly via `infer`; it does
 * not walk a View's children, so the recursion stays shallow.
 */
declare const ErrorTypeId: unique symbol
export interface ViewErr<E> {
  readonly [ErrorTypeId]?: () => E
}

/**
 * A `ViewBoundary`'s current content: the child subtree rendered normally
 * (`ok`), or a caught failure awaiting the fallback (`error`). Driven by
 * `Catch` — construction sets the initial value, a live failure reported
 * from the child subtree flips it to `error`, and `reset` re-runs construction.
 *
 * `gen` is a monotonic generation stamp making every emission distinct: `AtomRef`
 * dedups via `Equal.equals`, and a reset that fails with a structurally-identical
 * `Cause` would otherwise be `Equal`-equal to the current state and silently not
 * notify (a dead retry button). `gen` guarantees the swap always fires.
 */
export type BoundaryState =
  | { readonly _tag: "ok"; readonly view: ViewNode; readonly gen: number }
  | { readonly _tag: "error"; readonly cause: Cause.Cause<unknown>; readonly gen: number }

// Per-variant named interfaces — required so TS preserves the `View` alias
// in hovers. `Data.TaggedEnum<{...}>` runs every variant through
// `Types.Simplify`, which strips the alias and forces TS to inline the full
// union everywhere `Effect<View, ...>` appears. These are the phantom-free
// runtime shapes the `Data.taggedEnum` constructors build; the error channel is
// mixed in only at the `View<E>` alias below.
export interface ViewText {
  readonly _tag: "Text"
  readonly value: string
}
export interface ViewElement {
  readonly _tag: "Element"
  readonly tag: string
  readonly props: Props
  readonly children: ReadonlyArray<ViewNode>
  /**
   * Ambient Effect context captured when `h()` constructed this element.
   * Event-handler Effects run on it (`runHandlerEffect` in mount.ts), so a
   * mid-tree `Effect.provide` over a subtree is honored at click time — the
   * runtime counterpart of `FoldPropsR` claiming the handler's `R` on the
   * construction Effect. Absent on hand-built nodes (tests, stale compiled
   * output); mount falls back to its own captured context.
   */
  readonly context?: Context.Context<never>
}
export interface ViewFragment {
  readonly _tag: "Fragment"
  readonly children: ReadonlyArray<ViewNode>
}
export interface ViewReactive {
  readonly _tag: "Reactive"
  // Source can carry any value; mount() normalizes it into a View at render time.
  readonly source: Atom.Atom<unknown> | AtomRef.ReadonlyRef<unknown>
  /**
   * Ambient context captured at construction — every re-render of this node
   * runs on it (`buildScopedChild` via the node-scoped `BuildCtx`), so a
   * mid-tree `Effect.provide` reaches dynamic REBUILDS, not just the first
   * paint. Same contract as `ViewElement.context`; absent on hand-built
   * nodes (mount falls back to its own capture).
   */
  readonly context?: Context.Context<never>
}
export interface ViewList {
  readonly _tag: "List"
  readonly source: AtomRef.Collection<unknown>
  // Returns a View or a sync Effect of one — mount's coerceSync materializes
  // each row on this node's captured context (fallback: mount's), so row
  // channels claimed by `list`'s signature are genuinely available, including
  // under a mid-tree Effect.provide.
  // `index` is a reactive ref: mount pushes each row's current position into it
  // on reorder/shift, so `{index.value}` in a row updates without re-rendering.
  readonly render: (
    item: AtomRef.AtomRef<unknown>,
    index: AtomRef.ReadonlyRef<number>,
  ) => unknown
  /** Construction-captured context — rows build on it. See ViewReactive.context. */
  readonly context?: Context.Context<never>
}
export interface ViewEmpty {
  readonly _tag: "Empty"
}
// Error boundary. Renders `state.ok.view` (child subtree) or, on a caught
// failure, `handler(cause, reset)` (fallback). Unlike other variants this
// carries behavior, not just data: `handler` produces the fallback, `reset`
// re-runs the child construction, and `report` is the sink the child subtree's
// LIVE failures route to (mount swaps `ctx.sink` to it when descending). See
// `Catch` (index.ts) which builds it and drives `state`.
export interface ViewBoundary {
  readonly _tag: "Boundary"
  readonly state: AtomRef.ReadonlyRef<BoundaryState>
  readonly handler: (cause: Cause.Cause<unknown>, reset: () => void) => unknown
  readonly reset: () => void
  readonly report: (cause: Cause.Cause<unknown>) => void
  // `mount` calls this with the ambient (parent) sink before rendering the child,
  // so a tag-selective `Catch` (object form) can escalate a cause it
  // doesn't handle to the next boundary outward. A catch-all never escalates.
  readonly setAmbient: (sink: (cause: Cause.Cause<unknown>) => void) => void
}

/** The phantom-free runtime IR — the shape `mount` switches on and the
 * constructors build. `View<E>` layers the error channel on top. */
export type ViewNode =
  | ViewText
  | ViewElement
  | ViewFragment
  | ViewReactive
  | ViewList
  | ViewBoundary
  | ViewEmpty

/**
 * The public View type, carrying its runtime-error channel `E` (defaulting to
 * `never` — a bare `View` is `View<never>`, fully discharged). `h()` stamps the
 * folded `E` of a subtree onto its result; `Catch` discharges it; `mount`
 * requires `View<never>`. Structurally a `ViewNode` plus the phantom marker.
 */
export type View<E = never> = ViewNode & ViewErr<E>

export const View = Data.taggedEnum<ViewNode>()

export const VIEW_TAGS: ReadonlySet<ViewNode["_tag"]> = new Set<ViewNode["_tag"]>([
  "Text", "Element", "Fragment", "Reactive", "List", "Boundary", "Empty",
])

export const isView = (u: unknown): u is ViewNode =>
  typeof u === "object" && u !== null && "_tag" in u &&
  VIEW_TAGS.has((u as { _tag: ViewNode["_tag"] })._tag)
