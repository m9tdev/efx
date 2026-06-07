# verrex — Effect-native UI framework

**Purpose:** a TypeScript UI framework where Effect's `<A, E, R>`
channels propagate from every leaf of the view tree to the root.
Forgetting to provide a service `Layer` becomes a *compile-time
error that names the missing service*.

**The name** carries the channels: a component is `Effect<View, E, R>`
(`A` is always the `View`), so `verrex` = **V**iew · **E**rror ·
**R**equirements, plus an **x** for the JSX/TSX it borrows (the `.vx`
extension).

Status: experimental proof-of-concept. Not production-ready.

## The constraint that shaped everything

TypeScript's JSX type-checker erases generic type variables at the
JSX boundary — every component result collapses to `JSX.Element`.
React, Solid, Preact all live with this. For a framework where
the *point* is that `E`/`R` channels survive composition, that's
fatal.

So this project deliberately **never lets `tsc` see JSX**:

1. Source files use a custom `.vx` extension.
2. `verrex/compiler` (Babel-based) rewrites every JSX node into an
   `h(tag, props, ...children)` call **before** tsc sees the file.
3. `h()`'s generic signature in `verrex` uses conditional
   types (`FoldE`/`FoldR`) to union every child's `E` and `R` into
   the result `Effect<View, E, R>`.

Everything else — the `.vx` extension, the Babel choice, the
custom Vite dev server hook, the TS Language Service plugin —
exists to support this constraint.

### "JSX" here means JSX *syntax*, not JSX *semantics*

This is the most important framing for anyone (or any agent)
joining the codebase. **We borrow JSX syntax. We do not use JSX
in any other sense.**

We use:

- The angle-bracket form `<div>...</div>` as a source-code shape.
- Babel's `jsx` parser plugin to recognize that shape.
- Editor / Treesitter JSX highlighting (via `typescriptreact`
  filetype mapping).

We do **not** use:

- A JSX runtime (`jsx-runtime`, `jsx-dev-runtime`,
  `React.createElement`, none of it).
- The `JSX` TypeScript namespace (`JSX.IntrinsicElements`,
  `JSX.Element`). If those names appear in an error message,
  something is wrong — tsc is seeing JSX it shouldn't.
- Any React-shaped library. There is no React, Preact, Solid
  dependency.
- TypeScript's JSX type-checker. It's never engaged because the
  compiler removes the syntax before tsc parses the file.

Post-compile, `Counter.vx` is `h("div", { class: "counter" }, ...)`
calls in a `.ts` file. Plain function calls in plain TypeScript.
That's the only thing tsc, Vite, your IDE's type-checker, or any
downstream tool ever sees.

When this AGENTS layer says "JSX expression," "JSX node," or "JSX
child," read it as "the angle-bracket source-code shape that the
compiler eats and converts into `h()` calls." Not the React thing.

## Subsystems

Everything user-facing ships as one package, **`packages/verrex/`**, with a
subpath export per surface (the subdirs self-reference via `verrex/*`). The
editor plugin is the one separate package, because tsserver resolves Language
Service plugins only by bare package name.

- **[`src/runtime/`](./packages/verrex/src/runtime/AGENTS.md)** — export `verrex`. `h`,
  `mount`, `Await`, `list`, the View IR (mount switches on it), reactivity
  wiring, channel-fold types. The thing components import from.
- **[`src/compiler/`](./packages/verrex/src/compiler/AGENTS.md)** — export
  `verrex/compiler`. The Babel transform: JSX → `h()`, `.value` → `h.read()`,
  `<expr>.value.map(arrow → JSX)` → `list(<expr>, arrow)`. Smart-skip wrap.
- **[`src/language/`](./packages/verrex/src/language/AGENTS.md)** — export
  `verrex/language`. The Volar `LanguagePlugin` describing `.vx` files (file id,
  virtual code, source-map conversion, JSX region tagging). Bridges
  `verrex/compiler` to Volar's contracts; consumed by the ts-plugin and check.
- **[`src/check/`](./packages/verrex/src/check/AGENTS.md)** — export `verrex/check`, bin
  `verrex-check`. Standalone CLI/programmatic type-checker on `@volar/kit` +
  the language plugin. Replaces `tsc --noEmit` for `.vx`.
- **[`src/vite-plugin/`](./packages/verrex/src/vite-plugin/AGENTS.md)** — export
  `verrex/vite`. Owns the full `.vx` compile (Babel JSX→`h()`, then Oxc
  type-strip via `transformWithOxc`, `moduleType: "js"`); rewrites `.vx` URLs
  with `?import` so strict-MIME browsers accept the response.
- **[`src/testing/`](./packages/verrex/src/testing/AGENTS.md)** — export
  `verrex/testing`. In-process component test harness; `render(app, layer?)`
  mounts into a happy-dom DOM and drives it. The `layer` requirement is
  type-enforced so a missing service is a compile error.
- **[`packages/ts-plugin/`](./packages/ts-plugin/AGENTS.md)** (publishes as
  `@verrex/ts-plugin`) — the Volar-based TS Language Service plugin (editor
  integration): JSX tag-pair
  highlights, inlay-hint filtering, reference dedup/sort, native cross-file
  go-to-def. esbuild-bundles `verrex/language` into one CJS file.
- **[`apps/demo/`](./apps/demo/AGENTS.md)** — usage patterns by primitive; home
  to `channels.test-d.ts`, the compile-time proof.
- **[`scripts/`](./scripts/AGENTS.md)** — manual Playwright probes
  (`probe-*.mjs`) for browser behaviors unit/type tests can't reach.

## Repository-wide invariants

