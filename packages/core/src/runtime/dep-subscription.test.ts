import { describe, expect, it } from "@effect/vitest"
import { AtomRef } from "effect/unstable/reactivity"
import { makeDepSubscription } from "./coerce.ts"

describe("makeDepSubscription", () => {
  it("fires onChange when a subscribed dep changes", () => {
    const ref = AtomRef.make(0)
    let fired = 0
    const sub = makeDepSubscription(() => fired++)
    sub.resubscribe([ref])
    ref.set(1)
    expect(fired).toBe(1)
  })

  it("drops prior subscriptions on resubscribe (fresh deps per run)", () => {
    const a = AtomRef.make(0)
    const b = AtomRef.make(0)
    let fired = 0
    const sub = makeDepSubscription(() => fired++)
    sub.resubscribe([a])
    sub.resubscribe([b]) // a's subscription must be dropped
    a.set(1)
    expect(fired).toBe(0)
    b.set(1)
    expect(fired).toBe(1)
  })

  it("dispose unsubscribes all and flips closed; resubscribe is then a no-op", () => {
    const ref = AtomRef.make(0)
    let fired = 0
    const sub = makeDepSubscription(() => fired++)
    sub.resubscribe([ref])
    sub.dispose()
    expect(sub.closed).toBe(true)
    ref.set(1)
    expect(fired).toBe(0)
    sub.resubscribe([ref]) // inert after dispose
    ref.set(2)
    expect(fired).toBe(0)
  })
})
