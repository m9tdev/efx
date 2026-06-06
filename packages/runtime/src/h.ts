import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { coerceAsync, isAtomRef, recordDep, trackDeps } from "./coerce.ts"
import type { FoldE, FoldR, TagE, TagProps, TagR } from "./types/Fold.ts"
import { type Props, View } from "./View.ts"

// ─── Tracking scope for h.track / h.read ─────────────────────────────────
//
// When the compiler wraps a JSX expression in `h.track(() => ...)`, that
// scope intercepts every `h.read(ref)` call inside and records the ref as
// a dependency. If any reads occurred, h.track returns a derived AtomRef
// that re-runs the thunk on dep changes; otherwise it returns the value
// directly (no reactivity overhead for static expressions). The collector
// itself lives in coerce.ts (`trackDeps`/`recordDep`) so `Await` can share it.

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
function readImpl<T extends HasValue | null | undefined>(obj: T): T extends HasValue ? T["value"] : undefined
function readImpl(obj: unknown): unknown {
  if (isAtomRef(obj)) {
    recordDep(obj)
    return obj.value
  }
  // Identical semantics to `.value` access — preserves the typing TS would
  // have given the original `.value` expression.
  return (obj as HasValue | null | undefined)?.value
}

/**
 * The view factory.
 *
 * Takes a tag (intrinsic element name or a component function) and any
 * number of children. The return type carries the union of every child's
 * `E` and `R` channels via `FoldE`/`FoldR`. Children of arbitrary shape
 * (Effect, Option, Result, Atom, AtomRef, Array, Chunk, primitive) are
 * normalized via `coerceAsync` in `./coerce.ts`.
 */
const _h = (
  tag: string | ((props: Props) => Effect.Effect<View, any, any>),
  props: Props,
  ...children: ReadonlyArray<unknown>
): Effect.Effect<View, any, any> =>
  Effect.gen(function* () {
    const out: View[] = []
    for (const c of children) {
      out.push(yield* coerceAsync(c))
    }
    if (typeof tag === "function") {
      // Component: pass props (children threaded as a prop)
      return yield* tag({ ...props, children: out })
    }
    return View.Element({ tag, props, children: out })
  })

type HFn = <
  T extends string | ((props: any) => Effect.Effect<View, any, any>),
  Cs extends readonly unknown[],
>(
  _tag: T,
  _props: TagProps<T>,
  ..._children: Cs
) => Effect.Effect<View, FoldE<Cs> | TagE<T>, FoldR<Cs> | TagR<T>>

/**
 * The view factory, plus two helper methods the compiler calls into:
 *
 * - `h.track(thunk)` — runs `thunk` in a reactive tracking scope; returns
 *   the static value if no refs were read, or a derived `AtomRef` that
 *   re-runs the thunk when deps change.
 * - `h.read(obj)` — like `obj?.value` but, when called inside an
 *   `h.track` scope, registers `obj` as a dependency if it's an AtomRef.
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
