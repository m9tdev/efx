import { Effect } from "effect"
import { Atom, type AtomRef } from "effect/unstable/reactivity"
import {
  bridgeAtom,
  coerceAsync,
  isAtomRef,
  isHandlerKey,
  recordDep,
  trackDeps,
} from "./coerce.ts"
import type {
  FoldE,
  FoldLiveE,
  FoldPropsLiveE,
  FoldPropsR,
  FoldR,
} from "./types/Fold.ts"
import type { IntrinsicProps } from "./types/Html.ts"
import { type Props, View } from "./View.ts"

// ─── Tracking scope for h.track / h.read ─────────────────────────────────
//
// When the compiler wraps a JSX expression in `h.track(() => ...)`, that
// scope intercepts every `h.read(ref)` call inside and records the ref as
// a dependency. If any reads occurred, h.track returns a demand-driven
// derived `Atom` that re-runs the thunk on dep changes; otherwise it returns
// the value directly (no reactivity overhead for static expressions). The
// collector itself lives in coerce.ts (`trackDeps`/`recordDep`) so `Async`
// can share it.
//
// The return type is the HONEST union of those two paths — `T` when nothing
// was read, `Atom<T>` when something was. It used to be `unknown`, which
// erased every channel the thunk's value carried: for an `on*` prop that
// silently dropped a handler's `E`/`R` while the runtime still ran it
// (#159). Both members of the union fold: `HandlerChannels` reads a function
// directly and recurses through `Atom`, and `ChildE`/`ChildLiveE`/`ChildR`
// peel `Atom` the same way — so a tracked expression carries its channels
// wherever it lands, instead of laundering them into `unknown`.
const trackImpl = <T>(thunk: () => T): T | Atom.Atom<T> => {
  // Creation-time run decides static vs reactive only; its result is
  // deliberately NOT reused as the Atom's first value — refs can change
  // between component construction and mount, and a lazy node must compute
  // from live state when the registry first reads it.
  const { deps, result } = trackDeps(thunk)
  if (deps.size === 0) return result

  // At least one ref was read — a derived Atom whose read re-runs the thunk
  // and declares each ref it read (via its bridge) as a graph dependency.
  // The registry owns the whole lifecycle by refcount: deps switching between
  // runs (a ternary's other branch) drop the unused bridge, unmounting the
  // subtree drops everything, and a derived that is never mounted never
  // subscribes to anything.
  return Atom.readable((get) => {
    const { result: next, deps: nextDeps } = trackDeps(thunk)
    for (const dep of nextDeps) get(bridgeAtom(dep))
    return next
  }) as Atom.Atom<T>
}

type HasValue = { readonly value: unknown }

function readImpl<T>(obj: AtomRef.ReadonlyRef<T>): T
function readImpl<T extends HasValue>(obj: T): T["value"]
function readImpl(obj: unknown): unknown {
  if (isAtomRef(obj)) {
    recordDep(obj)
    return obj.value
  }
  // Faithful, transparent passthrough: `h.read(x)` is byte-for-byte `x.value`
  // for any non-AtomRef — including throwing on `null`/`undefined` exactly as
  // `.value` would (NO `?.` swallow). This is what lets the compiler rewrite
  // *every* `.value` read in a component body to `h.read` without any
  // compile-time "is this an AtomRef?" analysis: the brand check above is the
  // only gate, and it's exact. A non-AtomRef read records no dependency and
  // returns its `.value` unchanged; an AtomRef read records a dep iff a tracker
  // is active. Reading `.value` on a possibly-null base is a type error in the
  // source `.value` form too, so there is no nullable overload here.
  return (obj as HasValue).value
}

/**
 * The view factory — **intrinsic elements only** since #71. Component tags
 * (`<MyComp/>`) are lowered by the compiler to direct calls
 * (`MyComp({...})`), so a component's channels surface as an ordinary
 * Effect child of the surrounding `h()` — no tag-fold machinery.
 *
 * Takes an intrinsic tag name and any number of children. The return type
 * carries the union of every child's `E` and `R` channels via
 * `FoldE`/`FoldR`. Children of arbitrary shape (Effect, Option, Result,
 * Atom, AtomRef, Array, Chunk, primitive) are normalized via `coerceAsync`
 * in `./coerce.ts`.
 */
