# `verrex/check` — standalone type-checker for `.vx` projects

Replaces `tsc --noEmit` for projects with `.vx` files. Wraps
`@volar/kit`'s `createTypeScriptChecker` plus the shared
`verrex/language` plugin, runs in-process, prints tsc-style
diagnostics, exits non-zero on errors.

Used in `apps/demo`'s `typecheck` script. Modeled on Astro's
`astro-check` (see `refs/astro-language-tools/packages/astro-check`).

## Files

| File | Purpose |
|---|---|
| `index.ts` | Programmatic API: `runCheck(options) → CheckResult`. Wires the language plugin + `volar-service-typescript` into a kit `TypeScriptChecker`, iterates root files, prints diagnostics. |
| `cli.ts` | CLI entry. Minimal argv parser (`--tsconfig`, `--root`, `--help`), calls `runCheck`, prints summary, exits 0/1. |
| `../../test/check/integration.mjs` | Smoke test: known-good fixture → 0 errors; inject broken `.vx` → expect TS2322 with `.vx` source position; cleanup → 0 errors again. |
| `../../test/check/fixture/` | Minimal `.vx` project (tsconfig + `Good.vx`) used by the smoke test. Self-contained, no cross-file imports — keep it that way. |

## Invocation

Programmatic:

```ts
import { runCheck } from "verrex/check"
const result = await runCheck({ cwd: "/path/to/project" })
// result: { filesChecked: number, errors: number, warnings: number }
```

CLI:

```bash
verrex-check                       # tsconfig auto-discovered from cwd
verrex-check --tsconfig path/tsconfig.json
verrex-check --root /some/project  # cwd override
```

In `apps/demo` the script wires it via `node --experimental-strip-types`
because the workspace ships `.ts` source, not a built CLI. If
`verrex/check` ever gets published, build an emitted CJS for the bin
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
  recognized). For demo: 7 `.vx` + 4 hand-written `.ts`
  (`channels.test-d.ts`, `flash.ts`, `highlight.ts`, `services.ts`)
  = 11 files.
- **Diagnostics printed**: errors only by default (matching the
  bare `tsc --noEmit` flow we replaced). Warnings and hints are
  counted in `CheckResult` but not printed — `volar-service-typescript`
  surfaces unused-import suggestions as warnings, and we don't
  want to drown the output with them. Add a `--minimumSeverity`
  flag when the astro-parity TODO ticket comes up.
- **Exit code**: 0 if `result.errors === 0`, else 1. Warnings do
  not fail. (`tsc` matches: warnings only fail with `noEmitOnError`
  or `strict` flags that promote them.)
- **In-process isolation**: each `runCheck` call builds its own
  `@volar/kit` checker, which owns the virtual-code lifetime for that
  call. Two calls in the same Node process — e.g. a test that
  exercises the fixture, mutates it, then re-runs — see independent
  virtual-code state, not leftovers from the previous invocation.
  This package holds no virtual-code cache of its own: it only
  *writes* (compiles) `.vx` files through the LanguagePlugin and
  never reads them back, so there is nothing here to share or leak.

## Coupling

- **`verrex/language`** — provides `createVerrexLanguagePlugin`. The CLI
  instantiates the plugin with `<URI>(uri => uri.fsPath)` because kit
  uses `URI` as its script-id type. No registry is threaded: the kit
  checker owns the virtual-code lifetime per `runCheck` call.
- **`@volar/kit`** — `createTypeScriptChecker`,
  `createTypeScriptInferredChecker` (not currently used; would be
  needed for "no tsconfig" mode).
- **`volar-service-typescript`** — the LSP-style language service
  plugins kit needs to actually produce diagnostics. Without these,
  `linter.check(file)` returns nothing.

## Anti-patterns

- Don't print warnings/hints by default. The replacement flow's
  expected baseline output is "Checked N files: 0 errors" — adding
  warning noise breaks the "drop-in for tsc --noEmit" promise.
  Make it opt-in via a flag when you wire severity filtering.
- Don't add a watch loop that polls. `@volar/kit` exposes
  `fileCreated/Updated/Deleted` callbacks; combine them with
  `chokidar` (like astro-check does) when watch mode is built.
- Don't add `runCheck` overloads or option types that diverge from
  Astro's `check()` API beyond what's necessary. The astro-parity
  TODO list in `cli.ts` is the design intent — if you add a
  flag here, mirror the Astro name and semantics so future code
  ports cleanly.
- Don't reintroduce on-disk sibling `.ts` files. The whole point
  of `verrex/check` replacing the old `verrex-compile + tsc --noEmit`
  flow is that no auxiliary on-disk shim is needed — `.vx`
  enters the program directly through the language plugin's
  virtual code. If you find yourself emitting `.ts` siblings,
  step back; the resolver works via `extraFileExtensions`
  against explicit `.vx` imports.

## Tests

```
pnpm --filter verrex test
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
- [`verrex/language`](../language/AGENTS.md) — the LanguagePlugin
  this package consumes.
- [`apps/demo`](../../../../apps/demo/AGENTS.md) — typecheck script
  wiring.
- `refs/astro-language-tools/packages/astro-check/` — the model.
  `AstroCheck` class in `refs/astro-language-tools/packages/language-server/src/check.ts`
  is the richer surface to grow toward.
