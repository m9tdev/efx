# efx — Effect-native UI framework

**Purpose:** a TypeScript UI framework where Effect's `<A, E, R>`
channels propagate from every leaf of the view tree to the root.
Forgetting to provide a service `Layer` becomes a *compile-time
error that names the missing service*.

Status: experimental proof-of-concept. Not production-ready.

## The constraint that shaped everything

TypeScript's JSX type-checker erases generic type variables at the
JSX boundary — every component result collapses to `JSX.Element`.
React, Solid, Preact all live with this. For a framework where
the *point* is that `E`/`R` channels survive composition, that's
fatal.

So this project deliberately **never lets `tsc` see JSX**:

1. Source files use a custom `.efx` extension.
2. `@efx/compiler` (Babel-based) rewrites every JSX node into an
   `h(tag, props, ...children)` call **before** tsc sees the file.
3. `h()`'s generic signature in `@efx/runtime` uses conditional
   types (`FoldE`/`FoldR`) to union every child's `E` and `R` into
   the result `Effect<View, E, R>`.

Everything else — the `.efx` extension, the Babel choice, the
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

Post-compile, `Counter.efx` is `h("div", { class: "counter" }, ...)`
calls in a `.ts` file. Plain function calls in plain TypeScript.
That's the only thing tsc, Vite, your IDE's type-checker, or any
downstream tool ever sees.

When this AGENTS layer says "JSX expression," "JSX node," or "JSX
child," read it as "the angle-bracket source-code shape that the
compiler eats and converts into `h()` calls." Not the React thing.

## Subsystems (downlinks)

- **[`packages/runtime/`](./packages/runtime/AGENTS.md)** — `h`, `mount`,
  `list`, the View IR (intermediate representation that mount
  switches on), reactivity wiring, channel-fold types. The thing
  components import from.
- **[`packages/compiler/`](./packages/compiler/AGENTS.md)** — the Babel
  transform. Three rewrites: JSX → `h()`, `.value` → `h.read()`,
  bare test-position identifiers → `h.peek()`. Smart-skip wrap.
- **[`packages/ts-plugin/`](./packages/ts-plugin/AGENTS.md)** — Volar-
  based TypeScript Language Service plugin. Delivers diagnostics,
  hover, inlay hints, go-to-def, find-references, and JSX tag-pair
  highlights on `.efx` source. Dual-file setup (`.efx` source +
  on-disk `.ts` for module resolution).
- **[`packages/vite-plugin/`](./packages/vite-plugin/AGENTS.md)** — Vite
  dev integration. Compiles `.efx` on the fly, extends esbuild's
  include glob, rewrites `.efx` URLs with `?import` so strict-MIME
  browsers accept the response.
- **[`apps/demo/`](./apps/demo/AGENTS.md)** — usage patterns by
  primitive (Counter, UserPage, LiveUser, Todos, Lifecycle).
  Also home to `channels.test-d.ts`, the compile-time proof.

## Repository-wide invariants

- **Reactivity is `effect/unstable/reactivity`** — `AtomRef`, `Atom`,
  `AtomRegistry`, `AsyncResult`, `Collection`. We do not ship our
  own signal/atom primitive. If you reach for one, stop and use
  the Effect one.
- **API surface stays minimal.** Don't expose helpers that wrap
  what Effect already provides (no `efxMap`, `efxIf`, etc.).
  Users compose with native Effect combinators.
- **`.efx` files never reach `tsc` directly.** Either the compiler
  has rewritten them to `.ts` first (build, CLI), or a plugin
  intercepts the read and serves compiled content (TS Language
  Service plugin, Vite dev server).
- **Sibling `.ts` files of `.efx` are build artifacts.** Don't
  hand-edit `Counter.ts` when `Counter.efx` exists.
- **`refs/` is reference material for inspiration.** Cloned external
  repos — search here when stuck on design questions or debugging
  integrations. Key references:
  - `effect-smol/` — **Effect v4 internals**, especially
    `effect/unstable/reactivity` (AtomRef, Atom, Collection).
    Search here first for reactivity patterns.
  - `volar/`, `vue-language-tools/` — Volar Language Service plugin
    architecture, reference for `@efx/ts-plugin`.
  - `vite-plugin-svelte/` — mature Vite integration patterns.
  - `solid/` — fine-grained reactivity patterns.
  
  Token budget note: grep for specific symbols rather than loading
  entire directories.

## Tooling at a glance

- pnpm workspace, 6 packages (4 publishable + demo + workspace root).
- Effect v4 / `effect-smol` (currently `effect@4.0.0-beta.70`).
- Vitest — compiler tests use plain `vitest`; runtime channel-fold
  type-tests via `expectTypeOf` at typecheck time.
- Babel as the `.efx` parser (parser + traverse + generate
  directly, no `@babel/preset-*`).
- Volar (`@volar/typescript`, `@volar/language-core`,
  `@volar/source-map`) under the TS plugin for editor integration.
- esbuild to bundle the TS plugin into a single CJS file
  tsserver can `require()`.
- No bundler in the framework itself; consumers bring Vite (or
  whatever) plus the Vite plugin.

## How to verify a change end-to-end

```
pnpm -r test         # compiler tests + ts-plugin integration tests
pnpm -r typecheck    # includes apps/demo (efx:compile → tsc --noEmit)
pnpm --filter @efx/demo dev   # browser-test interactive features
```

UI changes especially require the dev server pass — type checks
catch contract regressions but not "the click handler didn't
re-render."

## Reference docs (outlinks)

- [`DESIGN.md`](./DESIGN.md) — current-state architecture, the
  compiler design, the reactivity model, what we build vs.
  consume, known limits.
- [`docs/plans/ts-language-service.md`](./docs/plans/ts-language-service.md)
  — TS Language Service plugin design notes. Top section
  documents what shipped (Volar-based, Phase 1–4 complete); the
  rest is preserved analysis from before the Volar decision.
- [`README.md`](./README.md) — public-facing intro + editor setup.

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
  reason `.efx` exists.
- Don't add a JSX runtime shim (`jsx-runtime`, automatic JSX,
  etc.). Components are `h()` calls; the compiler is the only
  thing that produces them.
- Don't refactor the runtime to make `h()` accept arbitrary
  generic factories ("pluggable JSX backends"). The fold types
  are tightly coupled to `h`'s exact signature.
- Don't add a state-management layer on top of Effect's
  reactivity primitives. Composition belongs to the user.
