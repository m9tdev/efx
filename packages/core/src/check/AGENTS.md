# `@verrex/core/check` — standalone type-checker for `.vx` projects

Replaces `tsc --noEmit` for projects with `.vx` files. Wraps
`@volar/kit`'s `createTypeScriptChecker` plus the shared
`@verrex/core/language` plugin, runs in-process, prints tsc-style
diagnostics, exits non-zero on errors.

Used in `apps/demo`'s `typecheck` script. Modeled on Astro's
`astro-check` (see `refs/astro-language-tools/packages/astro-check`).

## Files

| File | Purpose |
|---|---|
| `index.ts` | Programmatic API: `createChecker(options) → VerrexChecker` (persistent, file-event-driven — what `--watch` runs on), `runCheck(options) → CheckResult` (one-shot), `shouldFail(result, severity)` (exit-code policy). Wires the language plugin + `volar-service-typescript` into a kit `TypeScriptChecker`, iterates root files, prints diagnostics at or above `minimumSeverity`. |
| `cli.ts` | CLI entry. `node:util` `parseArgs` (`--tsconfig`, `--root`, `--watch`, `--minimumSeverity`, `--minimumFailingSeverity`, `--preserveWatchOutput`, `--help`; rejects unknown flags and missing/flag-like option values), colored summary line, chokidar wiring for watch mode, exits 0/1/2. |
| `../../test/check/integration.mjs` | Smoke test: known-good fixture → 0 errors; inject broken `.vx` → expect TS2322 with `.vx` source position; cleanup → 0 errors again. Plus: persistent `createChecker` driven by file events (the watch loop's contract), `minimumSeverity` print filtering on a hint-severity suggestion, `shouldFail` threshold cascade. |
| `../../test/check/fixture/` | Minimal `.vx` project (tsconfig + `Good.vx`) used by the smoke test. Self-contained, no cross-file imports — keep it that way. |

## Invocation

Programmatic:

```ts
import { createChecker, runCheck, shouldFail } from "@verrex/core/check"

const result = await runCheck({ cwd: "/path/to/project" })
// result: { filesChecked: number, errors: number, warnings: number, hints: number }
process.exitCode = shouldFail(result, "warning") ? 1 : 0

// Persistent (what --watch uses): one ts.LanguageService across runs,
// file events drive incremental re-checks.
const checker = createChecker({ cwd: "/path/to/project", minimumSeverity: "hint" })
await checker.check()
checker.fileUpdated("/path/to/project/src/Foo.vx") // after an edit
await checker.check({ cancel: () => superseded })  // polled between files

// Watch-facing project topology (what cli.ts builds its watcher from):
checker.getConfigFilePaths()     // tsconfig + extends chain
checker.getWildcardDirectories() // dirs the include globs expand under
checker.getTrackedFileNames()    // all program files seen so far (incl. imports)
```

CLI:

```bash
verrex-check                       # tsconfig auto-discovered from cwd
verrex-check --tsconfig path/tsconfig.json
verrex-check --root /some/project  # cwd override
verrex-check --watch               # incremental re-check on .vx/.ts change
verrex-check --minimumSeverity hint            # print hints + warnings too
verrex-check --minimumFailingSeverity warning  # exit 1 on warnings as well
```

In `apps/demo` the script wires it via `node --experimental-strip-types`
because the workspace ships `.ts` source, not a built CLI. If
`@verrex/core/check` ever gets published, build an emitted CJS for the bin
entry — `apps/demo`'s pattern won't work for external consumers.

## Why kit, not vue-tsc-style tsc-wrapping

Vue's `vue-tsc` monkey-patches `tsc`'s module resolver to inject
its LanguagePlugin and has a retry loop for "extensions changed
mid-run." Astro's `astro-check` does the kit-based approach. Both
work; for this codebase the kit approach is much smaller and
doesn't depend on internal tsc behavior.

The runtime cost is similar: kit's `createTypeScriptChecker`
constructs a real `ts.LanguageService` via Volar's
`createLanguageServiceHost`, then we ask it for diagnostics
per file. The same machinery the editor uses, minus the
LSP protocol.

## Behavior contract

- **Files included**: whatever the resolved tsconfig's `include`
  glob produces, expanded with `extraFileExtensions` (`.vx`
  recognized) — for the demo, its `.vx` sources plus its hand-written
  `.ts` (`channels.test-d.ts`, `flash.ts`, `highlight.ts`, `services.ts`).
- **Diagnostics printed**: controlled by `--minimumSeverity`
  (`error` | `warning` | `hint`, each level including the ones before
  it). Default `error` — the bare invocation stays a drop-in for the
  `tsc --noEmit` flow we replaced. This is a *deliberate divergence*
  from `astro check` (which defaults to `hint`): the flag semantics
  match astro, only the default differs. Severities below the
  threshold are still *counted* in `CheckResult` —
  `volar-service-typescript` maps TS suggestions (e.g. TS6133 unused
  locals) to **hint** severity (LSP 4), so they land in
  `CheckResult.hints`.
- **Exit code**: controlled by `--minimumFailingSeverity`
  (default `error`), astro semantics: each threshold also fails on
  everything more severe. Printing and failing are independent — you
  can print hints without failing on them and vice versa. Usage
  errors exit 2.
- **Watch mode** (`--watch`/`-w`): one `createChecker` instance for
  the process lifetime. chokidar covers **where the program actually
  lives**, not the invocation cwd: the tsconfig's directory plus
  every wildcard directory its include globs expand under (they can
  sit outside it — `"include": ["../shared/**"]`), the config files
  themselves including the `extends` chain (`tsconfig.base.json`
  edits re-parse options), and — added file-by-file after each pass —
  every tracked source the program imported from outside those trees
  (workspace dependencies: editing `packages/core/src/*` re-checks
  the demo, the way `tsc --watch` covers its program closure).
  Ignores match `node_modules`/`.git` by **whole path segment**
  (substring matching would silently kill the watch for e.g. a
  `user.github.io` checkout) and admit the full set of checkable
  extensions (the TS family plus `.vx` — not just the extensions
  present at startup, so a project's first `.tsx` still fires).
  Change/unlink events for files that were never part of the project
  (build output) are skipped without a pass. A watcher `error`
  (EPERM dir, inotify ENOSPC) and a **failing pass** (tsconfig
  briefly missing mid-checkout, a transform crash on an
  unrecoverable mid-edit file) are both reported on stderr and
  watching continues — no unhandled rejection may escape `lint()`.
  Re-checks are debounced 100ms; a superseded pass cancels between
  files and never prints a stale file's diagnostics after its await.
  The screen clear runs after the debounce, only on a TTY, only once
  a previous pass has actually printed (ticket ordinality alone
  would wipe scrollback at startup), and never under
  `--preserveWatchOutput`. Watch mode never exits non-zero on
  diagnostics.
  **Upstream caveat:** `fileUpdated` (every save — the hot path) is
  incremental via kit's project-version bump, but kit's root-file
  re-expansion is broken (`getScriptFileNames` caches resolved names
  in a WeakMap keyed by a `ParsedCommandLine` it mutates in place —
  `@volar/kit` ≤ 2.4.28 and volar main), so create/delete/config
  events mark the project stale and the kit checker is **lazily**
  re-evaluated at the next `check()`/`getRootFileNames()`: a cheap
  config re-parse first, a full rebuild only when the root set or
  options actually changed (build-output churn rebuilds nothing), a
  parse failure keeps the staleness so the next flush retries. If a
  kit release fixes that cache, this can go back to forwarding the
  events.
- **Colors**: the summary line, watch status, and screen clear only
  when stdout is a TTY (and, for color, `NO_COLOR` unset) — a pipe
  gets plain text and never the `\x1bc` reset. Per-diagnostic output
  is colored upstream by `ts.formatDiagnosticsWithColorAndContext`
  unconditionally (kit behavior, pre-existing). The one-shot path
  awaits the final write's flush callback before `process.exit` so
  piped output isn't truncated.
- **In-process isolation**: each `runCheck` call builds its own
  `@volar/kit` checker, which owns the virtual-code lifetime for that
  call. Two calls in the same Node process — e.g. a test that
  exercises the fixture, mutates it, then re-runs — see independent
  virtual-code state, not leftovers from the previous invocation.
  `createChecker` is the deliberate exception: it keeps one checker
  alive so a watch loop pays incremental cost, and *requires* file
  events to observe disk changes — a snapshot is re-read only when
  the project version bumps **and** kit's module-level mtime-keyed
  cache sees a changed `getModifiedTime` (both gates must pass; an
  edit that doesn't tick the mtime — coarse-granularity filesystems,
  `cp -p`/`rsync -t` restores — is invisible until something else
  changes it). This package holds no virtual-code cache of its own:
  it only *writes* (compiles) `.vx` files through the LanguagePlugin
  and never reads them back, so there is nothing here to share or
  leak.

## Coupling

- **`@verrex/core/language`** — provides `createVerrexLanguagePlugin`. The CLI
  instantiates the plugin with `<URI>(uri => uri.fsPath)` because kit
  uses `URI` as its script-id type, and passes
  `onTransformError: "throw"` — a checker must fail loudly on
  unparseable source, never report against the editor-oriented
  last-good fallback (the watch loop catches per-pass). No registry is
  threaded: the kit checker owns the virtual-code lifetime per
  `runCheck` call.
- **`@volar/kit`** — `createTypeScriptChecker`,
  `createTypeScriptInferredChecker` (not currently used; would be
  needed for "no tsconfig" mode).
- **`volar-service-typescript`** — the LSP-style language service
  plugins kit needs to actually produce diagnostics. Without these,
  `linter.check(file)` returns nothing.
- **`chokidar`** — filesystem watcher for `--watch`, imported lazily
  so the one-shot path (CI) never loads it.

## Anti-patterns

- Don't change `--minimumSeverity`'s default away from `error`. The
  replacement flow's expected baseline output is "Checked N files:
  0 errors" — printing warnings/hints by default breaks the
  "drop-in for tsc --noEmit" promise. Opting in is one flag away.
- Don't make the watch loop poll. It's file-event-driven (chokidar →
  `fileCreated/Updated/Deleted`, like astro-check); the debounce in
  `cli.ts` plus between-files cancellation is what keeps rapid saves
  cheap. Don't "fix" the stale-flag lazy rebuild back to forwarding
  create/delete events to kit without checking the upstream
  WeakMap-cache bug is actually fixed (see the watch-mode caveat
  above) — and don't make the rebuild eager again: event bursts
  (git checkout) must cost one rebuild, not N.
- Don't add flags or option types that diverge from Astro's
  `check()` API beyond what's necessary. If you add a flag here,
  mirror the Astro name and semantics (`astro-check`'s `options.ts`
  in `refs/astro-language-tools`) so future code ports cleanly.
- Don't reintroduce on-disk sibling `.ts` files. The whole point
  of `@verrex/core/check` replacing the old `verrex-compile + tsc --noEmit`
  flow is that no auxiliary on-disk shim is needed — `.vx`
  enters the program directly through the language plugin's
  virtual code. If you find yourself emitting `.ts` siblings,
  step back; the resolver works via `extraFileExtensions`
  against explicit `.vx` imports.

## Tests

```
pnpm --filter @verrex/core test
```

Runs `test/check/integration.mjs` with `--experimental-strip-types`.
The test is fast (~1 second) — no tsserver subprocess, just an
in-process `runCheck` call against the fixture directory.

If you change the fixture, make sure it remains self-contained
(no cross-package imports). The fixture must compile-and-check
cleanly with only the workspace `node_modules` resolution path.

## Related context

- Root [`AGENTS.md`](../../../../AGENTS.md) — why `.vx` files never
  reach `tsc` directly.
- [`@verrex/core/language`](../language/AGENTS.md) — the LanguagePlugin
  this package consumes.
- [`apps/demo`](../../../../apps/demo/AGENTS.md) — typecheck script
  wiring.
- `refs/astro-language-tools/packages/astro-check/` — the model.
  `AstroCheck` class in `refs/astro-language-tools/packages/language-server/src/check.ts`
  is the richer surface to grow toward.
