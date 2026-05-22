import { Chunk, Effect, Option, Result } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import type { FoldE, FoldR, TagE, TagProps, TagR } from "./types/Fold.ts"
import { isView, type Props, View } from "./View.ts"

const ATOM_REF_TYPE_ID = "~effect/reactivity/AtomRef"

export const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && ATOM_REF_TYPE_ID in u

// ─── Tracking scope for h.track / h.read ─────────────────────────────────
//
// When the compiler wraps a JSX expression in `h.track(() => ...)`, that
// scope intercepts every `h.read(ref)` call inside and records the ref as
// a dependency. If any reads occurred, h.track returns a derived AtomRef
// that re-runs the thunk on dep changes; otherwise it returns the value
// directly (no reactivity overhead for static expressions).

let currentTracker: Set<AtomRef.ReadonlyRef<unknown>> | null = null

const trackImpl = (thunk: () => unknown): unknown => {
  const deps = new Set<AtomRef.ReadonlyRef<unknown>>()
  const prev = currentTracker
  currentTracker = deps
  let result: unknown
  try {
    result = thunk()
  } finally {
    currentTracker = prev
  }
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
    const nextDeps = new Set<AtomRef.ReadonlyRef<unknown>>()
    const prevTracker = currentTracker
    currentTracker = nextDeps
    try {
      derived.set(thunk() as never)
    } finally {
      currentTracker = prevTracker
    }
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
    if (currentTracker) currentTracker.add(obj)
    return obj.value
  }
  // Identical semantics to `.value` access — preserves the typing TS would
  // have given the original `.value` expression.
  return (obj as HasValue | null | undefined)?.value
}

/**
 * "Use this value, track if it's an AtomRef, otherwise pass through."
 * Called by the compiler when it sees a bare identifier in a test
 * position (ternary test, `&&`/`||` operand, `!` argument) so that
 * `{loading ? <X /> : <Y />}` works without an explicit `.value`.
 */
function peekImpl<T>(obj: AtomRef.ReadonlyRef<T>): T
function peekImpl<T>(obj: T): T
function peekImpl(obj: unknown): unknown {
  if (isAtomRef(obj)) {
    if (currentTracker) currentTracker.add(obj)
    return obj.value
  }
  return obj
}

const Empty = View.Empty()

/**
 * Normalize an arbitrary child value into a `View` node.
 *
 * Recurses through container shapes (Effect, Option, Result, Array, Chunk,
 * AtomRef, Atom). Primitives become Text or Empty. The returned Effect
 * carries any channels the child contributed.
 */
const normalizeChild = (c: unknown): Effect.Effect<View, any, any> => {
  // Falsy → Empty (so `cond && <X/>` works when cond is false/null/undefined)
  if (c === null || c === undefined || c === false || c === true) {
    return Effect.succeed(Empty)
  }
  // Primitives → Text
  if (typeof c === "string") {
    return Effect.succeed(View.Text({ value: c }))
  }
  if (typeof c === "number" || typeof c === "bigint") {
    return Effect.succeed(View.Text({ value: String(c) }))
  }
  // View IR (already-built node) — pass through
  if (isView(c)) {
    return Effect.succeed(c)
  }
  // Effect → run, then normalize the result
  if (Effect.isEffect(c)) {
    return Effect.flatMap(c as Effect.Effect<unknown, any, any>, normalizeChild)
  }
  // Option → onNone Empty, onSome normalize
  if (Option.isOption(c)) {
    return Option.match(c, {
      onNone: () => Effect.succeed(Empty),
      onSome: normalizeChild,
    })
  }
  // Result → onFailure Empty (errors handled via E channel elsewhere), onSuccess normalize
  if (Result.isResult(c)) {
    return Result.match(c, {
      onFailure: () => Effect.succeed(Empty),
      onSuccess: normalizeChild,
    })
  }
  // Chunk → like array
  if (Chunk.isChunk(c)) {
    return normalizeChildren(Chunk.toReadonlyArray(c))
  }
  // Plain readonly array → Fragment
  if (Array.isArray(c)) {
    return normalizeChildren(c)
  }
  // Atom — reactive binding via registry
  if (Atom.isAtom(c)) {
    return Effect.succeed(View.Reactive({ source: c as Atom.Atom<View> }))
  }
  // AtomRef — reactive binding via direct subscribe
  if (isAtomRef(c)) {
    return Effect.succeed(View.Reactive({ source: c as AtomRef.ReadonlyRef<View> }))
  }
  // Fallback: coerce to string
  return Effect.succeed(View.Text({ value: String(c) }))
}

const normalizeChildren = (cs: ReadonlyArray<unknown>): Effect.Effect<View, any, any> =>
  Effect.gen(function* () {
    const out: View[] = []
    for (const c of cs) {
      out.push(yield* normalizeChild(c))
    }
    return View.Fragment({ children: out })
  })

/**
 * The view factory.
 *
 * Takes a tag (intrinsic element name or a component function) and any
 * number of children. The return type carries the union of every child's
 * `E` and `R` channels via `FoldE`/`FoldR`.
 */
const _h = (
  tag: string | ((props: Props) => Effect.Effect<View, any, any>),
  props: Props,
  ...children: ReadonlyArray<unknown>
): Effect.Effect<View, any, any> =>
  Effect.gen(function* () {
    const out: View[] = []
    for (const c of children) {
      out.push(yield* normalizeChild(c))
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
  tag: T,
  props: TagProps<T>,
  ...children: Cs
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
 * The compiler wraps every JSX expression in `h.track(() => …)` and
 * rewrites every `x.value` member access inside to `h.read(x)`, so users
 * can write `<div>{loading.value ? <X /> : <Y />}</div>` and have it be
 * reactive without any explicit subscribe code.
 */
export const h: HFn & {
  readonly track: typeof trackImpl
  readonly read: typeof readImpl
  readonly peek: typeof peekImpl
} = Object.assign(_h as HFn, { track: trackImpl, read: readImpl, peek: peekImpl })
