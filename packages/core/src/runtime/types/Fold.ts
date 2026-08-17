import type { Chunk, Effect, Option, Result, Scope } from "effect"
import type { Atom, AtomRef } from "effect/unstable/reactivity"
import type { View } from "../View.ts"

/**
 * Documentation-only type listing the leaf shapes a child can take. The
 * actual `h()` constraint is `readonly unknown[]` because TypeScript rejects
 * recursive type aliases that branch through multiple generic instantiations.
 *
 * Recursion is handled at the use site by `ChildE`/`ChildR` — they recurse
 * via `infer` inside conditional types, which TS does support.
 *
 * This set must stay in lockstep with the containers `coerceAsync` peels in
 * `../coerce.ts` (Effect, Option, Result, Chunk, Atom, AtomRef, array). A
 * shape listed here but not peeled there makes the channel fold *lie* — the
 * type claims an E/R the runtime never produces (it would `String(v)` the
 * value instead). `apps/demo/src/channels.test-d.ts` pins this parity.
 */
export type Child =
  | Effect.Effect<View, any, any>
  | View
  | string
  | number
  | boolean
  | null
  | undefined
  | Option.Option<unknown>
  | Result.Result<unknown, any>
  | Chunk.Chunk<unknown>
  | Atom.Atom<unknown>
  | AtomRef.ReadonlyRef<unknown>
  | ReadonlyArray<unknown>

// Errors live in two honest homes by phase, so the fold has two families:
//  - ChildE → CONSTRUCTION errors, on the result Effect's `E` channel
//    (a child's build Effect failing propagates as the parent build fails).
//  - ChildLiveE → LIVE errors, on the result `View<E>` channel
//    (errors a rendered subtree can still produce — they ride the child's
//    `View<E>` success). `R` unifies (one Layer set serves both phases), so
//    there is a single `ChildR`.
// A `Catch` boundary discharges both; `mount` requires both `never`.
// Component tags need no fold family of their own: since #71 the compiler
// lowers `<MyComp/>` to a direct `MyComp({...})` call, so a component's
// channels surface as an ordinary Effect CHILD of the surrounding `h()`.

/**
 * Walk a single child's type, extracting the union of every **construction**
 * `E` — an Effect child's own error channel. A bare `View<E>` child is already
 * built, so it contributes no construction error (its live `E` is `ChildLiveE`'s
 * job). Distributes over unions automatically.
 */
export type ChildE<C> =
  C extends Effect.Effect<any, infer E, any>
    ? E
    : C extends View<any>
      ? never
      : C extends Option.Option<infer T>
        ? ChildE<T>
        : C extends Result.Result<infer A, any>
          ? ChildE<A>
          : C extends Chunk.Chunk<infer T>
            ? ChildE<T>
            : // PHASE SWITCH: whatever an Atom/AtomRef EMITS runs after
              // construction (mount re-coerces each emission — an emitted
              // Effect is executed at render time via `coerceSync`), so none of
              // it is a construction error. Its channels move to `ChildLiveE`.
              C extends Atom.Atom<any>
              ? never
              : C extends AtomRef.ReadonlyRef<any>
                ? never
                : C extends ReadonlyArray<infer T>
                  ? ChildE<T>
                  : never

/**
 * Walk a single child's type, extracting the union of every **live** `E` — the
 * error a rendered subtree can still produce after construction. It reads the
 * phantom `E` off a bare `View<E>` child, and recurses into an Effect's *success*
 * (where a `View<E>` rides) — ignoring the Effect's own `E`, which is
 * construction (`ChildE`'s job). One `infer` at the `View` leaf, no walk into the
 * View's children, so the recursion stays shallow.
 */
