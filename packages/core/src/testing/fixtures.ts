/**
 * Shared scaffolds for the Async/asyncRef suites (#98) — test-only, NOT part
 * of the package surface (excluded in tsconfig.build.json, never reaches
 * `dist`; nothing here is exported from `@verrex/core/testing`).
 *
 * `makeUsersFixture(tagPrefix)` returns a FRESH `Users` service per suite — a
 * factory, not module constants, because suites customize the getter (gating,
 * call counting, recovery flips) and a per-suite tag keeps service identity
 * distinct across test files. Build per-test layers over test-local state with
 * `usersWith` (the shape #95 settled on) — never a shared mutable db that can
 * leak between tests.
 */
import { Context, Data, Effect, Layer } from "effect"

/**
 * The two live-channel test errors. Deliberately different shapes — `NotFound`
 * is a `Data.TaggedError`, `Timeout` a plain hand-rolled `_tag` class — because
 * tag maps key on `_tag` alone, and both shapes must keep working.
 */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}
export class Timeout {
  readonly _tag = "Timeout"
}

export type UsersError = NotFound | Timeout

/**
 * The service shape, named so tests can annotate parameters without the
 * factory-local class type in scope (e.g. `(users: UsersService, id: string)`).
 */
export interface UsersService {
  readonly get: (id: string) => Effect.Effect<string, UsersError>
}

// ─── Step: the handler-context fixture (#72) ──────────────────────────────
//
// One tiny service for the event-handler / context-capture suites: a handler
// (or row construction) `yield* Step` proves WHICH context it ran on — the
// count moves only if the Layer was reachable from there. Per-test layers
// pick the increment (`stepLayer(7)`), so assertions read as `total: 7`.

export class Step extends Context.Service<Step, { readonly by: number }>()(
  "test/Step",
) {}

export const stepLayer = (by: number) => Layer.succeed(Step, { by })

/** An onClick handler that bumps `count` by the Step service's increment. */
export const stepClick =
  (count: { readonly value: number; set: (n: number) => void }) => () =>
    Effect.gen(function* () {
      const step = yield* Step
      count.set(count.value + step.by)
    })

const db: Record<string, string> = { "42": "Ada", "7": "Grace" }

/**
 * Poll `selector` until its text reaches `text` (the harness `waitFor` is
 * selector-only, and these suites watch a node whose text changes while the
 * node itself stays mounted).
 *
 * Use it for *awaited* async transitions, whose settle latency varies with
 * machine load — a fixed sleep that passes on an idle machine fails under a
 * loaded one. Assertions that must be exact on a specific tick (a held gate
 * making the outcome deterministic) stay exact; this is only for "eventually".
 */
export const waitForText = async (
  ui: { text(s: string): string },
  text: string,
  selector = ".out",
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (ui.text(selector) !== text) {
    if (Date.now() > deadline)
      throw new Error(
        `waitForText: ${JSON.stringify(selector)} never became ${JSON.stringify(text)} (last: ${JSON.stringify(ui.text(selector))})`,
      )
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

export const makeUsersFixture = (tagPrefix: string) => {
  class Users extends Context.Service<Users, UsersService>()(
    `${tagPrefix}/Users`,
  ) {}

  /** A layer over a custom getter — getters failing with a subset of `UsersError` fit as-is. */
  const usersWith = (get: UsersService["get"]) => Layer.succeed(Users, { get })

  /** The canonical db-backed layer: known ids resolve, "slow" times out, the rest are NotFound. */
  const UsersLive = usersWith((id) =>
    id === "slow"
      ? Effect.fail(new Timeout())
      : db[id]
        ? Effect.succeed(db[id])
        : Effect.fail(new NotFound({ id })),
  )

  return { Users, UsersLive, usersWith }
}