- **Reactivity is `effect/unstable/reactivity`** — `AtomRef`, `Atom`,
  `AtomRegistry`, `AsyncResult`, `Collection`. We do not ship our
  own signal/atom primitive. If you reach for one, stop and use
  the Effect one.
- **API surface stays minimal.** Don't expose helpers that wrap
  what Effect already provides (no `verrexMap`, `verrexIf`, etc.).
  Users compose with native Effect combinators. Concretely, what
  we **build** is small: the View IR, `h()` + the fold types,
  `mount`, the Babel transform, the Volar language plugin, the
  Vite plugin. What we **consume** from Effect: `Effect.fn` /
  `Effect.gen` (component shape), `Context.Service` (services),
  `Data.TaggedError` (errors), `Layer` (root provisioning),
  `Scope` (per-row lifecycles), and every reactivity primitive
  (`AtomRef`, `Atom`, `AtomRegistry`, `AsyncResult`,
  `Collection`). If you find yourself building a new wrapper
  alongside Effect, you're probably on the wrong side of this
  line.
- **`.vx` files never reach `tsc` directly.** A plugin always
  intercepts: `verrex/language` (consumed by the TS plugin and by
  `verrex/check`) hands tsc a JSX-free virtual TS buffer, and
  `verrex/vite` does the same for Vite. Source files keep
  their angle brackets; only the compiled buffer is JSX-free.
- **Imports of `.vx` files use the explicit `.vx` extension.**
  `import { X } from "./Foo.vx"` — not `"./Foo"`. TS's resolver
  only tries `extraFileExtensions` against import paths that
  already carry the matching suffix. Same convention as Vue
  (`.vue` in imports) and Astro (`.astro`).
- **Components are named `Effect.fn` functions taking one props
  object.** Write `export const Counter = Effect.fn("Counter")(function* (_props: {} = {}) { … })`,
  not `(props) => Effect.gen(function* () { … })`. The single-prop
  signature is what makes `<Counter />` compile (h's tag-as-function
  path calls `tag(props)`); the named `Effect.fn` wrapper gives the
  resulting Effect a span name in traces and is the v4-recommended
  shape. An empty `_props: {} = {}` default keeps `<Counter />`
  with no attrs valid.
- **`refs/` is reference material for inspiration.** Cloned external
  repos — search here when stuck on design questions or debugging
  integrations. Key references:
  - `effect-smol/` — **Effect v4 internals**, especially
    `effect/unstable/reactivity` (AtomRef, Atom, Collection).
    Search here first for reactivity patterns.
  - `volar/`, `vue-language-tools/` — Volar Language Service plugin
    architecture, reference for `@verrex/ts-plugin`.
  - `vite-plugin-svelte/` — mature Vite integration patterns.
  - `solid/` — fine-grained reactivity patterns.
  
  Token budget note: grep for specific symbols rather than loading
  entire directories.

## Tooling at a glance

- pnpm workspace, 2 packages (`verrex` + `@verrex/ts-plugin`) + demo + workspace root.
- Effect v4 / `effect-smol` (currently `effect@4.0.0-beta.70`).
- Vitest — compiler tests use plain `vitest`; runtime channel-fold
  type-tests via `expectTypeOf` at typecheck time.
- Babel as the `.vx` parser (parser + traverse + generate
  directly, no `@babel/preset-*`).
- Volar (`@volar/typescript`, `@volar/language-core`,
  `@volar/source-map`) under the TS plugin for editor integration.
- esbuild to bundle the TS plugin into a single CJS file
  tsserver can `require()`.
- No bundler in the framework itself; consumers bring Vite (or
  whatever) plus the Vite plugin.
- Nix devshell (`flake.nix`) provides Node, Corepack (which resolves
  pnpm via the `packageManager` field), and Chromium with
  `VERREX_CHROMIUM` pre-exported for the probe scripts.

## How to verify a change end-to-end

```
pnpm -r test         # compiler tests + ts-plugin integration tests
pnpm -r typecheck    # fans out: every package runs `tsc --noEmit`,
                     # apps/demo runs `verrex/check` (the .vx-aware checker)
pnpm --filter verrex-demo dev   # browser-test interactive features
```

UI changes especially require the dev server pass — type checks
catch contract regressions but not "the click handler didn't
re-render."

## Reference docs (outlinks)

- [`README.md`](./README.md) — public-facing intro + editor setup.
- [`docs/intent-layer.md`](./docs/intent-layer.md) — explains the
  AGENTS.md tree itself: what it is, how to capture and maintain it.

## Maintaining the Intent Layer

This repo uses an Intent Layer (the `AGENTS.md` files throughout the
codebase). When you make changes that affect architectural boundaries,
contracts, invariants, or anti-patterns, **update the relevant AGENTS.md
file as part of the same change**.

Signs an AGENTS.md needs updating:
- You added a new invariant or coupling between packages
- You discovered an anti-pattern the hard way
- A section describes behavior that no longer matches the code
- You added a new subsystem that warrants its own node

The root `CLAUDE.md` is a symlink to `AGENTS.md` — no need to maintain both.

## Anti-patterns at the root

- Don't try to make `.tsx` work as a parallel file extension.
  Channels die through tsc's JSX type-checker — that's the whole
  reason `.vx` exists.
- Don't add a JSX runtime shim (`jsx-runtime`, automatic JSX,
  etc.). Components are `h()` calls; the compiler is the only
  thing that produces them.
- Don't refactor the runtime to make `h()` accept arbitrary
  generic factories ("pluggable JSX backends"). The fold types
  are tightly coupled to `h`'s exact signature.
- Don't add a state-management layer on top of Effect's
  reactivity primitives. Composition belongs to the user.
