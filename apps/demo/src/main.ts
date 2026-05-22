import { Cause, Effect, Layer } from "effect"
import { EffxLive, h, mount } from "@effx/runtime"
import { Counter } from "./Counter"
import { LiveUser } from "./LiveUser"
import { HttpLive, ThemeLive } from "./services.ts"
import { UserPage } from "./UserPage"

const App = h("div", { class: "app" },
  h("h1", {}, "effx demo — channels through the tree"),
  h("section", { class: "section" },
    h("h2", {}, "Reactive counter (AtomRef)"),
    Counter(),
  ),
  h("section", { class: "section" },
    h("h2", {}, "Async data (Http effect, E + R channels)"),
    UserPage("42"),
  ),
  h("section", { class: "section" },
    h("h2", {}, "Live atom (AsyncResult)"),
    LiveUser(),
  ),
)

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("missing #root")

const program = Effect.gen(function* () {
  yield* mount(App, rootEl)
  // Keep the scope alive so subscriptions and DOM persist for the page's lifetime.
  yield* Effect.never
}).pipe(
  Effect.scoped,
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      console.error("App failed:", Cause.pretty(cause))
    }),
  ),
  Effect.provide(Layer.mergeAll(EffxLive, HttpLive, ThemeLive)),
)

Effect.runFork(program)