export type ChildLiveE<C> =
  C extends Effect.Effect<infer A, any, any>
    ? ChildLiveE<A>
    : // Coalesce `unknown`→`never`: a phantom-free `ViewNode` (no `ViewErr`) matches
      // `View<infer VE>` with `VE = unknown`; treat it as no live error rather than
      // poisoning the fold. (Latent — `ViewNode` isn't part of the public child shapes.)
      C extends View<infer VE>
      ? [unknown] extends [VE]
        ? never
        : VE
      : C extends Option.Option<infer T>
        ? ChildLiveE<T>
        : C extends Result.Result<infer A, any>
          ? ChildLiveE<A>
          : C extends Chunk.Chunk<infer T>
            ? ChildLiveE<T>
            : // PHASE SWITCH (see ChildE): an emitted Effect's OWN `E` is live
              // here — `Atom<Effect<View, E>>` → `View<E>`. This is how
              // `.onFailure(Effect.failCause)` inside `Atom.map(result, …)`
              // escalates a typed failure to the nearest `Catch`
              // (docs/reactivity-migration.md "Errors").
              C extends Atom.Atom<infer T>
              ? ChildE<T> | ChildLiveE<T>
              : C extends AtomRef.ReadonlyRef<infer T>
                ? ChildE<T> | ChildLiveE<T>
                : C extends ReadonlyArray<infer T>
                  ? ChildLiveE<T>
                  : never

/**
 * Walk a single child's type, extracting the union of every `R` channel.
 *
 * Effect's `R` is encoded as a *union* type (each service is a member),
 * not an intersection — so we union here too. A `View<E>` carries no `R`.
 */
export type ChildR<C> =
  C extends Effect.Effect<any, any, infer R>
    ? R
    : C extends View<any>
      ? never
      : C extends Option.Option<infer T>
        ? ChildR<T>
        : C extends Result.Result<infer A, any>
          ? ChildR<A>
          : C extends Chunk.Chunk<infer T>
            ? ChildR<T>
            : C extends Atom.Atom<infer T>
              ? ChildR<T>
              : C extends AtomRef.ReadonlyRef<infer T>
                ? ChildR<T>
                : C extends ReadonlyArray<infer T>
                  ? ChildR<T>
                  : never

/** Fold a tuple of children to the union of their construction `E` channels. */
export type FoldE<Cs extends readonly unknown[]> = ChildE<Cs[number]>

/** Fold a tuple of children to the union of their live `E` channels (`View<E>`). */
export type FoldLiveE<Cs extends readonly unknown[]> = ChildLiveE<Cs[number]>

/** Fold a tuple of children to the union of their `R` channels. */
export type FoldR<Cs extends readonly unknown[]> = ChildR<Cs[number]>

// ─── Props fold: typed event handlers (#72) ────────────────────────────────
//
// An event handler is where most LIVE errors are born: the element is already
// rendered when the handler runs, so its failure has no construction channel
// to ride. The runtime side has always existed (`applyProp` runs a returned
// Effect — on the element's construction-captured context — and routes its
// failure to the boundary sink); these types make it visible: a handler
// returning `Effect<_, E, R>` contributes `E` to the element's live channel
// (`View<E>`, dischargeable by `Catch`, gated by `mount`) and `R` to the
// element's requirements (a missing Layer is a compile error at `mount`).
//
// Only `on*`-keyed props fold — and NOT the bare key `on` itself. That
// mirrors the runtime exactly: `applyProp` attaches a listener (and runs
// returned Effects) only for `on*` keys with `key.length > 2`; any other
// function-valued attr is stringified into an attribute and never invoked —
// folding it would make the type claim an `E` that can never fire. (The same
// parity rule as `Child` ↔ `coerceAsync`.) A reactive-valued handler prop
// (Atom — what a `h.track` derived is — or AtomRef) folds through to the
// inner function: `applyProp`'s reactive branch unwraps the source and
// re-applies its value as a live listener, so the channels must survive
// the wrapper.

/** `true` for exactly `any` — the one type that matches both conditional branches. */
type IsAny<T> = 0 extends 1 & T ? true : false

/**
 * Both channels of one handler prop, extracted in a single pass as `[E, R]`.
 * `never` for anything inert: a void/imperative handler, a non-function
 * value, or a tracked-`unknown` attr. An `any`-typed handler (or handler
 * RETURN — `onclick={() => JSON.parse(x)}`) is also inert: without the guard
 * it would infer `[unknown, unknown]`, where the live `unknown` silently
 * coalesces to `never` one fold up (ChildLiveE's phantom-free escape) —
 * swallowing SIBLING handlers' typed errors — and the `unknown` R poisons
 * the whole tree's requirements into an undischargeable blob. Inert matches
 * the pre-#72 status quo for untyped handler bodies.
 */