const _h = (
  tag: string,
  props: Props,
  ...children: ReadonlyArray<unknown>
): Effect.Effect<View<any>, any, any> => {
  // Stale pre-#71 compiled output (a bundler cache, a version-skewed
  // artifact) still calls h(Component, props). Without this guard it builds
  // View.Element({ tag: fn }) and dies much later in mount with a cryptic
  // createElement DOMException — fail loud at the call instead.
  if (typeof (tag as unknown) === "function") {
    throw new TypeError(
      "h() takes intrinsic tag names only — component tags compile to direct calls since #71. " +
        "A function tag means stale compiled output: clear the bundler cache and recompile the .vx sources.",
    )
  }
  return Effect.gen(function* () {
    // Capture the ambient context at construction — but only when a handler
    // prop exists to consume it (see ViewElement.context; handler dispatch is
    // the capture's ONLY consumer). Handler-less elements — the majority —
    // stay pure data: no extra yield, no retained Context.
    const out: View<any>[] = []
    for (const c of children) {
      out.push(yield* coerceAsync(c))
    }
    if (hasHandlerProp(props)) {
      const context = yield* Effect.context<never>()
      return View.Element({ tag, props, children: out, context })
    }
    return View.Element({ tag, props, children: out })
  })
}

// A prop that applyProp would treat as a handler: an `on*` key (the shared
// `isHandlerKey` gate) holding a function — or an AtomRef (whose unwrapped
// value applyProp re-applies live, possibly as a handler). OWN keys only
// (`Object.hasOwn`): applyProps consumes props via Object.entries, so an
// inherited/prototype-polluted `on*` key would make this gate capture a
// context applyProps never consumes — the two must agree.
const hasHandlerProp = (props: Props): boolean => {
  for (const k in props) {
    if (Object.hasOwn(props, k) && isHandlerKey(k)) {
      const v = props[k]
      if (typeof v === "function" || isAtomRef(v)) return true
    }
  }
  return false
}

// Errors split by phase across the two channels: CONSTRUCTION errors
// (`FoldE`) on the Effect `E` (a child's build failing fails this build),
// LIVE errors (`FoldLiveE`) on the `View<E>` success (errors the
// rendered subtree can still produce). `mount` requires both `never`;
// `Catch` discharges both. The position encodes the phase.
//
// Props fold too (#72): `_props` is generic so an Effect-returning event
// handler's channels survive — its `E` joins the LIVE channel (the handler
// runs after the element is built; `View<E>` is the only honest home) and
// its `R` joins the element's requirements. The `IntrinsicProps` constraint
// is what contextually types the event parameter (`onclick: (e) => …` gets
// `e: MouseEvent`); the fold reads the *inferred* `P`, so a handler's
// precise `Effect<_, E, R>` return is what lands in the channels.
type HFn = <P extends IntrinsicProps, Cs extends readonly unknown[]>(
  _tag: string,
  _props: P,
  ..._children: Cs
) => Effect.Effect<
  View<FoldLiveE<Cs> | FoldPropsLiveE<P>>,
  FoldE<Cs>,
  FoldR<Cs> | FoldPropsR<P>
>

/**
 * The view factory, plus two helper methods the compiler calls into:
 *
 * - `h.track(thunk)` — runs `thunk` in a reactive tracking scope; returns
 *   the static value if no refs were read, or a derived `AtomRef` that
 *   re-runs the thunk when deps change.
 * - `h.read(obj)` — a faithful, transparent wrapper for `obj.value` that, when
 *   called inside an `h.track` (or `Async`) tracking scope, registers `obj` as a
 *   dependency if it's an AtomRef. On any non-AtomRef it is exactly `obj.value`.
 *
 * Inside any JSX expression `{…}` that contains a `.value` read, the
 * compiler rewrites each `x.value` to `h.read(x)` and wraps the whole
 * expression in `h.track(() => …)` — so `<div>{loading.value ? <X /> : <Y />}</div>`
 * becomes reactive without any explicit subscribe code. JSX expressions
 * with no `.value` read pass through unwrapped so their static type is
 * preserved.
 */
export const h: HFn & {
  readonly track: typeof trackImpl
  readonly read: typeof readImpl
} = Object.assign(_h as HFn, { track: trackImpl, read: readImpl })
