# efx

An experimental TypeScript UI framework where Effect's `<A, E, R>` channels
propagate from every leaf of the view tree to the root. Forgetting to provide
a service `Layer` becomes a **compile-time error that names the missing
service**.

Status: proof-of-concept. Not for production. The design and trade-offs are
in [DESIGN.md](./DESIGN.md).

## What you get

- **Channels survive the tree.** A `<UserPage userId="42" />` whose internals
  call `Http.getUser(id)` propagates `HttpError` and `Http | Theme` up to the
  root through every intervening `<div>`, `<Fragment>`, conditional, list,
  and component. The root must provide a `Layer` covering the entire `R`, or
  it fails to compile.
- **Reactive values directly in JSX expressions.** `{loading ? <Spinner /> : <Content />}`
  works against `loading: AtomRef<boolean>` with no `.map(…)` wrapping — the
  compiler rewrites bare identifiers in test positions into tracked reads.
- **Effect v4 primitives all the way down.** `AtomRef`/`Atom`/`AtomRegistry`
  from `effect/unstable/reactivity` are the reactivity layer; we don't build
  our own. `AsyncResult` is the loading/success/failure shape.
- **Keyed reactive lists.** `{list(todos, item => <Row item={item} />)}`
  reconciles by `AtomRef` identity — adding/removing/toggling one item never
  tears down the others.
- **Custom file extension.** `.efx` files are compiled by Babel to plain
  TypeScript before `tsc` ever sees them, so TypeScript's JSX type checker
  is never engaged — that's how channels survive instead of collapsing to
  `JSX.Element`.

## Quick start

```bash
git clone … efx
cd efx
pnpm install
pnpm dev
# open http://localhost:5173
```

The demo exercises every primitive — counter, async data fetch, async-state
pattern matching, keyed reactive list.

## Smallest possible example

```tsx
// counter.efx
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"

export const Counter = Effect.fn("Counter")(function* (_props: {} = {}) {
  const count = AtomRef.make(0)
  return yield* (
    <div>
      <button onclick={() => count.update((n) => n + 1)}>+</button>
      <span> {count} clicks </span>
      <button onclick={() => count.set(0)}>reset</button>
    </div>
  )
})
```

```ts
// main.efx
import { Effect, Layer } from "effect"
import { EfxLive, mount } from "@efx/runtime"
import { Counter } from "./Counter"

const program = Effect.gen(function* () {
  yield* mount(<Counter />, document.getElementById("root")!)
  yield* Effect.never
}).pipe(
  Effect.scoped,
  Effect.provide(EfxLive),
)

Effect.runFork(program)
```

## Layout

```
packages/
  runtime/      View IR, h(), mount(), reactivity bindings (~700 LOC)
  compiler/     .efx → .ts source transformer (Babel)        (~200 LOC)
  vite-plugin/  Vite integration                              (~30 LOC)
apps/
  demo/         Counter, UserPage, LiveUser, Todos
```

## The primitives

| You import from      | What you get                                                                              |
|----------------------|-------------------------------------------------------------------------------------------|
| `@efx/runtime`      | `h`, `mount`, `list`, `Fragment`, `View`, `EfxLive`                                      |
| `effect`             | `Effect`, `Layer`, `Context.Service`, `Data.TaggedError`, `Cause`, `Option`, `Result`, …  |
| `effect/unstable/reactivity` | `AtomRef`, `Atom`, `AtomRegistry`, `AsyncResult`                                  |

`h.track` / `h.read` / `h.peek` are compiler-emitted; you generally never
write them by hand.

## Workflow

| Command            | What it does                                                  |
|--------------------|---------------------------------------------------------------|
| `pnpm dev`         | Vite dev server with HMR on `.efx` files                      |
| `pnpm typecheck`   | Compiles `.efx` to `.ts` siblings, runs `tsc --noEmit`        |
| `pnpm build`       | Production build via Vite (`.efx` compiled first)             |
| `pnpm -w run type <Name>` | Print the inferred type of any exported symbol in `apps/demo/src` — e.g. `pnpm -w run type UserPage` → `(props: { userId: string }) => Effect<View, HttpError, Http \| Theme>` |

`.efx` files generate sibling `.ts` files (gitignored) for tsc to read; Vite
serves the `.efx` files directly through the plugin at dev time.

## See also

- [DESIGN.md](./DESIGN.md) — architecture, the compiler, the reactivity model, what we build vs consume, known limits.
- [`apps/demo/src/channels.test-d.ts`](./apps/demo/src/channels.test-d.ts) — compile-time proof that channels propagate and typed props catch misuse.
- [`packages/runtime/src/types/Fold.test-d.ts`](./packages/runtime/src/types/Fold.test-d.ts) — channel-fold conditional-type test matrix.