type HandlerChannels<H> =
  IsAny<H> extends true
    ? never
    : H extends (...args: ReadonlyArray<any>) => infer Ret
      ? IsAny<Ret> extends true
        ? never
        : Ret extends Effect.Effect<any, infer E, infer R>
          ? [E, R]
          : never
      : H extends AtomRef.ReadonlyRef<infer Inner>
        ? HandlerChannels<Inner>
        : H extends Atom.Atom<infer Inner>
          ? HandlerChannels<Inner>
          : never

/**
 * One cached pass over the props object: the union of every `on*` handler's
 * `[E, R]` pair. `FoldPropsLiveE`/`FoldPropsR` read this shared alias, so the
 * mapped type instantiates once per props shape, not once per channel. The
 * naked `P extends unknown` head DISTRIBUTES over union-typed props — `keyof`
 * of a union is the key INTERSECTION, so without it a handler present in only
 * some members (`{ onclick: H } | { class: string }`, a spread of a
 * conditional) would silently erase. The `[keyof P & `on${string}`]` check is
 * the zero-handler fast path: the vast majority of elements (`{}`,
 * `{ class }`, `data-*`…) bail with one intersection instead of a mapped
 * instantiation.
 */
type FoldPropsChannels<P> = P extends unknown
  ? [keyof P & `on${string}`] extends [never]
    ? never
    : {
        [K in keyof P]: K extends "on"
          ? never
          : K extends `on${string}`
            ? HandlerChannels<P[K]>
            : never
      }[keyof P]
  : never

// Read one side of the [E, R] pairs through a NAKED type parameter: the
// conditional then distributes, so a union of pairs unions the channel and —
// critically — `never` stays `never`. (Checking the alias application
// directly — `FoldPropsChannels<P> extends [infer E, any]` — does not
// distribute, and `never extends [infer E, any]` is vacuously true with NO
// inference candidates, which silently resolves `E` to `unknown` and poisons
// every handler-less element. Hard-won; don't inline these.)
type PairE<T> = T extends [infer E, any] ? E : never
type PairR<T> = T extends [any, infer R] ? R : never

/** Fold a props object to the union of its `on*` handlers' live `E` channels. */
export type FoldPropsLiveE<P> = PairE<FoldPropsChannels<P>>

/**
 * Fold a props object to the union of its `on*` handlers' `R` channels.
 *
 * `Scope` is EXCLUDED, mirroring `list`'s row fold: `runHandlerEffect` provides
 * a `Scope` into the handler effect, so a handler's `Scope` is already
 * satisfied by the runtime. Surfacing it would demand a `Scope` the caller
 * never has to supply — the same lie, in the opposite direction, that the rest
 * of this fold exists to remove. The provided scope is PER-DISPATCH (#160):
 * opened when the handler fires, closed when it settles — `acquireRelease`
 * inside a handler releases per dispatch, and anything `forkScoped` there
 * dies with the dispatch. Lifetime/interruption contract: runtime AGENTS.md
 * "Handler-scope semantics".
 */
export type FoldPropsR<P> = Exclude<PairR<FoldPropsChannels<P>>, Scope.Scope>

// ─── Arms fold: Async arms, Catch fallbacks, tag-map handlers (#120) ───────
//
// An arm/fallback renders on the node's construction-captured context, so a
// service it (or a handler inside it) needs must be in that context — i.e.
// provided at `mount`. Folding the arm's `R` onto the boundary's result makes
// a missing Layer there the same compile error as everywhere else, instead
// of a click-time Service-not-found defect. `Scope` is excluded: the arm
// renders under the node scope (`coerceSync` provides it), like `list` rows
// and handlers. Only `R` folds — an arm's OWN Effect `E` stays permissive and
// its success stays `View<never>` (a typed failing handler inside an arm is
// rejected at the arm; discharge it with a nested `Catch`).

/**
 * `R` of one arm: a function returning a View-or-Effect (its return is
 * folded through `ChildR`) or a bare value (`initial`). `any` is inert.
 */
export type ArmR<F> =
  IsAny<F> extends true
    ? never
    : F extends (...args: ReadonlyArray<any>) => infer Ret
      ? IsAny<Ret> extends true
        ? never
        : Exclude<ChildR<Ret>, Scope.Scope>
      : Exclude<ChildR<F>, Scope.Scope>

/** Fold an arms/handlers object to the union of every arm's `R`. */
export type FoldArmsR<Arms> = Arms extends unknown
  ? { [K in keyof Arms]-?: ArmR<Arms[K]> }[keyof Arms]
  : never
