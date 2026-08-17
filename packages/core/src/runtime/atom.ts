import { Cause, Context, Effect, Scope, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"

// `atom` / `fn` — effect-atom's `Atom.make` / `Atom.fn`, with `R` and `E`
// owned by the CALLER (the component). See docs/reactivity-migration.md
// "New public surface". There is no `Atom.runtime(layer)`: the wrapper
// captures the constructing fiber's Context and provides it UNDER the atom's
// own services (`Scope`, `AtomRegistry`, `Scheduler` — `Context.merge(ctx,
// own)`, `own` wins), so an atom-body resource belongs to the atom, not the
// component, while the component's services (and its span, so atom bodies
// trace under it) are visible. `R` therefore stays on the wrapper's type and
// rides to `mount`; a forgotten Layer is a compile error at the root.
//
// Lifetime: the wrapper `Atom.mount`s the atom on the caller's Scope. That is
// what makes teardown cascade — row Scope closes → unmount → refcount 0 →
// registry disposes the node → the atom's own Scope closes (resources
// released, in-flight fibers interrupted) — and what keeps a `fn` used only
// from a handler alive between calls (an unmounted node with no listener is
// disposed on the next dispatcher tick). `@effect/atom-react`'s `useAtomSet`
// mounts for the same reason. Hence `AtomRegistry | Scope` in the result `R`
// (`mount` owns both; nothing leaks past the root).

/** The atom's own services — never captured from the caller. */
type Own = Scope.Scope | AtomRegistry.AtomRegistry
// What the wrapper needs from the caller — a registry to mount in, a Scope to
// release on — is written INLINE in the public overloads (not as a `Held`
// alias): TypeScript keeps alias names in hovers, and `Http | Held` tells a
// user nothing where `Http | AtomRegistry | Scope` does.

// `own` MUST be annotated: unannotated it infers `unknown` and poisons `R`.
const under =
  (ctx: Context.Context<never>) =>
  (own: Context.Context<Own>): Context.Context<Own> =>
    Context.merge(ctx, own)

const provideEffect =
  (ctx: Context.Context<never>) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, Own> =>
    Effect.updateContext(eff as Effect.Effect<A, E, Own>, under(ctx))

// `Atom.make`'s stream overloads pin `R = AtomRegistry` (no Scope); the
// stream still runs with the atom's own services at runtime.
const provideStream =
  (ctx: Context.Context<never>) =>
  <A, E, R>(
    s: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E, AtomRegistry.AtomRegistry> =>
    Stream.updateContext(
      s as Stream.Stream<A, E, Own>,
      under(ctx),
    ) as unknown as Stream.Stream<A, E, AtomRegistry.AtomRegistry>

const mounted = <T extends Atom.Atom<any>>(
  a: T,
): Effect.Effect<T, never, AtomRegistry.AtomRegistry | Scope.Scope> =>
  Effect.as(Atom.mount(a), a)

export interface AtomOptions<A> {
  readonly initialValue?: A | undefined
  readonly uninterruptible?: boolean | undefined
}

/**
 * The state of an Effect (or Stream) as an `Atom<AsyncResult<A, E>>`,
 * effect-atom `Atom.make` with the caller's `R`. Deps via `get(...)`.
 *
 * ```ts
 * const user = yield* atom((get) => http.getUser(get(userId)))
 * ```
 */
export const atom: {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: AtomOptions<A>,
  ): Effect.Effect<
    Atom.Atom<AsyncResult.AsyncResult<A, E>>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
  <A, E, R>(
    create: (get: Atom.AtomContext) => Effect.Effect<A, E, R>,
    options?: AtomOptions<A>,
  ): Effect.Effect<
    Atom.Atom<AsyncResult.AsyncResult<A, E>>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
  <A, E, R>(
    stream: Stream.Stream<A, E, R>,
    options?: { readonly initialValue?: A | undefined },
  ): Effect.Effect<
    Atom.Atom<AsyncResult.AsyncResult<A, E | Cause.NoSuchElementError>>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
  <A, E, R>(
    create: (get: Atom.AtomContext) => Stream.Stream<A, E, R>,
    options?: { readonly initialValue?: A | undefined },
  ): Effect.Effect<
    Atom.Atom<AsyncResult.AsyncResult<A, E | Cause.NoSuchElementError>>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
} = (
  arg:
    | Effect.Effect<any, any, any>
    | Stream.Stream<any, any, any>
    | ((
        get: Atom.AtomContext,
      ) => Effect.Effect<any, any, any> | Stream.Stream<any, any, any>),
  options?: any,
): Effect.Effect<Atom.Atom<any>, never, any> =>
  Effect.flatMap(Effect.context<never>(), (ctx) => {
    // Branch per arg kind — a union argument does not resolve `Atom.make`'s
    // overloads.
    if (Effect.isEffect(arg))
      return mounted(Atom.make(provideEffect(ctx)(arg), options))
    if (Stream.isStream(arg))
      return mounted(Atom.make(provideStream(ctx)(arg), options))
    const create = arg as (
      get: Atom.AtomContext,
    ) => Effect.Effect<any, any, any> | Stream.Stream<any, any, any>
    // `Atom.make`'s create-fn read branches on the returned value at runtime
    // (Effect vs Stream), so one function serves both; the overloads above
    // carry the precise types.
    return mounted(
      Atom.make(
        ((get: Atom.AtomContext) => {
          const r = create(get)
          return Effect.isEffect(r)
            ? provideEffect(ctx)(r)
            : provideStream(ctx)(r)
        }) as (get: Atom.AtomContext) => Effect.Effect<any, any, Own>,
        options,
      ),
    )
  })

export interface FnOptions<A> {
  readonly initialValue?: A | undefined
  readonly concurrent?: boolean | undefined
}

/**
 * The result of {@link fn}: a real `Atom.AtomResultFn` (every effect-atom
 * combinator and `get(send)` work) that is ALSO callable — `send(arg)` runs
 * it. effect-atom's "write the argument to run it" convention reads like a
 * store write at a verrex call site (`Atom.set(send, arg)`), so — like the
 * bindings' `useAtomSet` — we hand back a function.
 *
 * Footgun: Atom combinators (`keepAlive`, `withEquality`, `withLabel`,
 * `setIdleTTL`, …) rebuild the atom via `Object.assign(Object.create(proto),
 * self)` and return a NON-callable; on their result use `Atom.set`.
 */
export interface Fn<Arg, A, E = never> extends Atom.AtomResultFn<Arg, A, E> {
  (arg: Arg): Effect.Effect<void, never, AtomRegistry.AtomRegistry>
  readonly interrupt: Effect.Effect<void, never, AtomRegistry.AtomRegistry>
  readonly reset: Effect.Effect<void, never, AtomRegistry.AtomRegistry>
}

/**
 * The state of a function call as a callable `Atom.AtomResultFn`,
 * effect-atom `Atom.fn` with the caller's `R`.
 *
 * ```ts
 * const save = yield* fn((u: User) => http.save(u))
 * // save(u): Effect<void>; get(save): AsyncResult<void, HttpError>
 * ```
 */
export const fn: {
  <Arg>(): {
    <A, E, R>(
      f: (arg: Arg, get: Atom.FnContext) => Effect.Effect<A, E, R>,
      options?: FnOptions<A>,
    ): Effect.Effect<
      Fn<Arg, A, E>,
      never,
      Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
    >
    <A, E, R>(
      f: (arg: Arg, get: Atom.FnContext) => Stream.Stream<A, E, R>,
      options?: FnOptions<A>,
    ): Effect.Effect<
      Fn<Arg, A, E | Cause.NoSuchElementError>,
      never,
      Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
    >
  }
  <A, E, R, Arg = void>(
    f: (arg: Arg, get: Atom.FnContext) => Effect.Effect<A, E, R>,
    options?: FnOptions<A>,
  ): Effect.Effect<
    Fn<Arg, A, E>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
  <A, E, R, Arg = void>(
    f: (arg: Arg, get: Atom.FnContext) => Stream.Stream<A, E, R>,
    options?: FnOptions<A>,
  ): Effect.Effect<
    Fn<Arg, A, E | Cause.NoSuchElementError>,
    never,
    Exclude<R, Own> | AtomRegistry.AtomRegistry | Scope.Scope
  >
} = function (...args: ReadonlyArray<any>) {
  if (args.length === 0) return makeFn
  return makeFn(args[0], args[1])
} as any

const makeFn = (
  f: (
    arg: any,
    get: Atom.FnContext,
  ) => Effect.Effect<any, any, any> | Stream.Stream<any, any, any>,
  options?: FnOptions<any>,
): Effect.Effect<
  Fn<any, any, any>,
  never,
  AtomRegistry.AtomRegistry | Scope.Scope
> =>
  Effect.flatMap(Effect.context<never>(), (ctx) => {
    const inner = Atom.fn(
      ((arg: any, get: Atom.FnContext) => {
        const r = f(arg, get)
        return Effect.isEffect(r)
          ? provideEffect(ctx)(r)
          : provideStream(ctx)(r)
      }) as (arg: any, get: Atom.FnContext) => Effect.Effect<any, any, Own>,
      options,
    )
    // The callable MUST target ITSELF: `Atom.set(inner, arg)` would create a
    // second registry node (nodes are identity-keyed) and run the body twice.
    const call = ((arg: any) => Atom.set(call, arg)) as unknown as Fn<
      any,
      any,
      any
    > & {
      interrupt: unknown
      reset: unknown
    }
    Object.setPrototypeOf(call, Object.getPrototypeOf(inner))
    Object.assign(call, inner) // own props: keepAlive, lazy, read, write, refresh
    call.interrupt = Atom.set(call, Atom.Interrupt)
    call.reset = Atom.set(call, Atom.Reset)
    return mounted(call)
  })
