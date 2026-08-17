# Reactivity migration: effect-atom API, caller-owned `R`/`E`

Status: implemented on branch `white-porcupine` (2026-08-17); steps 1–7 landed. Deviations from the plan as written: `Fragment`, `Component.make` and `bridgeAtom` stay (see the sections); `h.reader` keeps a node-local throw guard; the JSX reader is compiler-emitted only (no function-child reader in `h`).

## Decision

verrex keeps `effect/unstable/reactivity` and adopts the **effect-atom API**
(`Atom.make`, `Atom.fn`, `Atom.readable`, `Atom.family`, `AsyncResult`,
`Atom.Interrupt`/`Reset`) as its reactivity vocabulary. The one thing verrex
changes: `R` and `E` are the **caller's** responsibility. There is no
`Atom.runtime(layer)`. A component captures its own `Context` and provides it
to the atom it builds; `R` rides the component's Effect to `mount`.

Rejected on the way (see spikes in the agent worktrees `spikes/{c,d,e}-*`):

| Option                          | Why not                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| C — own signal core             | Solves nothing the atom API does not, and verrex would own a scheduler. Contradicts "be effect-atom". |
| D — fiber/Stream per hole       | Joins (`zipLatest`) land on `setImmediate`; diamonds glitch; a fiber per hole (cost unmeasured).      |
| E — keys/cache/`Reactivity` now | Deferred. Later it is `Atom.family` + `Reactivity`, no new concept.                                   |

## New public surface (`@verrex/core`)

```ts
// state of an Effect (replaces asyncRef + streamRef)
type Own = Scope | AtomRegistry   // the atom's own services; never captured
type Held = AtomRegistry | Scope   // the wrapper mounts the atom on the caller's Scope
atom: {
  <A, E, R>(effect: Effect<A, E, R>, opts?): Effect<Atom<AsyncResult<A, E>>, never, Exclude<R, Own> | Held>
  <A, E, R>(create: (get: Atom.AtomContext) => Effect<A, E, R>, opts?): same
  <A, E, R>(stream: Stream<A, E, R>, opts?): Effect<Atom<AsyncResult<A, E | NoSuchElementError>>, never, Exclude<R, Own> | Held>
  <A, E, R>(create: (get) => Stream<A, E, R>, opts?): same
}
// state of an fn (new; = effect-atom `runtime.fn`)
fn: {
  <Arg>(): <A, E, R>(f: (arg: Arg, get: Atom.FnContext) => Effect<A, E, R> | Stream<A, E, R>, opts?)
            => Effect<Fn<Arg, A, E>, never, Exclude<R, Own> | Held>
  <Arg, A, E, R>(f, opts?): same
}
// Fn<Arg, A, E> = Atom.AtomResultFn<Arg, A, E> & {
//   (arg: Arg): Effect<void, never, AtomRegistry>     // run (== Atom.set(self, arg))
//   readonly interrupt: Effect<void, never, AtomRegistry>
//   readonly reset:     Effect<void, never, AtomRegistry>
// }
```

`fn` returns a CALLABLE atom: effect-atom's "write the arg to run it"
convention reads like a store write at a verrex call site (`Atom.set(send,
content)`), so — like the bindings' `useAtomSet` — we hand back `send(content)`.
The object stays a real `AtomResultFn` (`isAtom` accepts functions; registry
nodes are identity-keyed; verified). Two rules, both verified the hard way:
the call MUST be `Atom.set(self, arg)` on the callable itself (targeting the
inner atom creates a second node and runs the body twice), and `Atom.mount`
mounts the callable. Footgun: every Atom combinator (`keepAlive`,
`withEquality`, `withLabel`, `setIdleTTL`) rebuilds via `Object.assign(
Object.create(proto), …)` and returns a NON-callable — document "combinators
on a `fn` result lose the call shape; use `Atom.set`" and pin it. `Atom.set`
remains the write for real cells (`Atom.make`).

Two rules in the implementation:

