import { Data } from "effect"
import type { Atom } from "effect/unstable/reactivity"
import type { AtomRef } from "effect/unstable/reactivity"

export type Props = Readonly<Record<string, unknown>>

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

export type View =
  | ViewText
  | ViewElement
  | ViewFragment
  | ViewReactive
  | ViewList
  | ViewEmpty

export const View = Data.taggedEnum<View>()

export const VIEW_TAGS: ReadonlySet<View["_tag"]> = new Set<View["_tag"]>([
  "Text", "Element", "Fragment", "Reactive", "List", "Empty",
])

export const isView = (u: unknown): u is View =>
  typeof u === "object" && u !== null && "_tag" in u &&
  VIEW_TAGS.has((u as { _tag: View["_tag"] })._tag)
