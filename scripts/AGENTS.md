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
| `probe.mjs` | Counter increments; UserPage's async fetch resolves; screenshots saved to `/tmp/verrex-verify/`. |
| `probe-liveuser.mjs` | Keyed `asyncRef`: clicking the LiveUser buttons changes the trigger `AtomRef`, refetching through Initial → Success → Failure → recovery. |
| `probe-async-userpage.mjs` | Once-form `Async`: the boundary renders a pending placeholder then swaps in the success arm (`.async-user-page .user-body`). Non-blocking counterpart to `probe.mjs`'s in-component UserPage check. |
| `probe-catch.mjs` | Both `Catch` forms in the browser: the catch-all (function) form catching a failing event-handler Effect and recovering on reset; the object tag-map (`{ HttpError }`) form routing a flaky construction failure **and** a live (post-construction) error, with retry re-rolling the request. Prints PASS/FAIL, sets `process.exitCode`. |
| `probe-escalate.mjs` | `Async` open form (no `failure` arm): a failing auto-tracked refetch escalates past the leaf to the page-level `Catch` banner; the controls outside the boundary survive the swap; `retry` after fixing the id recovers. Prints PASS/FAIL, sets `process.exitCode`. |
| `probe-todos.mjs` | Keyed reactive list: add/remove/toggle a row leaves sibling DOM nodes untouched (tagged-node identity check). |
| `probe-lifecycle.mjs` | Per-component lifecycle scope, three phases: (1) initial mount-event count, (2) removing a row fires its matching unmount via `Scope.closeUnsafe`, (3) full teardown via `__teardown` cascades through every row scope so every outstanding mount has a matching unmount. |
| `probe-hmr.mjs` | Vite HMR on a `.vx` edit propagates without a full reload. |
| `probe-prod.mjs` | Production bundle (built via `pnpm build`) is interactive end-to-end on port 8765. |

These are the operational definition of "the framework works in a
browser." If you change anything in `mount`, `coerce`, the compiler's
output shape, or the Vite plugin, run the relevant probe before
declaring the change good. Type checks won't catch render-path
regressions.

## Probe shape: harness + spec

Every probe is split in two:

- **`probe-harness.mjs`** — owns the boilerplate every probe shares:
  chromium launch, context + viewport, the default `pageerror`
  listener, `page.goto(..., { waitUntil: "networkidle" })`, and
  `browser.close()` in a `finally` block. Exports `runProbe({ url,
  viewport, onConsole, onPageError, run })`; returns whatever `run`
  returns so specs can hoist values out for post-close assertions
  (see `probe-lifecycle.mjs`).
- **`probe-*.mjs`** — the **spec**: per-probe assertions inside the
  `run(page, ctx)` callback. Defaults: `url` is
  `http://localhost:5173/`, `viewport` is `900×1100`, `pageerror`
  logs to stderr. Override any per-spec (e.g. `probe-prod.mjs` sets
  `url` from `VERREX_URL`; `probe.mjs` redirects both `onConsole` and
  `onPageError` into a buffer for `/tmp/verrex-verify/console.log`).

The harness does **not** force an exit-code or terminator convention.
Some specs end with `console.log("DONE")`, `probe-lifecycle.mjs`
prints `PASS` / `FAIL`, `probe-hmr.mjs` prints `HMR PASS` / `HMR FAIL`
and `process.exit(0|1)`. The spec decides.

Specs that mutate repo files (e.g. `probe-hmr.mjs` editing
`Counter.vx`) wrap `runProbe` in their own `try/finally` for cleanup.
The harness's `finally` only closes the browser.

## Compiler smoke test

| Script | What it does |
|---|---|
| `test-compiler.mjs` | Runs `transformVerrex` against an inline source string and prints the compiled output. Useful for "what does the compiler do with X" exploration without writing a vitest case. Not a substitute for `packages/core/src/compiler/transform.test.ts`. |

## Conventions

- Probes write screenshots to `/tmp/verrex-verify/` — convenient for
  visual diffing across runs; not committed.
- Probes use `playwright-core` (devDep at the workspace root), which
  does not bundle a browser. Set `VERREX_CHROMIUM` to your Chromium binary
  before running, e.g. `VERREX_CHROMIUM=/usr/bin/chromium node scripts/probe.mjs`.
  Leaving it unset will produce a "browser not found" error from
  `playwright-core`; swap to `playwright` (full) if you prefer a bundled
  browser instead.
- Probes that read repo files (e.g. `probe-hmr.mjs` mutating
  `Counter.vx`) resolve paths relative to the script via
  `import.meta.url`, so they work from any clone or worktree.
- Don't promote these to `pnpm test` without first wrapping them in a
  process supervisor that starts/stops the dev server. The probes
  assume the server is already up.

## Anti-patterns

- Don't add probes that overlap with what a vitest unit/type test can
  cover. Probes are for the things that have to render in real DOM —
  HMR, per-row Scope teardown, async state cycles, production-bundle
  smoke. Reactivity *logic* belongs in `packages/core/src/runtime`'s test
  suite.
- Don't `git add` `/tmp/verrex-verify/` screenshots. They're throwaway.
