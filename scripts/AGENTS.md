# `scripts/` — manual probes + ad-hoc tooling

Most scripts here are **not** wired into `pnpm test` or CI. They're run
by hand when verifying that a behavior actually works end-to-end in a
browser, or that the compiler still produces sensible output on a
hand-picked input. They exist because the channel-fold type tests and
unit suites prove the _contracts_ but cannot prove "Counter actually
re-renders when you click +".

The one exception is [`vx-oxc.mjs`](#vx-oxcmjs--linting-and-formatting-vx),
which **is** wired into `pnpm lint` / `pnpm format` and therefore CI. It
lives here rather than in a package because it is repo tooling, not
shipped code.

## Probes (Playwright; require `pnpm dev` running on `:5173`)

| Script                     | What it verifies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe.mjs`                | Counter increments; UserPage's async fetch resolves; screenshots saved to `/tmp/verrex-verify/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `probe-liveuser.mjs`       | Dependent `atom`: clicking the LiveUser buttons `Atom.set` the `userId` atom the create fn reads with `get(userId)`, refetching through Initial → Success → Failure → recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `probe-async-userpage.mjs` | Once-form `atom` + `<On value={user}>`: renders the `Waiting` arm then swaps in the `Success` arm (`.async-user-page .user-body`). Non-blocking counterpart to `probe.mjs`'s in-component UserPage check.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `probe-catch.mjs`          | Both `Catch` arm kinds in the browser: the catch-all `Failure` arm catching a failing event-handler Effect and recovering on reset; the tag arm (`HttpError={…}`) routing a flaky construction failure **and** a live (post-construction) error, with retry re-rolling the request. Prints PASS/FAIL, sets `process.exitCode`.                                                                                                                                                                                                                                                                                   |
| `probe-escalate.mjs`       | `atom` failure homes, both step-08 blocks: a leaf-handled `HttpError` (an `HttpError` arm on `On`) renders in place (page tag-arm boundary untouched) while the SAME failure escalates the open block (no failure arm) to its catch-all banner; the leaf-handled atom recovers on a dep change with no reset while the open form needs its boundary's refresh+reset; leaf `retry` (`Atom.refresh`) shows the waiting arm then re-fails retryable; an unhandled `RateLimited` rides the residual to the page tag arm (unwrapped payload); controls survive every swap. Prints PASS/FAIL, sets `process.exitCode`. |
| `probe-todos.mjs`          | Keyed reactive list: add/remove/toggle a row leaves sibling DOM nodes untouched (tagged-node identity check).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `probe-lifecycle.mjs`      | Per-component lifecycle scope, three phases: (1) initial mount-event count, (2) removing a row fires its matching unmount via `Scope.closeUnsafe`, (3) full teardown via `__teardown` cascades through every row scope so every outstanding mount has a matching unmount.                                                                                                                                                                                                                                                                                                                                        |
| `probe-savebutton.mjs`     | The pending → run → settle pattern as `fn` in a real event loop, three phases: (1) click save — the waiting state swaps the button for a spinner, then the call completes past the 600ms await (button returns, `saved` = 1); (2) save (fails) — the escalated HttpError reaches the Catch; (3) ↻ reset while saving — closing the component scope interrupts the in-flight call, no stale write lands in the fresh instance. Prints PASS/FAIL, exits 1 on failure.                                                                                                                                              |
| `probe-hmr.mjs`            | Vite HMR on a `.vx` edit propagates without a full reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `probe-prod.mjs`           | Production bundle (built via `pnpm build`) is interactive end-to-end on port 8765.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

| Script              | What it does                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-compiler.mjs` | Runs `transformVerrex` against an inline source string and prints the compiled output. Useful for "what does the compiler do with X" exploration without writing a vitest case. Not a substitute for `packages/core/src/compiler/transform.test.ts`. |

## `vx-oxc.mjs` — linting and formatting `.vx`

`pnpm lint`, `pnpm lint:fix`, `pnpm format` and `pnpm format:check` each
run their tool twice: once directly (for `.ts`/`.mjs`/`.md`/…) and once
through this script (for `.vx`). Keep those in step — a script that
covers `.vx` in `lint` but not `lint:fix` reports errors it can't fix.

Neither tool can be taught about `.vx`. The extension→language map is
hardcoded in Rust (`oxc_span`'s `VALID_EXTENSIONS`) ahead of any
user-facing extension point: oxlint's JS plugin API takes `{ meta, rules }`
only — no ESLint-style `processors` — and oxfmt has no plugin system at
all. Passing a `.vx` path to either is silently a no-op, not an error.

So the script mirrors each `.vx` into a shadow tree of `.tsx` symlinks
under `node_modules/.cache/vx-shadow`, runs the tool against those, then
rewrites the paths in the output back to `.vx` so diagnostics stay
clickable. Both write modes — `oxlint --fix` and `oxfmt` — edit through
the symlink, so their rewrites land in the real source. `.vx` is exactly TypeScript + JSX, so the tsx parser is the
correct reader. oxfmt writes _through_ the symlink, so formatting lands
in the real source file.

Two constraints that are easy to break:

- **Pass explicit file paths, never the shadow directory.** Both tools
  apply `.gitignore` to directory arguments and the shadow lives under
  `node_modules/`, so a directory argument silently matches zero files
  ("Expected at least one target file") — which reads as success.
- **Run from the repo root**, so `.oxlintrc.json` / `.oxfmtrc.json`
  resolve.

Formatting `.vx` reflows JSX, which can split a text child around a line
break — `an <a>` becomes `an{" "}` + `<a>`, compiling to `"an", " "`
instead of `"an "`. Two adjacent text nodes, same rendered output; the
idiom already appears by hand in `main.vx`. Both oxfmt and Prettier do
this. It is the only compile-output change formatting has produced.

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
  smoke. Reactivity _logic_ belongs in `packages/core/src/runtime`'s test
  suite.
- Don't `git add` `/tmp/verrex-verify/` screenshots. They're throwaway.
- Don't enable oxlint's `react` / `jsx-a11y` plugins. `vx-oxc.mjs` lints
  `.vx` as TSX, so those would apply React _semantics_ to syntax that has
  none (see the root AGENTS.md). The current config — correctness-only,
  no React plugins — is what keeps that borrowing safe.

## Related context

- [`apps/demo`](../apps/demo/AGENTS.md) — the app every probe drives;
  its table says which component each probe exercises.
- [`@verrex/core/testing`](../packages/core/src/testing/AGENTS.md) — the
  in-process harness; prefer it for anything that doesn't need a real
  browser (HMR, production bundles, real-DOM teardown stay here).