- The captured context goes UNDER the atom's own (`Scope`, `AtomRegistry`),
  never over it, or an atom-body resource would be tied to the component's
  scope. Tracing: the captured context carries the component's span, so atom
  bodies and refetches nest under `App > Page > …` as today.
- The wrapper `yield* Atom.mount(a)` on the caller's Scope (`Atom.ts:2441`).
  This is what makes lifetime cascade: row removed → row Scope closes →
  unmount → refcount 0 → registry disposes the node → the atom's own Scope
  closes (resources released, in-flight fibers interrupted, `fn` state
  dropped). Without it an atom nobody renders (a `fn` used only from a
  handler) can be disposed between calls — `@effect/atom-react`'s `useAtomSet`
  mounts for the same reason. `mount` discharges `AtomRegistry`.

```ts
type Own = Scope.Scope | AtomRegistry.AtomRegistry
const under = (ctx: Context.Context<never>) => (own: Context.Context<Own>) =>
  Context.merge(ctx, own) // own wins
export const atom = (arg, opts) =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context()
    // branch per arg kind — a union argument does not resolve Atom.make's overloads
    const a = Effect.isEffect(arg)
      ? Atom.make(Effect.updateContext(arg, under(ctx)), opts)
      : Stream.isStream(arg)
        ? Atom.make(Stream.updateContext(arg, under(ctx)), opts)
        : Atom.make((get) => {
            const r = arg(get)
            return Effect.isEffect(r)
              ? Effect.updateContext(r, under(ctx))
              : Stream.updateContext(r, under(ctx))
          }, opts)
    yield* Atom.mount(a)
    return a
  })
```

(`own` MUST be annotated — unannotated it infers `unknown` and poisons `R`;
verified with tsc.) Timing: registry node disposal is scheduled on the
dispatcher; `mount` passes `scheduleTask: queueMicrotask` so "row removed →
fiber interrupted" lands one microtask later; tests await a microtask.

Everything else is imported from `effect/unstable/reactivity` directly and is
documented as the verrex way. DEFAULT cell: `Atom.make(x)` (a `Writable`;
writes are `Atom.set/update` Effects) — inputs, toggles, everything; it
composes (`get` in bodies, `Atom.readable` across sources, memoized deriveds)
and its per-node cost is trivial at component scale. `AtomRef` (+ `map`,
`prop`, `set`) is the ROW model only: `AtomRef.Collection` in `<For>`, where
thousands of cheap sync cells matter. A ref is never an atom dependency and
cannot be read in `Atom.readable`/`atom`/`fn` bodies (no bridge). Both are
equally fine-grained; the split is composability vs per-cell cost. Plus
`Atom.readable`, `Atom.map`,
`Atom.mapResult`, `Atom.family`, `Atom.keepAlive`, `Atom.withRefresh`,
`Atom.swr`, `Atom.optimistic`, `Atom.debounce`, `Atom.get/set/refresh`
(`Effect<_, never, AtomRegistry>` — `mount` provides the registry),
`AsyncResult.*`.

Removed: `asyncRef`, `streamRef`, `AsyncHandle`, `makeDepSubscription`,
`list`, our `AtomRef` glue (`bridgeAtom`, tracker), `Async`, `VerrexLive`,
`h.track`, `h.read`. `Fragment` STAYS: a
fragment must be an Effect where an Effect is expected (`return yield* <>…</>`,
`Catch(<>…</>, …)`, `For` rows) — an array child is not one. `isAtomRef`
stays as the subscribe-shape switch.
Added: `atom`, `fn`, `For`.

`Component.make` STAYS (decided): the name slot is worth the seam. Note for
later: `Effect.fn` on rc.109 preserves a generic component's type parameter
(verified with tsc), so its "generic preservation" job is gone; a future
compiler rewrite naming top-level `Effect.fn` in `.vx` could replace it.

Final core surface: **`h`, `mount`, `Catch`, `For`, `Fragment`, `atom`, `fn`,
`Component.make`, types.** Everything reactive is `effect/unstable/reactivity` verbatim.

## Errors: both phases escalate to the nearest `Catch`

