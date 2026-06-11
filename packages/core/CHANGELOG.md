# Changelog

## [0.3.0](https://github.com/m9tdev/verrex/compare/core-v0.2.0...core-v0.3.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* **compiler:** lower component tags to direct calls — generics survive, Tag* folds die ([#104](https://github.com/m9tdev/verrex/issues/104))

### Features

* **check:** --watch, severity flags, colored summary (astro-check parity) ([#97](https://github.com/m9tdev/verrex/issues/97)) ([49e13e0](https://github.com/m9tdev/verrex/commit/49e13e0aef36af28175d850ce62268dbefa5db79)), closes [#78](https://github.com/m9tdev/verrex/issues/78)
* **compiler:** lower component tags to direct calls — generics survive, Tag* folds die ([#104](https://github.com/m9tdev/verrex/issues/104)) ([898d1eb](https://github.com/m9tdev/verrex/commit/898d1ebe840c25ec49380a4b67aba9af72fc92f9)), closes [#71](https://github.com/m9tdev/verrex/issues/71)
* **runtime:** Async without failure arm puts E on the live channel ([#86](https://github.com/m9tdev/verrex/issues/86)) ([9e81c7f](https://github.com/m9tdev/verrex/commit/9e81c7f45e375280ad4c1da56f6872da8cdaab3a)), closes [#73](https://github.com/m9tdev/verrex/issues/73)
* **runtime:** AsyncHandle — public refetch for asyncRef, Async accepts handles ([#101](https://github.com/m9tdev/verrex/issues/101)) ([8156fc1](https://github.com/m9tdev/verrex/commit/8156fc1ca8116c4d7aad6164f4a0527157b3ca41))
* **runtime:** Component.make — the canonical component constructor ([#103](https://github.com/m9tdev/verrex/issues/103)) ([8b42741](https://github.com/m9tdev/verrex/commit/8b42741d57980abcd070a50a5abfd5ceb653d2fb)), closes [#70](https://github.com/m9tdev/verrex/issues/70)
* **runtime:** retry callback for Async failure arms ([#95](https://github.com/m9tdev/verrex/issues/95)) ([f30431c](https://github.com/m9tdev/verrex/commit/f30431c67766c72208eb39ab9111c5580d3b52cf))
* **runtime:** tag-selective failure arm for Async (mirrors Catch's tag map) ([#88](https://github.com/m9tdev/verrex/issues/88)) ([1f61c66](https://github.com/m9tdev/verrex/commit/1f61c66000608b00c839cf1035884ed1c1b79a69))


### Bug Fixes

* **language:** survive unparseable mid-edit .vx source ([#102](https://github.com/m9tdev/verrex/issues/102)) ([7529433](https://github.com/m9tdev/verrex/commit/7529433b09bcf5813e0c931a98d20b7db9525cf7))
* **runtime:** reject undispatched tag-map shapes at construction ([#94](https://github.com/m9tdev/verrex/issues/94)) ([d2654ab](https://github.com/m9tdev/verrex/commit/d2654abf6bf7ecfab1eeb16ec313a076403b47e1))

## [0.2.0](https://github.com/m9tdev/verrex/compare/core-v0.1.0...core-v0.2.0) (2026-06-10)


### ⚠ BREAKING CHANGES

* **core:** mount requires Effect<View<never>, never, R> — every construction and live error must be discharged before mounting.
* **core:** `Await` is removed — use `Async` / `asyncRef`.
* **core:** list()'s render index is now AtomRef.ReadonlyRef<number> (read index.value); it updates on reorder/shift without re-rendering the row.

### Features

* **core:** extract pure keyed-list reconciler; make list index reactive ([#55](https://github.com/m9tdev/verrex/issues/55)) ([8e8c1e9](https://github.com/m9tdev/verrex/commit/8e8c1e96c67c1f9b3f7fdec6f3cf3a5becb28629))
* **core:** replace Await with Async + asyncRef (errors-as-values) ([618e85a](https://github.com/m9tdev/verrex/commit/618e85a08889f37cc83d2f7f912e73d8835d413f))
* **core:** typed error boundaries (Catch) + View&lt;E&gt; mount gate ([4d2d737](https://github.com/m9tdev/verrex/commit/4d2d73794747e11bc77ca2d06421076642051164))
