import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { coerceAsync, isAtomRef, recordDep, trackDeps } from "./coerce.ts"
import type { FoldE, FoldLiveE, FoldR } from "./types/Fold.ts"
import type { IntrinsicProps } from "./types/Html.ts"
import { type Props, View } from "./View.ts"

// ─── Tracking scope for h.track / h.read ─────────────────────────────────
//
// When the compiler wraps a JSX expression in `h.track(() => ...)`, that
// scope intercepts every `h.read(ref)` call inside and records the ref as
// a dependency. If any reads occurred, h.track returns a derived AtomRef
// that re-runs the thunk on dep changes; otherwise it returns the value
// directly (no reactivity overhead for static expressions). The collector
// itself lives in coerce.ts (`trackDeps`/`recordDep`) so `Async` can share it.

const trackImpl = (thunk: () => unknown): unknown => {
  const { result, deps } = trackDeps(thunk)
  if (deps.size === 0) return result

  // At least one ref was read — wrap in a derived AtomRef that re-runs
  // the thunk whenever any tracked ref changes. Deps may change between
  // runs (a ternary's "other branch" reads different refs), so we
  // re-subscribe fresh on each run.
  const derived = AtomRef.make<unknown>(result)
  let unsubs: Array<() => void> = []

  const subscribeAll = (set: Set<AtomRef.ReadonlyRef<unknown>>) => {
    for (const dep of set) unsubs.push(dep.subscribe(rerun))
  }

  const rerun = () => {
    for (const u of unsubs) u()
    unsubs = []
    const { result: next, deps: nextDeps } = trackDeps(thunk)
    derived.set(next as never)
    subscribeAll(nextDeps)
  }

  subscribeAll(deps)
  return derived
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
): Effect.Effect<View<any>, any, any> =>
  Effect.gen(function* () {
    const out: View<any>[] = []
    for (const c of children) {
      out.push(yield* coerceAsync(c))
    }
    return View.Element({ tag, props, children: out })
  })

// Errors split by phase across the two channels: CONSTRUCTION errors
// (`FoldE`) on the Effect `E` (a child's build failing fails this build),
// LIVE errors (`FoldLiveE`) on the `View<E>` success (errors the
// rendered subtree can still produce). `mount` requires both `never`;
// `Catch` discharges both. The position encodes the phase.
type HFn = <Cs extends readonly unknown[]>(
  _tag: string,
  _props: IntrinsicProps,
  ..._children: Cs
) => Effect.Effect<View<FoldLiveE<Cs>>, FoldE<Cs>, FoldR<Cs>>

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