Unchanged thesis: construction errors ride the Effect `E`; live errors ride
`View<E>`; `Catch` (the `Effect.catch*` mirror over both phases) is the one
boundary; `mount` requires `View<never>`. Handling is never forced at the
origin. What changes is how live errors reach it:

- `atom`/`fn` expose `AsyncResult<A, E>` as values. Per site the user picks:
  handle here (`AsyncResult.builder(r).onFailure(…)` → `View<never>`) or
  escalate by emitting an Effect: `.onFailure(Effect.failCause)` (or with
  `AsyncResult.match`: `onFailure: (f) => Effect.failCause(f.cause)` — `match`
  hands a `Failure`, not a `Cause`). The atom then emits `View | Effect<never,
E>`; the fold puts `E` on `View<E>` → nearest `Catch`. Partial handling
  narrows `E`; the residual rides. `h` has NO `AsyncResult` special case; this
  is `Async`'s job done by plain Effect, so `Async` is deleted.
- Fold rule (verified necessary): today `ChildE<Atom<Effect<_,E>>> = E`
  (construction!) and `ChildLiveE = never`. The fold must switch phase at the
  `Atom`/`AtomRef` boundary: `ChildE<Atom<T>> = never`,
  `ChildLiveE<Atom<T>> = ChildE<T> | ChildLiveE<T>`; `ChildR` unchanged.
  Pin: `Atom<Effect<View, E>>` child → `View<E>`, construction `E = never`.
