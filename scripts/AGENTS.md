# `scripts/` — manual probes + ad-hoc tooling

Scripts here are **not** wired into `pnpm test` or CI. They're run by
hand when verifying that a behavior actually works end-to-end in a
browser, or that the compiler still produces sensible output on a
hand-picked input. They exist because the channel-fold type tests and
unit suites prove the *contracts* but cannot prove "Counter actually
re-renders when you click +".

## Probes (Playwright; require `pnpm dev` running on `:5173`)

| Script | What it verifies |
|---|---|
| `probe.mjs` | Counter increments; UserPage's async fetch resolves; screenshots saved to `/tmp/efx-verify/`. |
| `probe-liveuser.mjs` | `Atom` + `AsyncResult` cycles Initial → Success → Failure → recovery as the user clicks the LiveUser actions. |
| `probe-todos.mjs` | Keyed reactive list: add/remove/toggle a row leaves sibling DOM nodes untouched (tagged-node identity check). |
| `probe-lifecycle.mjs` | Per-component lifecycle scope: `Effect.acquireRelease` inside a row component fires its release when the row is removed. The red-test for `mount`'s per-row `Scope`. |
| `probe-hmr.mjs` | Vite HMR on a `.efx` edit propagates without a full reload. |
| `probe-prod.mjs` | Production bundle (built via `pnpm build`) is interactive end-to-end on port 8765. |

These are the operational definition of "the framework works in a
browser." If you change anything in `mount`, `coerce`, the compiler's
output shape, or the Vite plugin, run the relevant probe before
declaring the change good. Type checks won't catch render-path
regressions.

## Compiler smoke test

| Script | What it does |
|---|---|
| `test-compiler.mjs` | Runs `transformEfx` against an inline source string and prints the compiled output. Useful for "what does the compiler do with X" exploration without writing a vitest case. Not a substitute for `packages/compiler/src/transform.test.ts`. |

## Conventions

- Probes write screenshots to `/tmp/efx-verify/` — convenient for
  visual diffing across runs; not committed.
- Probes use `playwright-core` (devDep at the workspace root) plus a
  hard-coded chromium path that works on the maintainer's NixOS box.
  If you run on a different machine, override `executablePath` at the
  top of the script or use `playwright` (full) instead.
- Don't promote these to `pnpm test` without first wrapping them in a
  process supervisor that starts/stops the dev server. The probes
  assume the server is already up.

## Anti-patterns

- Don't add probes that overlap with what a vitest unit/type test can
  cover. Probes are for the things that have to render in real DOM —
  HMR, per-row Scope teardown, async state cycles, production-bundle
  smoke. Reactivity *logic* belongs in `packages/runtime`'s test
  suite.
- Don't `git add` `/tmp/efx-verify/` screenshots. They're throwaway.
