import { Chunk, Effect, Option, Result } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import type { FoldE, FoldR, TagE, TagProps, TagR } from "./types/Fold.ts"
import { type Props, View } from "./View.ts"

const ATOM_REF_TYPE_ID = "~effect/reactivity/AtomRef"

const isAtomRef = (u: unknown): u is AtomRef.ReadonlyRef<unknown> =>
  typeof u === "object" && u !== null && ATOM_REF_TYPE_ID in u

const isView = (u: unknown): u is View =>
  typeof u === "object" && u !== null && "_tag" in u &&
  (u._tag === "Text" || u._tag === "Element" || u._tag === "Fragment" ||
   u._tag === "Reactive" || u._tag === "Empty")

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

export const h: <
  T extends string | ((props: any) => Effect.Effect<View, any, any>),
  Cs extends readonly unknown[],
>(
  tag: T,
  props: TagProps<T>,
  ...children: Cs
) => Effect.Effect<View, FoldE<Cs> | TagE<T>, FoldR<Cs> | TagR<T>> = _h as never
