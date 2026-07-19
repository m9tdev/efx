# Releasing

Two packages publish to npm — **`@verrex/core`** and **`@verrex/ts-plugin`** —
driven by conventional commits via release-please
(`release-please-config.json` + `.release-please-manifest.json`,
`.github/workflows/release.yml`). On every push to `main`, release-please
opens/updates one **Release PR per package**, titled with the version it
releases; merging one tags that release and the publish job pushes just
that package to npm.

- **A commit bumps a package by the path of the files it changes, not by the
  commit scope** (the invariant also stated in the root
  [`AGENTS.md`](../AGENTS.md)). Files under `packages/core/**` bump
  `@verrex/core`; files under `packages/ts-plugin/**` bump
  `@verrex/ts-plugin`; a commit spanning both bumps both; a commit touching
  neither (root, `apps/demo/`, `.github/`, docs) releases nothing. The
  `(scope)` in `feat(compiler):` is changelog-cosmetic only.
- **Versions are independent** (no linked-versions plugin) — each package
  bumps off its own commits and carries its own CHANGELOG + tag
  (`core-v…`, `ts-plugin-v…` — release-please's node strategy strips the
  npm scope from tag names; a scoped tag like `@verrex/core-v0.1.0` is
  invisible to it and breaks changelog anchoring).
- **Still pre-1.0:** `bump-minor-pre-major` + `bump-patch-for-minor-pre-major`
  keep `feat`→minor / `fix`→patch _within_ 0.x until you cut a 1.0.
- **Tokenless publish:** OIDC trusted publishing, no `NPM_TOKEN`. Provenance is
  turned on by the `--provenance` flag in `release.yml` (deliberately _not_ in
  `publishConfig`, so a one-time local bootstrap publish doesn't try to attest
  outside CI and fail). Requires a Trusted Publisher (this repo + `release.yml`)
  configured per package at npmjs.com. `minimumReleaseAge` still applies to
  _our_ installs — never bypass it.
- **First publish (bootstrap):** trusted publishing needs the package to exist
  on npm first, so the very first version of each package is published manually
  (`pnpm --filter <pkg> publish --access public`) — no provenance on that one.
  Configure the Trusted Publisher afterward; every release from then on is
  tokenless CI with provenance.
- **go-to-definition lands in source.** Each publishable package keeps its
  dev `exports` pointing at `src/*` (what the workspace and editors resolve,
  so go-to-def jumps into `.ts`), and a `publishConfig.exports` override
  repoints every subpath to `dist/*` at publish time. The tarball ships
  **both** `dist` and `src` plus declaration maps (`declarationMap` +
  `sourceMap`), so a consumer's go-to-def resolves through `.d.ts.map` into the
  shipped `.ts`. `@verrex/core` builds via `tsc -p tsconfig.build.json`
  (`rewriteRelativeImportExtensions` turns `./x.ts` imports into `./x.js`);
  `@verrex/ts-plugin` is the esbuild bundle (`dist/index.cjs`), so it ships
  `dist` only.
