import { Effect, Option } from "effect"
import { Atom, type AtomRef } from "effect/unstable/reactivity"
import { bridgeAtom, coerceAsync, isAtomRef, isHandlerKey } from "./coerce.ts"
import type {
  FoldE,
  FoldLiveE,
  FoldPropsLiveE,
  FoldPropsR,
  FoldR,
} from "./types/Fold.ts"
import type { IntrinsicProps } from "./types/Html.ts"
import { type Props, View } from "./View.ts"

// ─── h.reader + get — the reactive expression ────────────────────────────
//
// The compiler lowers a JSX expression containing a call to verrex's `get`
// to `h.reader(() => expr)`. `h.reader` is `Atom.readable` under the hood: a
// demand-driven derived that re-runs `expr` per dep change, whose lifecycle
// the registry owns by refcount (never mounted → never subscribes; unmount →
// released). `get` is a REAL exported function (auto-imported like `h`) — so
// hover / go-to-def / rename work through tsc with no injected identifiers —
// that reads through the AMBIENT reader: `h.reader` pushes the node's read
// context for the synchronous duration of `read()`, and `get` reads via the
// top of that stack. Outside a reader (a handler, after an `await`, a plain
// function) it throws with a clear message. Inside an `atom((get) => …)`
// body effect-atom's explicit param shadows the import, so both coexist.
// `get` accepts an `Atom` or an `AtomRef` — a ref is bridged INSIDE the
// reader's own read (`bridgeAtom`), the one place verrex still bridges refs
// into the registry graph. Static expressions never reach here (no `get` →
// no wrap), so their TypeScript type survives untouched.

/** What `get` accepts: an atom or a local ref. */
export type Get = <A>(source: Atom.Atom<A> | AtomRef.ReadonlyRef<A>) => A

// The ambient reader stack. A reader's `read` runs synchronously inside the
// registry read; a nested reader CREATED during it is only evaluated later
// (by the registry), so the stack is almost always depth 1 — it is a stack
// only so a reader that synchronously reads another reader's atom (nested
// registry reads re-enter this function) stays correct.
// `null` = an explicit "no ambient" frame: pushed while a reader reads one of
// its sources, so a verrex `get(...)` reached synchronously from INSIDE that
// read (an `Atom.map`/`Atom.readable` body) throws instead of silently
// recording its dep on the outer reader (where it would never re-track).
const readers: Array<Get | null> = []

/**
 * Read an atom or ref inside a reactive JSX expression. The compiler wraps
 * the containing expression in `h.reader(() => …)`, so this only ever runs
 * with an ambient reader; calling it anywhere else throws.
 *
 * ```tsx
 * <span>{get(count) * 2}</span>
 * ```
 */
export const get: Get = (source) => {
  const active = readers[readers.length - 1]
  if (active === undefined || active === null) {
    throw new Error(
      "[verrex] get() called outside a reactive expression. `get` only tracks inside a JSX " +
        "expression (which the compiler wraps in h.reader) — not in an event handler, after an " +
        "await, or in a plain function. Read the atom via `Atom.get`/`registry.get`, or move the " +
        "get(...) into the JSX.",
    )
  }
  return active(source)
}

const readerImpl = <A>(_read: () => A): Atom.Atom<A> =>
  Atom.readable((ctx) => {
    const ambient: Get = (source) => {
      readers.push(null)
      try {
        return isAtomRef(source)
          ? ctx(bridgeAtom(source))
          : ctx(source as Atom.Atom<any>)
      } finally {
        readers.pop()
      }
    }
    // A throw must NOT escape the registry read: `AtomRegistry` has no
    // try/catch around a node's read, so an escaping exception aborts the
    // notify cascade — the parent's REMAINING dependents are dropped from
    // its children set for good (siblings freeze silently) and the throw
    // lands in the writer (a handler → its sink). One transient bad frame
    // (`get(user)!.name` while `user` is briefly null) is common in JSX, so
    // the reader stays node-local: keep the last good value, stay
    // subscribed to whatever the failed run did read, report, and recover on
    // the next dep change. A FIRST-read throw has no last value: it becomes
    // `Effect.die(error)` — a LIVE defect the fold routes to the nearest
    // `Catch` / the root sink (never rethrown into the registry: a nested
    // reader's first read commonly happens inside a notify cascade, where a
    // throw would freeze the siblings just the same). This is a verrex-owned
    // readable, so the guard is ours to keep; user-written `Atom.readable`s
    // get Effect's behaviour (upstream issue).
    readers.push(ambient)
    try {
      return _read()
    } catch (error) {
      const previous = ctx.self<A>()
      if (Option.isNone(previous)) return Effect.die(error) as A
      console.error(
        "[verrex] a reader threw while re-rendering; " +
          "the node kept its last value and will retry on the next dep change.",
        error,
      )
      return previous.value
    } finally {
      readers.pop()
    }
  })

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
 * The view factory, plus the one helper the compiler calls into:
 * `h.reader(() => expr)` — the lowering of a JSX expression that reads
 * atoms/refs via `get(...)`; returns an `Atom` the renderer subscribes to.
 */
export const h: HFn & {
  readonly reader: typeof readerImpl
} = Object.assign(_h as HFn, { reader: readerImpl })
