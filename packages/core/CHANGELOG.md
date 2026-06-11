# Changelog

## [0.2.0](https://github.com/m9tdev/verrex/compare/core-v0.1.0...core-v0.2.0) (2026-06-10)


### ⚠ BREAKING CHANGES

* **core:** mount requires Effect<View<never>, never, R> — every construction and live error must be discharged before mounting.
* **core:** `Await` is removed — use `Async` / `asyncRef`.
* **core:** list()'s render index is now AtomRef.ReadonlyRef<number> (read index.value); it updates on reorder/shift without re-rendering the row.

### Features

* **core:** extract pure keyed-list reconciler; make list index reactive ([#55](https://github.com/m9tdev/verrex/issues/55)) ([8e8c1e9](https://github.com/m9tdev/verrex/commit/8e8c1e96c67c1f9b3f7fdec6f3cf3a5becb28629))
* **core:** replace Await with Async + asyncRef (errors-as-values) ([618e85a](https://github.com/m9tdev/verrex/commit/618e85a08889f37cc83d2f7f912e73d8835d413f))
* **core:** typed error boundaries (Catch) + View&lt;E&gt; mount gate ([4d2d737](https://github.com/m9tdev/verrex/commit/4d2d73794747e11bc77ca2d06421076642051164))
