import { Cause, Effect, Exit, Layer, Scope } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { VerrexLive, mount, type View } from "@verrex/core"

/**
 * Services the harness provides for you: the `AtomRegistry` (via `VerrexLive`)
 * and the ambient `Scope` (held open across interaction, closed on `unmount`).
 * Everything else a component requires is `R` you must satisfy with `layer` —
 * if you forget one, `render` fails to type-check. That's deliberate: the
 * harness must NOT swallow the `E`/`R` channels, or it would defeat the whole
 * point of verrex at the test site.
 */
type Injected = AtomRegistry.AtomRegistry | Scope.Scope

/** The component requirements you must provide — everything except what the harness injects. */
type Required<R> = Exclude<R, Injected>

/** Handle to a mounted component: query the DOM, fire events, settle async, tear down. */
export interface RenderResult {
  /** The container the component was mounted into (attached to `document.body`). */
  readonly container: HTMLElement
  /** First match for `selector`, or throw if none (use when you expect it to exist). */
  get(selector: string): HTMLElement
  /** First match for `selector`, or `null`. */
  query(selector: string): HTMLElement | null
  /** All matches for `selector`. */
  all(selector: string): HTMLElement[]
  /** Trimmed `textContent` of the first match (or the container when `selector` is omitted). */
  text(selector?: string): string
  /** Dispatch a bubbling `click` at the first match — fires the component's `onclick`. */
  click(selector: string): void
  /** Dispatch a bubbling event of `type` at the first match (e.g. `"input"`, `"submit"`). */
  fire(selector: string, type: string): void
  /** Flush microtasks + one macrotask so async/atom-driven updates settle. */
  tick(): Promise<void>
  /**
   * Poll until `selector` matches (or `timeoutMs` elapses, then throw). Use for
   * async-driven updates whose exact settle-tick count is nondeterministic
   * (e.g. an `Atom`/`AsyncResult` flushing through the registry's async
   * scheduler), instead of guessing a fixed number of `tick()`s.
   */
  waitFor(selector: string, timeoutMs?: number): Promise<HTMLElement>
  /** Close the scope (firing every finalizer) and detach the container. */
  unmount(): Promise<void>
}

const el = (container: HTMLElement, selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  if (!found) throw new Error(`render(): no element matches ${JSON.stringify(selector)}`)
  return found as HTMLElement
}

/**
 * Mount a component into an in-process DOM and return a handle to drive it.
 *
 * `app` is a component result — `Component(props)`, what a component tag
 * compiles to since #71 — i.e. an `Effect<View, E, R>`. Provide a `layer` covering every service the
 * component needs (the harness adds `AtomRegistry` + `Scope`); omit it only
 * when the component requires nothing else. A missing service is a compile
 * error, exactly as it would be at a real `mount`.
 *
 * ```ts
 * const ui = await render(UserPage({ userId: "42" }), Layer.mergeAll(HttpTest, ThemeTest))
 * expect(ui.text(".user-card strong")).toBe("Ada Lovelace")
 * await ui.unmount()
 * ```
 */
export const render = <E, R>(
  app: Effect.Effect<View, E, R>,
  ...rest: [Required<R>] extends [never]
    ? [layer?: Layer.Layer<never>]
    : [layer: Layer.Layer<Required<R>>]
): Promise<RenderResult> => {
  const layer = (rest[0] ?? Layer.empty) as Layer.Layer<never>
  return renderImpl(app as Effect.Effect<View, unknown, never>, layer)
}

const renderImpl = async (
  app: Effect.Effect<View, unknown, never>,
  layer: Layer.Layer<never>,
): Promise<RenderResult> => {
  const container = document.createElement("div")
  document.body.appendChild(container)

  // A Closeable scope we own: mount registers every subscription/listener/
  // release finalizer on it, and we keep it open until unmount().
  const scope = Scope.makeUnsafe()
  // `mount` requires a discharged app (`Effect<View<never>, never, R>`). The
  // harness discharges an undischarged construction error by turning it into a
  // defect, so a component that fails to build (with no boundary) rejects the
  // `render(...)` promise loudly — exactly the failure a test wants to see.
  const discharged = Effect.catchCause(app, (cause) => Effect.die(Cause.squash(cause)))
  await Effect.runPromise(
    Scope.provide(
      mount(discharged, container).pipe(Effect.provide(layer), Effect.provide(VerrexLive)),
      scope,
    ),
  )

  return {
    container,
    get: (s) => el(container, s),
    query: (s) => container.querySelector(s) as HTMLElement | null,
    all: (s) => Array.from(container.querySelectorAll(s)) as HTMLElement[],
    text: (s) => (s ? el(container, s) : container).textContent?.trim() ?? "",
    click: (s) => {
      el(container, s).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    },
    fire: (s, type) => {
      el(container, s).dispatchEvent(new Event(type, { bubbles: true }))
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    waitFor: async (selector, timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = container.querySelector(selector) as HTMLElement | null
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(
            `waitFor(): ${JSON.stringify(selector)} did not appear within ${timeoutMs}ms. ` +
              `Container: ${container.innerHTML}`,
          )
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    },
    unmount: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      container.remove()
    },
  }
}
