import { Effect, Layer } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { type Props, View } from "./View.ts"

export { h } from "./h.ts"
export { mount } from "./mount.ts"
export { type Props, View } from "./View.ts"
export type { Child, ChildE, ChildR, FoldE, FoldR } from "./types/Fold.ts"

/**
 * Fragment component — the compile target for JSX `<>...</>` syntax.
 *
 * `h(Fragment, props, ...children)` evaluates to a `View.Fragment` whose
 * children are whatever was nested inside.
 */
export const Fragment = (
  props: Props & { children?: ReadonlyArray<View> },
): Effect.Effect<View, never, never> =>
  Effect.succeed(View.Fragment({ children: props.children ?? [] }))

/**
 * The base Layer every effx app needs. Provides the `AtomRegistry` so any
 * reactive children in the view tree have somewhere to live.
 *
 * Merge this with your app-specific Layers (Http, Db, Theme, etc.) before
 * passing to `Effect.provide`.
 */
export const EffxLive: Layer.Layer<AtomRegistry.AtomRegistry> = AtomRegistry.layer
