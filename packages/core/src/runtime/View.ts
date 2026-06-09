import { Data } from "effect"
import type { Cause } from "effect"
import type { Atom } from "effect/unstable/reactivity"
import type { AtomRef } from "effect/unstable/reactivity"

export type Props = Readonly<Record<string, unknown>>

/**
 * A `ViewBoundary`'s current content: the child subtree rendered normally
 * (`ok`), or a caught failure awaiting the fallback (`error`). Driven by
 * `catchCause` — construction sets the initial value, a live failure reported
 * from the child subtree flips it to `error`, and `reset` re-runs construction.
 */
export type BoundaryState =
  | { readonly _tag: "ok"; readonly view: View }
  | { readonly _tag: "error"; readonly cause: Cause.Cause<unknown> }

// Per-variant named interfaces — required so TS preserves the `View` alias
// in hovers. `Data.TaggedEnum<{...}>` runs every variant through
// `Types.Simplify`, which strips the alias and forces TS to inline the full
// union everywhere `Effect<View, ...>` appears.
export interface ViewText {
  readonly _tag: "Text"
  readonly value: string
}
export interface ViewElement {
  readonly _tag: "Element"
  readonly tag: string
  readonly props: Props
  readonly children: ReadonlyArray<View>
}
export interface ViewFragment {
  readonly _tag: "Fragment"
  readonly children: ReadonlyArray<View>
}
export interface ViewReactive {
  readonly _tag: "Reactive"
  // Source can carry any value; mount() normalizes it into a View at render time.
  readonly source: Atom.Atom<unknown> | AtomRef.ReadonlyRef<unknown>
}
export interface ViewList {
  readonly _tag: "List"
  readonly source: AtomRef.Collection<unknown>
  // Returns View or Effect<View, never, never> — mount's valueToView coerces.
  // `index` is a reactive ref: mount pushes each row's current position into it
  // on reorder/shift, so `{index.value}` in a row updates without re-rendering.
  readonly render: (
    item: AtomRef.AtomRef<unknown>,
    index: AtomRef.ReadonlyRef<number>,
  ) => unknown
}
export interface ViewEmpty {
  readonly _tag: "Empty"
}
// Error boundary. Renders `state.ok.view` (child subtree) or, on a caught
// failure, `handler(cause, reset)` (fallback). Unlike other variants this
// carries behavior, not just data: `handler` produces the fallback, `reset`
// re-runs the child construction, and `report` is the sink the child subtree's
// LIVE failures route to (mount swaps `ctx.sink` to it when descending). See
// `catchCause` (index.ts) which builds it and drives `state`.
export interface ViewBoundary {
  readonly _tag: "Boundary"
  readonly state: AtomRef.ReadonlyRef<BoundaryState>
  readonly handler: (cause: Cause.Cause<unknown>, reset: () => void) => unknown
  readonly reset: () => void
  readonly report: (cause: Cause.Cause<unknown>) => void
}

export type View =
  | ViewText
  | ViewElement
  | ViewFragment
  | ViewReactive
  | ViewList
  | ViewBoundary
  | ViewEmpty

export const View = Data.taggedEnum<View>()

export const VIEW_TAGS: ReadonlySet<View["_tag"]> = new Set<View["_tag"]>([
  "Text", "Element", "Fragment", "Reactive", "List", "Boundary", "Empty",
])

export const isView = (u: unknown): u is View =>
  typeof u === "object" && u !== null && "_tag" in u &&
  VIEW_TAGS.has((u as { _tag: View["_tag"] })._tag)
