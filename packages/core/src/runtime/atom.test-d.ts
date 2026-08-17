import { describe, expectTypeOf, it } from "vitest"
import { Context, Effect, Scope, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { atom, fn, type Fn } from "./atom.ts"

class Http extends Context.Service<
  Http,
  { readonly get: (id: string) => Effect.Effect<string, HttpError> }
>()("test/Http") {}
class HttpError {
  readonly _tag = "HttpError"
}
type Held = AtomRegistry.AtomRegistry | Scope.Scope

describe("atom / fn — channel pins", () => {
  it("atom(effect): R rides (minus the atom's own), E on the AsyncResult, construction E never", () => {
    const a = atom(Effect.andThen(Http, (h) => h.get("1")))
    expectTypeOf(a).toEqualTypeOf<
      Effect.Effect<
        Atom.Atom<AsyncResult.AsyncResult<string, HttpError>>,
        never,
        Http | Held
      >
    >()
  })

  it("atom((get) => effect): same, deps via get", () => {
    const id = Atom.make("1")
    const a = atom((get) => Effect.andThen(Http, (h) => h.get(get(id))))
    expectTypeOf(a).toEqualTypeOf<
      Effect.Effect<
        Atom.Atom<AsyncResult.AsyncResult<string, HttpError>>,
        never,
        Http | Held
      >
    >()
  })

  it("atom(stream): E gains NoSuchElementError, R rides", () => {
    const s = Stream.fromEffect(Effect.andThen(Http, (h) => h.get("1")))
    const a = atom(s)
    expectTypeOf<Effect.Success<typeof a>>().toEqualTypeOf<
      Atom.Atom<
        AsyncResult.AsyncResult<
          string,
          HttpError | import("effect").Cause.NoSuchElementError
        >
      >
    >()
    expectTypeOf<Effect.Services<typeof a>>().toEqualTypeOf<Http | Held>()
  })

  it("the atom's own Scope | AtomRegistry are excluded from R, the caller's are added back", () => {
    const a = atom(Effect.scope)
    expectTypeOf<Effect.Services<typeof a>>().toEqualTypeOf<Held>()
  })

  it("fn: callable, keeps AtomResultFn identity, R rides", () => {
    const save = fn((u: string) => Effect.andThen(Http, (h) => h.get(u)))
    expectTypeOf(save).toEqualTypeOf<
      Effect.Effect<Fn<string, string, HttpError>, never, Http | Held>
    >()
    type S = Effect.Success<typeof save>
    expectTypeOf<S>().toMatchTypeOf<
      Atom.AtomResultFn<string, string, HttpError>
    >()
    expectTypeOf<ReturnType<S>>().toEqualTypeOf<
      Effect.Effect<void, never, AtomRegistry.AtomRegistry>
    >()
    expectTypeOf<S["interrupt"]>().toEqualTypeOf<
      Effect.Effect<void, never, AtomRegistry.AtomRegistry>
    >()
  })

  it("fn<Arg>() curried form", () => {
    const send = fn<number>()((n) => Effect.succeed(n * 2))
    expectTypeOf(send).toEqualTypeOf<
      Effect.Effect<Fn<number, number, never>, never, Held>
    >()
  })

  it("a missing Layer is a compile error at the root", () => {
    const app = atom(Effect.andThen(Http, (h) => h.get("1")))
    const provided = Effect.provideService(
      app,
      AtomRegistry.AtomRegistry,
      AtomRegistry.make(),
    )
    // @ts-expect-error Http is not provided
    Effect.runPromise(Effect.scoped(provided))
    Effect.runPromise(
      Effect.scoped(
        Effect.provideService(provided, Http, {
          get: () => Effect.succeed("x"),
        }),
      ),
    )
  })
})