- Handler Effects keep riding `View<E>` (#72). Retry = `Catch`'s `reset` +
  `Atom.refresh(x)`.
- THE idiom for "handle some, bubble the rest" is Effect's own builder:
  `AsyncResult.builder(r).onInitialOrWaiting(…).onErrorTag("NotFound", …)
.onSuccess(…).onFailure(Effect.failCause).exhaustive()` — `onErrorTag`
  narrows `E` like `Effect.catchTag`, `onFailure` receives the residual
  `Cause<E>`, `exhaustive()` type-checks completeness. Never `.render()` (it
  throws the squashed cause, bypassing the typed channel).

## One dialect: `get` everywhere

Atoms and refs are values: a JSX child or prop IS an `Atom`/`AtomRef` and
the renderer subscribes (`registry.subscribe` / `ref.subscribe`). Deps inside
atom bodies are `get(...)`. And JSX expressions use the SAME word — Solid's
mechanism (the compiler wraps the containing expression in a thunk) with
effect-atom's vocabulary:

```tsx
const prompt = Atom.make("")
const userId = Atom.make("1")
const user   = yield* atom((get) => http.getUser(get(userId)))

<input value={prompt} oninput={(e) => Atom.set(prompt, e.currentTarget.value)} />
<span>user #{get(userId)} ({get(prompt).length} chars)</span>          // multi-source, one expression
<div class={get(open) ? "open" : ""} />
{AsyncResult.builder(get(user)).onSuccess((u) => <b>{u.name}</b>).onFailure(Effect.failCause).exhaustive()}
<For each={todos}>{(todo) => <li>{get(todo).title}</li>}</For>                     // Collection rows (AtomRef)
<For each={users} key={(u) => u.id}>{(u) => <li>{get(u).name}</li>}</For>          // Atom rows — same row DX
```

Compiler rule (name-based, the same size as today's `.value` pass):

- A JSX expression (child, or non-`on*` prop) containing a top-level
  `get(…)` call → `Atom.readable((get) => expr)`. No `get` → untouched
  (static; generics survive, purely syntactically).
- `get(…)` inside a nested function within JSX (handler, `.map` callback) →
  COMPILE ERROR "`get` is only valid in a reactive expression". No silent
  untracked reads.
- `get` accepts `Atom` and `AtomRef` (the reader bridges a ref inside its own
  read: `ref.subscribe` → `setSelf`, unsubscribed in the node finalizer — a
  JSX reader is a registry node anyway). Atom bodies keep effect-atom's
  atom-only `get`.
- `get` is exported from `@verrex/core` (auto-imported like `h`) typed as
  `<A>(a: Atom<A> | AtomRef.ReadonlyRef<A>) => A` for tsc; the emitted reader
  shadows it with its parameter. Calling it outside a reactive expression
  throws at runtime; the checker/ts-plugin flags it.
- Purity contract = `Atom.readable`'s own (re-runs per dep change).

Three layers, each valid alone: `{get(x) * 2}` (sugar) → `{(get) => get(x) * 2}`
(explicit inline reader; ALSO supported by `h`, function child/prop → reader)
→ `Atom.readable((get) => …)` (plain effect-atom).

Deleted with this: the compiler's `.value → h.read` rewrite, the `h.track`
wrap (replaced by the `get(…)` → reader wrap), `isSelfTrackingCall`,
`h.track`/`h.read`/`trackDeps`/`recordDep`,
the run-twice and throwing-thunk invariants, and the
"empty-deps early return is load-bearing" rule (no tracker → no generic
erasure). The compiler shrinks to: intrinsic JSX → `h()`, component tags →
calls, `get(…)`-expression → reader wrap (+ nested-function error),
`Component.make` name injection, `children` merge, `<>` →
`Fragment`, `h` auto-import, source maps/`jsxRanges` for the ts-plugin. The
`.map → list` sugar is dropped (step 4b/5). "Purely syntactic" is NOT true —
name injection stays semantic (name-matched, alias-defeated, fails soft).

**Risk kept, not solved (mechanism verified in a scratch test):**
`AtomRegistry.invalidateChildren` swaps the children Set and iterates; a
throwing read (`name = Atom.readable((get) => get(user)!.name)` while `user`
is null) aborts that loop, and the _remaining siblings_ (`status =
Atom.map(user, …)`) are dropped from the parent's children FOREVER — they
never update again, even on later writes or direct reads. The thrower itself
recovers (its edge was registered before the throw), and the exception
escapes `registry.set` into the writer (handler → sink). Today `h.track`
shields it (`trackDepsSettled`); after, users hit Effect's behaviour. Plan:
document, pin "sibling detach + throw escapes to writer" as a known-failing
test, open an upstream Effect issue (per-node try/catch; save/restore in
`invalidateChildren`). No verrex wrapper.

**Batching (verified; examples):** handler `onclick={() => Atom.set(a, 5)}`
→ batched, diamond `d` recomputes once. Handler that writes after a `yield*
Effect.sleep` → the write is past the sync prefix → unbatched, `d`
recomputes twice (transient value, two DOM writes in one tick). Writes from
atom bodies / streams / timers → unbatched, same. Final state is always
correct; only side-effecting readables can observe the transient. `Registry.batch` does NOT restore the previous phase
in `finally`; a nested `batch` during the outer COMMIT flips phase to
`collect` and strands invalidations (derived subscribers freeze until read).
So never wrap reactive emissions/`render` in `Atom.batch`. And handler
dispatch uses `Effect.forkIn` without `startImmediately`, so a `batch` around
it covers nothing — use `{ startImmediately: true }` and accept "sync prefix
only". Upstream issue: `batch` should save/restore `phase`.

`Component.make` stays (see "New public surface").

## Invariant changes (update `runtime/AGENTS.md`)

| Today                                                                | After                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The registry never executes user Effects.                            | The registry executes user Effects only with `R` already provided from the constructing context. Types enforce it (`Atom.make` requires `R ⊆ Scope \| AtomRegistry`).                                                                                                 |
| `asyncRef` uses `makeDepSubscription`.                               | Deleted.                                                                                                                                                                                                                                                              |
| Track/read dance, run-twice, throwing-thunk, empty-deps early return | Deleted with `h.track`/`h.read`.                                                                                                                                                                                                                                      |
| Diamond: 2 recomputes (measured in spike E)                          | Handler dispatch: `forkIn(…, { startImmediately: true })` inside `Atom.batch`, guarded by `batchState.depth === 0` → 1 for the handler's synchronous writes. Emissions/timers/streams: unbatched (accepted; upstream `batch` fix first).                              |
| Registry node disposal timing                                        | `mount` creates the registry with `scheduleTask: queueMicrotask` (default is `setImmediate`): a removed row's atom fibers are interrupted after one microtask, before the next paint. Never synchronous (removal may run inside a notify). Tests `await` a microtask. |
| Mount owns the registry                                              | Unchanged.                                                                                                                                                                                                                                                            |

## Steps (one PR each, `packages/core` only unless noted)

1. **Batch handler writes** — `runHandlerEffect`: `Effect.forkIn(eff, scope,
{ startImmediately: true })` wrapped in `Atom.batch` ONLY when
   `batchState.depth === 0` (internal export in `AtomRegistry.ts`). Never
   wrap emissions. Test: diamond `d = b + c` recomputes once from a handler
   write; nested-batch-in-commit regression pin. No API change.
2. **`atom` + `fn`** in `runtime/index.ts`. Overloads above; `Atom.mount`
   on the caller's Scope; `fn` callable sets ITSELF. Tests: lifetime cascade
   (row Scope close → atom disposed → in-flight fiber interrupted after one
   microtask — `mount` registry uses `scheduleTask: queueMicrotask`; handler-only `fn` keeps state while its component lives), body runs
   once per call, span parent = component, R/E type pins (`*.test-d.ts`: R rides to
   mount, missing Layer = compile error, E on `AsyncResult`, construction `E`
   stays `never`), Interrupt/Reset, `get.self`, Stream latest-emission,
   scope close interrupts. Port `testing/async*.test.ts` cases.
3. **Reactive props** — `applyProp`: an `Atom`/`AtomRef` prop subscribes and
   writes the attribute/property live (children already do; the existing
   AtomRef-handler re-apply becomes the special case). Function-valued
   non-`on*` props become inline readers in step 5 (today stringified —
   note the meaning change). Types:
   `IntrinsicProps` values accept `T | Atom<T> | AtomRef.ReadonlyRef<T>`
   (verified: contextual `e: MouseEvent`, handler fold and `any`-guard
   survive; `Atom<handler>` folds its E). Delete `bridgeAtom` only — the
   tracker stays until step 5 (`h.track` still uses it).
4. **`Async` → typed live Effects** — an atom may emit an `Effect<View, E, R>`
   at render time; mount already runs it (`coerceSync`, constructing context)
   and routes failure to the sink (today's UNTYPED live surface). Type it with
   the phase switch in the fold (Errors section). Escalation is pure Effect
   (`.onFailure(Effect.failCause)`). Keep `Async` as a deprecated wrapper
   until the demo migrates (step 6), then delete. Pin the fold; update README
   "honest scope" (the reactive-re-render hole is closed).
   4b. **Lists: `<For>`** (replaces `list`). Two layers, shippable separately:
   - (i) Mechanism (mount): a keyed-list IR node (today's `List`, generalised)
     reconciled with `reconcile.plan` + per-row `Scope`. INTERNAL to `For`:
     there is no `key` prop on elements (a React-ism; would be the one
     non-HTML attribute mount must strip). Keys are `For`'s `key` fn or, for
     ref rows, the ref's identity.
   - (ii) `For` component, two overloads (mirrors the bindings' `useAtomRef`
     vs `useAtomValue` split):
     ```ts
     For<T, F extends (row: AtomRef.AtomRef<T>, index: AtomRef.ReadonlyRef<number>) => RowRet>
       (props: { each: AtomRef.Collection<T>; children: readonly [F] })
     For<T, K, F extends (row: Atom<T>, index: Atom<number>) => RowRet>
       (props: { each: Atom<ReadonlyArray<T>>; key: (item: T) => K; children: readonly [F] })
     // result: Effect<View<RetLiveE<F>>, RetE<F>, Exclude<RetR<F>, Scope>>
     ```
     `children` is a 1-TUPLE — the compiler always emits `children: [ … ]`
     (`transform.ts` ~748); `F` as its own type param is what makes the row
     renderer's channels fold (verified with tsc).
     Collection rows: identity-keyed, no diffing of values, `row.prop`/
     `row.map`/`row.set` are per-cell (this is today's `list`, renamed).
     Atom rows: `Atom.family(k => Atom.readable(get => get(index).get(k)).pipe(Atom.withEquality(Equal.equals)))`
     — `withEquality` INSIDE the family fn (it returns a new atom object;
     applied at the use site it would churn node identity per emission), and
     `index = Atom.map(each, toMapByKey)` as its own node so the array is
     indexed once per emission (a closure would recompute per row). Verified:
     unchanged item = 0 DOM writes; family entries are WeakRef'd and released
     one tick after the row's DOM unsubscribes. Sources: `Atom.make`, `atom(...)`,
     `Atom.pull` (paging), `Atom.readable`. `<Index>` later if needed.
     Known ergonomic gap: ref rows have `row.prop("title")`, atom rows need
     `Atom.map(row, (x) => x.title)`. Propose `Atom.prop` upstream (mirror of
     `AtomRef.prop`, `map` + `withEquality`); no verrex helper.
     Tests: keyed insert/move/remove for both sources, unchanged-row zero
     writes, row atom released on removal, `Atom.pull` source, E/R fold of the row renderer onto `For`. Drop `list` and
     the compiler `.map → list` sugar (step 5).
5. **Compiler + runtime deletions (one PR)** — replace `.value → h.read` +
   `h.track` wrap with the `get(…)` → `Atom.readable((get) => …)` wrap
   (+ nested-function compile error); remove `isSelfTrackingCall`,
   `.map → list` sugar; `h` accepts a function child/prop as an inline
   reader; export `get`; `<>` still
   lowers to `Fragment`; `Component.make` name injection unchanged. Same PR deletes `h.track`, `h.read`, `trackDeps`,
   `track-*.test.ts` (they are one contract). Update
   `compiler/AGENTS.md`, transform tests, the ts-plugin inlay filter if
   `_tag/_props/_children` change (they don't).
6. **Delete + demo (one PR, two commits)** — commit A (`packages/core`):
   delete `asyncRef`, `streamRef`, `AsyncHandle`, `makeDepSubscription`,
   `VerrexLive`, `Async`, `list`, `dep-subscription.test.ts`. Commit B (`apps/demo`): migrate 35 `.value`
   sites across 11 `.vx` files + `channels.test-d.ts` (every atom-using
   component now shows `Scope | AtomRegistry` in `R`; `Atom.set` handlers
   fold `AtomRegistry`; pin that `mount` still excludes it). Same PR so
   `pnpm -r typecheck` (demo runs `verrex-check`) is never red on `main`.
7. **Docs** — `runtime/AGENTS.md` (add "why `View<E>` but not `View<R>`":
   `E` has two phases, `R` is discharged once at construction because every
   later-running piece captures the constructing context — a `View<R>` would
   only make sense with render-site provision, which we reject),
   `compiler/AGENTS.md`, root `AGENTS.md`
   ("The track/read dance" is gone), README examples; mark this file done.

## Verification

```
pnpm lint && pnpm format:check && pnpm -r test && pnpm -r typecheck
pnpm --filter verrex-demo dev   # Clock + AsyncEscalate + Chat-like fn demo
```

## Open questions

- `Atom.get/set` from handlers: `AtomRegistry` folds into the element's `R`;
  `mount` `Exclude`s it (confirmed by the types review). README examples that
  claim `Effect<View, never, never>` for a counter change to `… never, AtomRegistry>`.
- `atom(effect)` with `initialValue`: keep effect-atom option names verbatim.
- Cells (decided): default `Atom.make`; `AtomRef` only as the `Collection`
  row model. Never a bridge.

## Later: `View<E, R>` for resumable SSR

Re-execution hydration needs nothing new (construction re-runs on the
client; effect-atom `Hydration`/`Atom.serializable` carry data). Resumable
SSR (no client re-run) is the one case where live code has requirements no
construction discharges — then `View<E, R = never>` (second covariant
phantom, `ChildLiveR` fold mirroring `ChildLiveE`) and
`resume(view, el): Effect<void, never, R_live>`. Additive; not now.
