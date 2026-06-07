# efx

An experimental TypeScript UI framework where Effect's `<A, E, R>` channels
propagate from every leaf of the view tree to the root. Forgetting to provide
a service `Layer` becomes a **compile-time error that names the missing
service**.

Status: proof-of-concept. Not for production. Architecture, invariants, and
per-package contracts live in [AGENTS.md](./AGENTS.md) and the per-subsystem
AGENTS.md tree.

**▶ [Live demo](https://m9tdev.github.io/efx/)** — a guided tour through each
primitive: the source on the left, the inferred `Effect<View, E, R>` type, and
the running component (with a reset button) on the right.

## What you get

- **Channels survive the tree.** A `<UserPage userId="42" />` whose internals
  call `Http.getUser(id)` propagates `HttpError` and `Http | Theme` up to the
  root through every intervening `<div>`, `<Fragment>`, conditional, list,
  and component. The root must provide a `Layer` covering the entire `R`, or
  it fails to compile.
- **Reactive values in JSX expressions.** `{loading.value ? <Spinner /> : <Content />}`
  works against `loading: AtomRef<boolean>` — you write `.value` explicitly and
  the compiler rewrites that read into a tracked one, wrapping the surrounding
  expression in a tracking scope so it re-renders when `loading` changes.
- **Effect-native async boundary.** `Await(() => http.getUser(id), { pending, onError, onSuccess })`
  runs an effect and renders pending → success/error, folding the effect's `R`
  into the component (a forgotten `Layer` is still a compile error). The thunk
  auto-tracks any `.value` it reads, so it refetches when they change.
- **Effect v4 primitives all the way down.** `AtomRef`/`Atom`/`AtomRegistry`
  from `effect/unstable/reactivity` are the reactivity layer; we don't build
  our own. `AsyncResult` is the loading/success/failure shape.
- **Keyed reactive lists.** `{todos.value.map(item => <Row item={item} />)}`
  is compiled to a keyed list that reconciles by `AtomRef` identity — adding,
  removing, or toggling one item never tears down the others.
- **Custom file extension.** `.vx` files are compiled by Babel to plain
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

The demo is a guided tour that exercises every primitive — reactive counter,
blocking and `Await`-boundary data fetches, auto-tracking refetch, keyed
reactive list, and per-component lifecycle — each with a reset button. It's
also deployed at [m9tdev.github.io/efx](https://m9tdev.github.io/efx/).

On Nix, `nix develop` drops you into a shell with Node, Corepack (for
`pnpm` via the `packageManager` field), and Chromium (with `EFX_CHROMIUM`
pre-exported for the probe scripts).

## Smallest possible example

```tsx
// Counter.vx
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
// main.vx
import { Effect, Layer } from "effect"
import { EfxLive, mount } from "@efx/runtime"
import { Counter } from "./Counter.vx"

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
  runtime/      View IR, h(), mount(), Await(), list(), reactivity bindings
  compiler/     .vx → plain TypeScript (Babel)
  language/     Volar language plugin (shared by ts-plugin + check)
  ts-plugin/    TypeScript Language Service plugin (editor integration)
  check/        Standalone CLI type-checker for .vx projects
  vite-plugin/  Vite integration
apps/
  demo/         Counter, UserPage, AsyncUserPage, LiveUser, Todos, Lifecycle
```

## The primitives

| You import from      | What you get                                                                              |
|----------------------|-------------------------------------------------------------------------------------------|
| `@efx/runtime`      | `h`, `mount`, `Await`, `list`, `Fragment`, `View`, `EfxLive`                             |
| `effect`             | `Effect`, `Layer`, `Context.Service`, `Data.TaggedError`, `Cause`, `Option`, `Result`, …  |
| `effect/unstable/reactivity` | `AtomRef`, `Atom`, `AtomRegistry`, `AsyncResult`                                  |

`h.track` / `h.read` are compiler-emitted; you generally never write them
by hand. Reactive reads are always explicit through `.value` — the compiler
rewrites those calls into tracked reads under the hood, and the surrounding
JSX expression is automatically wrapped in a tracking scope.

## Workflow

| Command            | What it does                                                  |
|--------------------|---------------------------------------------------------------|
| `pnpm dev`         | Vite dev server with HMR on `.vx` files                      |
| `pnpm typecheck`   | Per-package `tsc --noEmit`; apps/demo uses `@efx/check` (.vx-aware) |
| `pnpm build`       | Production build via Vite (`@efx/vite-plugin` owns the transform) |
| `pnpm test`        | All package suites — compiler, runtime, language, vite-plugin, testing, ts-plugin (incl. its tsserver integration probe) + `@efx/check` |

## Bundle size

`pnpm build` on the demo produces:

| Asset                 | Raw      | Gzipped  |
|-----------------------|----------|----------|
| `dist/index.html`     |  8.09 kB |  2.24 kB |
| `dist/assets/index-*.js` | 103.99 kB | **35.17 kB** |

The JS bundle contains: `effect@4.0.0-beta.71` runtime (~6 kB gzipped per
upstream docs), `effect/unstable/reactivity` (`AtomRef`, `Atom`,
`AtomRegistry`, `AsyncResult`), the `@efx/runtime` runtime (~600 LOC,
contributes single-digit kB), plus all six demo components (`Counter`,
`UserPage`, `AsyncUserPage`, `LiveUser`, `Todos`, `Lifecycle`), the guided-tour
shell (a small dependency-free TSX highlighter + reactivity-flash visualizer),
and their mock services. Verified interactive after build — Counter increments,
the `Await` boundaries load then resolve, Todos add/remove/toggle, Lifecycle's
per-row scope fires releases on row removal.

Vite serves `.vx` files directly through `@efx/vite-plugin` at dev time;
type-checking goes through `@efx/check`, which feeds `.vx` to tsc as virtual
TypeScript via the shared Volar language plugin. No sibling `.ts` files are
emitted to disk.

## Editor setup

A TypeScript Language Service Plugin (`@efx/ts-plugin`) ships with the
workspace and is wired into `apps/demo/tsconfig.json`'s `plugins` array.
The plugin uses Volar's language plugin framework to provide full IDE
support for `.vx` files.

**What works:** Diagnostics, hover, go-to-definition, find-references,
inlay hints, and document highlights (including JSX tag pair matching).

On GitHub, `.vx` files render with TSX syntax highlighting (via a
`linguist-language=TSX` override in `.gitattributes`).

### Neovim

```vim
" Treat .vx as TSX so your LSP attaches and treesitter highlights it
autocmd BufRead,BufNewFile *.vx setfiletype typescriptreact
```

That plus `tsserver` already configured for `typescriptreact` is enough.
First time opening the workspace you may want to ensure
`packages/ts-plugin/dist/index.cjs` exists — run `pnpm install` from the
repo root or `pnpm --filter @efx/ts-plugin build` directly.

### VS Code

`@efx/ts-plugin` is referenced in `apps/demo/tsconfig.json`. Use
"TypeScript: Select TypeScript Version → Use Workspace Version" to make
sure VS Code's TS extension picks up the plugin. `.vx` files get treated
as TypeScript once the plugin loads.

## See also

- [AGENTS.md](./AGENTS.md) — architecture, per-package contracts, invariants, anti-patterns.
- [`apps/demo/src/channels.test-d.ts`](./apps/demo/src/channels.test-d.ts) — compile-time proof that channels propagate and typed props catch misuse.
- [`packages/runtime/src/types/Fold.test-d.ts`](./packages/runtime/src/types/Fold.test-d.ts) — channel-fold conditional-type test matrix.
