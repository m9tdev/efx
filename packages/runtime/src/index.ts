import { Effect, Layer, Scope } from "effect"
import { AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { type Props, View } from "./View.ts"

export { h } from "./h.ts"
export { mount } from "./mount.ts"
export { type Props, View } from "./View.ts"
export type { Child, ChildE, ChildR, FoldE, FoldR, TagE, TagProps, TagR } from "./types/Fold.ts"

/**
 * Reactive keyed list. Renders one row per item in `from`, keyed by the
 * item's `AtomRef` identity. Adds/removes only the rows that changed —
 * unaffected rows stay mounted with their DOM and subscriptions intact.
 *
 * Generic `T` is preserved through the function call site (which JSX
 * component tags can't do because of higher-rank polymorphism limits in
 * TypeScript). Use as `{list(coll, (item) => <Row item={item} />)}`.
 */
export const list = <T>(
  from: AtomRef.Collection<T>,
  render: (
    item: AtomRef.AtomRef<T>,
    index: number,
  ) => View | Effect.Effect<View, never, Scope.Scope> | Effect.Effect<View, never, never>,
): View =>
  View.List({
    source: from as AtomRef.Collection<unknown>,
    render: render as (item: AtomRef.AtomRef<unknown>, index: number) => unknown,
  })

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
 * The base Layer every efx app needs. Provides the `AtomRegistry` so any
 * reactive children in the view tree have somewhere to live.
 *
 * Merge this with your app-specific Layers (Http, Db, Theme, etc.) before
 * passing to `Effect.provide`.
 */
export const EfxLive: Layer.Layer<AtomRegistry.AtomRegistry> = AtomRegistry.layer
