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
  Empty: {}
}>

export const View = Data.taggedEnum<View>()
