import { Context, Data, Effect, Layer } from "effect"

// ─── Errors ──────────────────────────────────────────────────────────────

export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number
  readonly message: string
}> {}

// ─── Domain types ────────────────────────────────────────────────────────

export interface User {
  readonly id: string
  readonly name: string
  readonly bio: string | null
  readonly posts: ReadonlyArray<Post>
}

export interface Post {
  readonly id: string
  readonly title: string
}

// ─── Http service ────────────────────────────────────────────────────────

export class Http extends Context.Service<Http, {
  readonly getUser: (id: string) => Effect.Effect<User, HttpError>
}>()("demo/Http") {}

const usersDb: Record<string, User> = {
  "42": {
    id: "42",
    name: "Ada Lovelace",
    bio: "First computer programmer. Wrote algorithms for Babbage's Analytical Engine.",
    posts: [
      { id: "p1", title: "Notes on the Analytical Engine" },
      { id: "p2", title: "On poetic science" },
      { id: "p3", title: "Sketch of the Analytical Engine, with appendices" },
    ],
  },
  "7": {
    id: "7",
    name: "Grace Hopper",
    bio: null,
    posts: [],
  },
}

export const HttpLive: Layer.Layer<Http> = Layer.succeed(
  Http,
  {
    getUser: (id) =>
      Effect.gen(function* () {
        // Simulate latency — long enough that the loading state is easy to see,
        // especially after hitting a demo's reset button. Kept longer than the
        // reactivity-flash duration (flash.ts) so the flash blips before content.
        yield* Effect.sleep("600 millis")
        const user = usersDb[id]
        if (!user) {
          return yield* new HttpError({ status: 404, message: `User ${id} not found` })
        }
        return user
      }),
  },
)

// ─── Theme service ───────────────────────────────────────────────────────

export class Theme extends Context.Service<Theme, {
  readonly mode: "light" | "dark"
}>()("demo/Theme") {}

export const ThemeLive: Layer.Layer<Theme> = Layer.succeed(Theme, { mode: "dark" })
