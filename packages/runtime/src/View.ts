import { Data } from "effect"
import type { Atom } from "effect/unstable/reactivity"
import type { AtomRef } from "effect/unstable/reactivity"

export type Props = Readonly<Record<string, unknown>>

export type View = Data.TaggedEnum<{
  Text: { readonly value: string }
  Element: {
    readonly tag: string
    readonly props: Props
    readonly children: ReadonlyArray<View>
  }
  Fragment: { readonly children: ReadonlyArray<View> }
  Reactive: {
    // Source can carry any value; mount() normalizes it into a View at render time.
    readonly source: Atom.Atom<unknown> | AtomRef.ReadonlyRef<unknown>
  }
  List: {
    readonly source: AtomRef.Collection<unknown>
    // Returns View or Effect<View, never, never> — mount's valueToView coerces.
    readonly render: (item: AtomRef.AtomRef<unknown>, index: number) => unknown
  }
  Empty: {}
}>

export const View = Data.taggedEnum<View>()

export const VIEW_TAGS: ReadonlySet<View["_tag"]> = new Set<View["_tag"]>([
  "Text", "Element", "Fragment", "Reactive", "List", "Empty",
])

export const isView = (u: unknown): u is View =>
  typeof u === "object" && u !== null && "_tag" in u &&
  VIEW_TAGS.has((u as { _tag: View["_tag"] })._tag)
