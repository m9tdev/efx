// Pure keyed-list reconciliation planner.
//
// This is the single most bug-prone piece of the runtime — a keyed diff — and
// it is deliberately pure: it operates over opaque keys `K` with NO DOM, no
// `Scope`, no `Effect`. That makes the diff exhaustively unit-testable (see
// `reconcile.test.ts`) without mounting a real DOM. `mount`'s `List` case is the
// *interpreter*: it applies the plan to real DOM nodes and per-row `Scope`s.
//
// The plan is behaviourally equivalent to the single-pass cursor reconcile that
// used to live inline in `mount`: each `insert`/`move`/`remove` op drives
// exactly one DOM mutation the old loop performed (`insertBefore`/`removeChild`)
// in the same order, so the same nodes move. (The op *vocabulary* is richer —
// the old loop conflated build-and-insert with reposition into one branch — but
// the resulting mutations match.) The added `keep` op carries the row's new
// index so the interpreter can push it into a reactive index ref; the old loop
// left a moved/shifted row's index stale.
//
// Precondition: keys are unique within a snapshot. The `List` source is an
// `AtomRef.Collection` whose rows are distinct `AtomRef`s, so identity is
// unique; duplicate keys would make "insert before key X" ambiguous.

/** One step in a reconciliation plan, over an opaque row key `K`. */
export type ReconcileOp<K> =
  /** Row dropped from the list — tear down its scope and detach its node. */
  | { readonly op: "remove"; readonly key: K }
  /** New row — build it, set its index, insert before `before` (null = append). */
  | { readonly op: "insert"; readonly key: K; readonly before: K | null; readonly index: number }
  /** Existing row repositioned — move its node before `before`, update its index. */
  | { readonly op: "move"; readonly key: K; readonly before: K | null; readonly index: number }
  /** Existing row already in place — update its index only (no DOM mutation). */
  | { readonly op: "keep"; readonly key: K; readonly index: number }

/**
 * Compute the ops that turn the `prev` key order into the `next` key order.
 *
 * Removals are emitted first (every `prev` key absent from `next`), then a
 * left-to-right placement walk over `next` emits one `insert`/`move`/`keep` per
 * key. The walk models the post-removal DOM children in `work` and tracks a
 * `cursor` that mirrors the live DOM cursor: it only advances past a row that is
 * already in place, exactly like the original `cursor = cursor.nextSibling`.
 */
export const plan = <K>(
  prev: ReadonlyArray<K>,
  next: ReadonlyArray<K>,
): ReadonlyArray<ReconcileOp<K>> => {
  const nextSet = new Set(next)
  const prevSet = new Set(prev)
  const ops: Array<ReconcileOp<K>> = []

  // Phase 1 — removals. Emitted first so the interpreter closes dropped rows'
  // scopes (and detaches their nodes) before building anything new, matching
  // the prior teardown order.
  for (const key of prev) {
    if (!nextSet.has(key)) ops.push({ op: "remove", key })
  }

  // Phase 2 — placement walk. `work` is the wrapper's children in DOM order
  // after removals; `cursor` indexes the node the live DOM cursor points at.
  const work = prev.filter((k) => nextSet.has(k))
  let cursor = 0
  next.forEach((key, index) => {
    const atCursor: K | null = cursor < work.length ? work[cursor]! : null
    if (atCursor === key) {
      // Already in place. (DOM: cursor = cursor.nextSibling.) Still emit a
      // `keep` so a shifted index reaches the row's index ref.
      ops.push({ op: "keep", key, index })
      cursor++
      return
    }
    // Needs (re)placing before `atCursor` (null → append). Mirror the DOM
    // `insertBefore(node, atCursor)`: drop any current occurrence of `key`, then
    // splice it in at the cursor — leaving `cursor` pointed at `atCursor` again.
    const from = work.indexOf(key)
    if (from !== -1) {
      work.splice(from, 1)
      if (from < cursor) cursor-- // removal shifted the cursor target left
    }
    work.splice(cursor, 0, key)
    cursor++
    ops.push({ op: prevSet.has(key) ? "move" : "insert", key, before: atCursor, index })
  })

  return ops
}
