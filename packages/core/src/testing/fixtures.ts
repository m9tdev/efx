/**
 * Shared scaffolds for the handler / context-capture suites — test-only,
 * NOT part of the package surface (excluded in tsconfig.build.json, never
 * reaches `dist`; nothing here is exported from `@verrex/core/testing`).
 */
import { Context, Effect, Layer } from "effect"

// ─── Step: the handler-context fixture ────────────────────────────────────
//
// One tiny service for the event-handler / context-capture suites: a handler
// (or row construction) `yield* Step` proves WHICH context it ran on — the
// count moves only if the Layer was reachable from there. Per-test layers
// pick the increment (`stepLayer(7)`), so assertions read as `total: 7`.

export class Step extends Context.Service<Step, { readonly by: number }>()(
  "test/Step",
) {}

export const stepLayer = (by: number) => Layer.succeed(Step, { by })

/** An onclick handler that bumps `count` by the Step service's increment. */
export const stepClick =
  (count: { readonly value: number; set: (n: number) => void }) => () =>
    Effect.gen(function* () {
      const step = yield* Step
      count.set(count.value + step.by)
    })
