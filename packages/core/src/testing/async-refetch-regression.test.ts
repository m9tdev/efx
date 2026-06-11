// @vitest-environment happy-dom
/**
 * Regression guards for two `asyncRef` fixes that the auto-refetch tests don't
 * cover (they only assert the *final settled* state, so reverting either fix
 * passes silently). Both tests observe an *intermediate* tick:
 *
 *   SF-1 (stale-while-revalidate): on a refetch, `asyncRef` marks the state
 *   `waitingFrom(some(prior))` — keeping the prior Success mounted — instead of
 *   `initial(true)`, which would flash the view back to the loading arm. We hold
 *   the second fetch pending and assert the prior success content stays mounted.
 *
 *   SF-2 (interrupt-only-cause guard): a run whose effect completes with an
 *   interrupt-only `Cause` must NOT render the failure arm — that cause is
 *   teardown, not a real failure (the guard every other runtime sink applies).
 *   `asyncRef`'s `onFailure` skips `state.set(failure(...))` when
 *   `Cause.hasInterruptsOnly(cause)`. We drive a fetch that resolves to exactly
 *   such a cause and assert the failure arm never appears.
 *
 *   Note: the supervisor supersedes an in-flight run with `Fiber.interrupt`,
 *   which propagates *around* `matchCause` — its `onFailure` is never called on
 *   external interruption, so a plain "supersede a slow failing run" scenario
 *   can't reach the guard. The guard fires only when the run's own effect yields
 *   an interrupt-only cause (a self/sub-fiber interrupt that `matchCause`
 *   catches), which is what this test exercises.
 */
import { describe, expect, it } from "vitest"
import { Effect, Fiber } from "effect"
import { AsyncResult, AtomRef } from "effect/unstable/reactivity"
import { asyncRef, h } from "@verrex/core"
import { render } from "./index.ts"
import { makeUsersFixture, type NotFound, type UsersError, type UsersService } from "./fixtures.ts"

const { Users: Api, usersWith } = makeUsersFixture("refetch")

// A gated Api: each `get(id)` blocks on a per-id promise the test controls, so a
// refetch can be held in-flight while the DOM is inspected at a chosen tick.
const gatedApi = () => {
  const gates = new Map<string, { release: () => void; promise: Promise<void> }>()
  const gate = (id: string) => {
    let entry = gates.get(id)
    if (!entry) {
      let release!: () => void
      const promise = new Promise<void>((r) => { release = r })
      entry = { release, promise }
      gates.set(id, entry)
    }
    return entry
  }
  const layer = usersWith((id) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => gate(id).promise)
      return `user-${id}`
    }),
  )
  return { layer, release: (id: string) => gate(id).release() }
}

// Visually distinguishable arms: loading/initial, success (the value), and a
// failure marker — so "stale success stayed mounted" vs "flashed to loading"
// vs "surfaced a failure" are each observable in the DOM.
const Widget = (
  id: AtomRef.AtomRef<string>,
  get: (api: UsersService, id: string) => Effect.Effect<string, UsersError>,
) =>
  Effect.fn(function* () {
    const api = yield* Api
    const data = yield* asyncRef(() => get(api, h.read(id)))
    return yield* h(
      "div",
      { class: "out" },
      data.state.map((r) =>
        AsyncResult.match(r, {
          onInitial: () => "loading",
          onFailure: () => "error",
          onSuccess: (s) => s.value,
        }),
      ),
    )
  })

const passthrough = (api: UsersService, id: string) => api.get(id)
const settle = () => new Promise<void>((r) => setTimeout(r, 30))

// Poll for `.out` to reach `text` (the harness `waitFor` is selector-only). Used
// for the *awaited* success transitions, whose settle latency varies under load;
// the regression assertions themselves are exact, on a tick where the held gate
// makes the outcome deterministic.
const waitForText = async (
  ui: { text(s: string): string },
  text: string,
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (ui.text(".out") !== text) {
    if (Date.now() > deadline) throw new Error(`waitForText: ".out" never became ${JSON.stringify(text)} (last: ${JSON.stringify(ui.text(".out"))})`)
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

describe("asyncRef refetch — regression guards", () => {
  // SF-1: stale-while-revalidate. With the fix, the prior success stays mounted
  // across the refetch tick. Reverting it (waitingFrom → initial(true)) flashes
  // the view back to "loading", which this test catches.
  it("keeps the prior success mounted across a refetch (no flash to loading)", async () => {
    const api = gatedApi()
    const id = AtomRef.make("1")
    const ui = await render(Widget(id, passthrough)(), api.layer)

    // First fetch: loading → success. (waitFor, not a fixed tick count: the
    // in-process async scheduler's settle latency varies under suite load.)
    expect(ui.text(".out")).toBe("loading")
    api.release("1")
    await waitForText(ui, "user-1")

    // Refetch, but hold the second fetch pending: the refetch tick must NOT
    // flash back to "loading" — the stale "user-1" stays mounted (SWR). The
    // second gate is unreleased, so "user-2" can never appear; settling a few
    // times and asserting it stays "user-1" is a stable negative check.
    id.set("2")
    await settle()
    await settle()
    expect(ui.text(".out")).toBe("user-1") // <-- fails if reverted to initial(true)

    // Releasing the second fetch swaps in the fresh value.
    api.release("2")
    await waitForText(ui, "user-2")
    expect(ui.text(".out")).toBe("user-2")

    await ui.unmount()
  })

  // SF-2: interrupt-only-cause guard. A run whose effect resolves to an
  // interrupt-only cause must NOT render the failure arm. With the guard, the
  // cause is dropped (the view stays on the prior waiting/initial state, i.e.
  // "loading"); removing it surfaces a Failure → "error", which this test
  // catches. (See header note on why external fiber-interrupt can't reach here.)
  it("does not render the failure arm for an interrupt-only cause", async () => {
    const id = AtomRef.make("x")
    // The fetch's own effect completes with an interrupt-only cause: it forks a
    // child, interrupts it, then yields Effect.interrupt — matchCause catches
    // this (unlike external fiber interruption) and routes it to onFailure. The
    // `reached` flag marks that the interrupting step ran, so we only assert
    // once the run has actually reached the failure path (no fixed-tick guess).
    let reached = false
    const selfInterrupt = (): Effect.Effect<string, NotFound> =>
      Effect.gen(function* () {
        const f = yield* Effect.forkChild(Effect.never)
        yield* Fiber.interrupt(f)
        reached = true
        return yield* (Effect.interrupt as Effect.Effect<string, NotFound>)
      })
    const ui = await render(Widget(id, selfInterrupt)(), gatedApi().layer)

    const deadline = Date.now() + 2000
    while (!reached && Date.now() < deadline) await settle()
    expect(reached).toBe(true) // the run hit the interrupt-only path
    await settle() // let onFailure (and any erroneous state.set) flush

    // Guard present → interrupt-only cause dropped → still "loading", never the
    // failure arm. Guard removed → "error".
    expect(ui.text(".out")).not.toBe("error") // <-- fails if interrupt guard removed
    expect(ui.text(".out")).toBe("loading")

    await ui.unmount()
  })
})
