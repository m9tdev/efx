# verrex

An experimental TypeScript UI framework where Effect's `<A, E, R>` channels
propagate from every leaf of the view tree to the root. Forgetting to provide
a service `Layer` becomes a **compile-time error that names the missing
service**.

> **Why "verrex"?** The name is built from the channels of an
> `Effect<View, E, R>` — **V** (View — the `A`, which here is always the
> `View`), **E** (Error), **R** (Requirements) — plus **X**, because the JSX/TSX
> syntax it borrows adds an X too. `V + E + R + X` spells **verx**, stylized to
> **verrex** (and the source extension is `.vx`).

Status: proof-of-concept. Not for production. Architecture, invariants, and
per-package contracts live in [AGENTS.md](./AGENTS.md) and the per-subsystem
AGENTS.md tree.

**▶ [Live demo](https://m9tdev.github.io/verrex/)** — a guided tour through each
primitive: the source on the left, the inferred `Effect<View, E, R>` type, and
the running component (with a reset button) on the right.

## What you get

- **Channels survive the tree.** A `<UserPage userId="42" />` whose internals
  call `Http.getUser(id)` propagates `HttpError` and `Http | Theme` up to the
  root through every intervening `<div>`, `<Fragment>`, conditional, list,
  and component. The root must provide a `Layer` covering the entire `R`, or
  it fails to compile.
- **effect-atom's API, with `R`/`E` owned by the caller.** State is
  `Atom.make(x)`; async data is `yield* atom((get) => http.getUser(get(id)))`,
  the state of a function call is `yield* fn((u) => http.save(u))` — the
  same `Atom.make` / `Atom.fn` / `AsyncResult` you know from effect-atom,
  minus `Atom.runtime`: the component's own services ride to `mount`, so a
  forgotten `Layer` is a compile error at the root.
- **Reactive values in JSX.** An atom IS a value: `{count}`, `value={prompt}`.
  Expressions read with `get(...)`: `{get(loading) ? <Spinner /> : <Content />}`
  — the compiler lowers it to `h.reader(() => …)` (an `Atom.readable`), one
  word shared with atom bodies. No `get` → the expression stays static.
- **Errors escalate as values.** `<On value={user} Waiting={…}
Success={(s) => …} Failure={{ NotFound: (e) => … }} />` renders a tagged
  value by tag and BUBBLES any unhandled failure — the residual `E` rides
  `View<E>` to the nearest `Catch`. Works for `Option`, `Result`,
  `AsyncResult`, `Exit`, your own tagged unions.
- **Effect-native error boundary.** `<Catch Failure={(cause, reset) => fallback}>`
  (or `Failure={{ HttpError: … }}` for tag-selective — the same prop shape as
  `On`) recovers the failure side of
  a view subtree, mirroring Effect's `catch*`. `mount` requires every error
  discharged, so a forgotten boundary is a compile error that names the unhandled
  error — the runtime counterpart of a forgotten `Layer`.
- **Effect v4 primitives all the way down.** `Atom`/`AtomRef`/`AtomRegistry`
  from `effect/unstable/reactivity` are the reactivity layer; we don't build
  our own. `AsyncResult` is the loading/success/failure shape.
- **Keyed reactive lists.** `<For each={todos}>{(todo) => <Row item={todo} />}</For>`
  over an `AtomRef.Collection` (rows are refs, keyed by identity) or
  `<For each={users} key={(u) => u.id}>` over any array atom (rows are
  per-key atoms) — adding, removing, or toggling one item never tears down
  the others.
- **Custom file extension.** `.vx` files are compiled by Babel to plain
  TypeScript before `tsc` ever sees them, so TypeScript's JSX type checker
  is never engaged — that's how channels survive instead of collapsing to
  `JSX.Element`.

## Quick start

```bash
git clone … verrex
cd verrex
pnpm install
pnpm dev
# open http://localhost:5173
```

The demo is a guided tour that exercises every primitive — reactive counter,
blocking and `atom`-driven data fetches, dependency-driven refetch, keyed
reactive list, and per-component lifecycle — each with a reset button. It's
also deployed at [m9tdev.github.io/verrex](https://m9tdev.github.io/verrex/).

On Nix, `nix develop` drops you into a shell with Node, Corepack (for
`pnpm` via the `packageManager` field), and Chromium (with `VERREX_CHROMIUM`
pre-exported for the probe scripts).

## Install

```bash
pnpm add @verrex/core effect            # the framework (effect is a peer dependency)
pnpm add -D @verrex/ts-plugin     # editor support for .vx files (see below)
```

`@verrex/core` ships its compiled `dist` alongside the original `src` with declaration
maps, so go-to-definition jumps straight into the framework's TypeScript source.
Releases are cut from conventional commits (release-please) and published to npm
with provenance. It's `0.x` and experimental — expect breaking changes between
minor versions.

## Smallest possible example

```tsx
// Counter.vx
import { AtomRef } from "effect/unstable/reactivity"
import { Component } from "@verrex/core"

export const Counter = Component.make(function* () {
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
import { Effect } from "effect"
import { mount } from "@verrex/core"
import { Counter } from "./Counter.vx"

// `mount` owns its AtomRegistry (created per mount, disposed with the
// mount's scope) — there is no framework layer to provide.
const program = Effect.gen(function* () {
  yield* mount(<Counter />, document.getElementById("root")!)
  yield* Effect.never
}).pipe(Effect.scoped)

Effect.runFork(program)
```

Closing the scope around a mount detaches the DOM and disposes the registry
together, so the UI and its reactivity always die at the same moment.

## Layout

```
packages/
  core/               one package (`@verrex/core`), subpath exports:
    src/runtime/        export `@verrex/core`     — View IR, h(), mount(), atom(), fn(), For, Catch
    src/compiler/       export `@verrex/core/compiler` — .vx → plain TypeScript (Babel)
    src/language/       export `@verrex/core/language` — Volar language plugin
    src/check/          export `@verrex/core/check`, bin `verrex-check`
    src/vite-plugin/    export `@verrex/core/vite`  — Vite integration
    src/testing/        export `@verrex/core/testing`
  ts-plugin/   publishes as `@verrex/ts-plugin` — TS Language Service plugin (editor)
apps/
  demo/               Counter, UserPage, AsyncUserPage, LiveUser, Todos, Lifecycle, CatchDemo, AsyncEscalate
```

## The primitives

| You import from              | What you get                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `@verrex/core`               | `h`, `get`, `mount`, `Component`, `atom`, `fn`, `For`, `On`, `Catch`, `Fragment`, `View` |
| `effect`                     | `Effect`, `Layer`, `Context.Service`, `Data.TaggedError`, `Cause`, `Option`, `Result`, … |
| `effect/unstable/reactivity` | `AtomRef`, `Atom`, `AtomRegistry`, `AsyncResult`                                         |

`h.reader` is compiler-emitted; you never write it by hand. Reactive reads
in JSX are always explicit through `get(...)` — the compiler wraps the
surrounding expression in a reader (an `Atom.readable`) — or by passing the
atom itself as a child/prop.

## Workflow

| Command          | What it does                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server with HMR on `.vx` files                                                                                                         |
| `pnpm typecheck` | Per-package `tsc --noEmit`; apps/demo uses `@verrex/core/check` (.vx-aware)                                                                     |
| `pnpm build`     | Production build via Vite (`@verrex/core/vite` owns the transform)                                                                              |
| `pnpm test`      | All package suites — compiler, runtime, language, vite-plugin, testing, ts-plugin (incl. its tsserver integration probe) + `@verrex/core/check` |

### Developing against a local checkout

If your app references this repo with `"@verrex/core": "link:../verrex/packages/core"`,
the link pulls in verrex's own `node_modules/effect` next to your app's copy. Two
physical `effect` copies break `Context`/`Layer` identity **silently** (a service you
provided reads as missing). Dedupe in both configs:

```ts
// vite.config.ts and vitest.config.ts
export default { resolve: { dedupe: ["effect"] } }
```

Installs from npm do not have this problem — pnpm hoists one `effect`.

## Bundle size

`pnpm build` on the demo produces:

| Asset                    | Raw       | Gzipped      |
| ------------------------ | --------- | ------------ |
| `dist/index.html`        | 11.66 kB  | 3.06 kB      |
| `dist/assets/index-*.js` | 117.45 kB | **39.64 kB** |

The JS bundle contains: `effect@4.0.0-beta.78` runtime (~6 kB gzipped per
upstream docs), `effect/unstable/reactivity` (`AtomRef`, `Atom`,
`AtomRegistry`, `AsyncResult`), the `verrex` runtime (~600 LOC,
contributes single-digit kB), plus all eight demo components (`Counter`,
`UserPage`, `AsyncUserPage`, `LiveUser`, `Todos`, `Lifecycle`, `CatchDemo`,
`AsyncEscalate`), the guided-tour
shell (a small dependency-free TSX highlighter + reactivity-flash visualizer),
and their mock services. Verified interactive after build — Counter increments,
the async demos load then resolve, Todos add/remove/toggle, Lifecycle's
per-row scope fires releases on row removal.

Vite serves `.vx` files directly through `@verrex/core/vite` at dev time;
type-checking goes through `@verrex/core/check`, which feeds `.vx` to tsc as virtual
TypeScript via the shared Volar language plugin. No sibling `.ts` files are
emitted to disk.

## Editor setup

A TypeScript Language Service Plugin (`@verrex/ts-plugin`) ships with the
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
repo root or `pnpm --filter @verrex/ts-plugin build` directly.

**vtsls users need one more setting.** vtsls's _bundled_ tsserver does not
resolve tsconfig `plugins` from the project's `node_modules`, so the plugin
silently never loads and tsc reports raw-JSX errors (`react/jsx-runtime`,
`JSX.IntrinsicElements`). Point it at the workspace TypeScript (or its
plugin search path) — e.g. with nvim-lspconfig:

```lua
require("lspconfig").vtsls.setup({
  settings = {
    vtsls = { autoUseWorkspaceTsdk = true },
    typescript = { tsserver = { pluginPaths = { "./node_modules" } } },
  },
})
```

(Same rule in VS Code: the plugin only loads under the _workspace_ TS
version — hence the instruction below.)

**The plugin must be probe-able from your TypeScript install.** tsserver
resolves tsconfig `plugins` by walking up from its own `typescript.js`, so
in a pnpm workspace the package has to sit at the _root_ `node_modules` —
declaring `@verrex/ts-plugin` only in a sub-package leaves it invisible and
you get the raw-JSX errors above, with no hint why. Declare it as a root
devDependency too (or hoist it).

### VS Code

`@verrex/ts-plugin` is referenced in `apps/demo/tsconfig.json`. Use
"TypeScript: Select TypeScript Version → Use Workspace Version" to make
sure VS Code's TS extension picks up the plugin. `.vx` files get treated
as TypeScript once the plugin loads.

## See also

- [AGENTS.md](./AGENTS.md) — architecture, per-package contracts, invariants, anti-patterns.
- [`apps/demo/src/channels.test-d.ts`](./apps/demo/src/channels.test-d.ts) — compile-time proof that channels propagate and typed props catch misuse.
- [`packages/core/src/runtime/types/Fold.test-d.ts`](./packages/core/src/runtime/types/Fold.test-d.ts) — channel-fold conditional-type test matrix.
