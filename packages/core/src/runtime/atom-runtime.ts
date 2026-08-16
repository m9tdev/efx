/**
 * The Atom runtime verrex's effectful primitives (`asyncRef`, `streamRef`,
 * `actionRef`) are built on — and how a plain Effect `Atom` reaches the app's
 * services WITHOUT `Atom.runtime(layer)` baking a Layer in.
 *
 * `Atom.runtime` accepts `(get) => Layer`, so the Layer can be DERIVED FROM AN
 * ATOM — and an atom's value is per-registry state. `mount` owns the registry
 * and, before building the app, publishes its ambient context into
 * `contextAtom` (`registry.set(contextAtom, context)`). `rt`'s layer is then
 * `Layer.succeedContext(thatContext)`: every `rt.atom` / `rt.fn` created inside
 * a component runs with the services the app's root Layer provided — the same
 * instances, one provisioning site — while `AtomRegistry`, `Scope`,
 * `Reactivity` come from the runtime as usual.
 *
 * `rt` is typed `AtomRuntime<any>`: it provides "whatever the mount context
 * has", so `rt.atom(effectNeedingHttp)` compiles WITHOUT a cast — and without
 * a compile-time check that `Http` is provided. Putting `R` back on the channel
 * (so a forgotten Layer is a compile error at `mount`) is exactly what the
 * typed seams `asyncRef` / `streamRef` / `actionRef` add over `rt`: their
 * bodies are `rt.*` calls; their generic signatures are the contribution.
 */
import { Context, Effect, Layer, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"

/** Per-registry state: the mount's ambient context. `mount` sets it. */
export const contextAtom = Atom.make(
  Context.empty() as Context.Context<any>,
).pipe(Atom.keepAlive)

/** The runtime — its Layer is the mount context published into `contextAtom`. */
export const rt: Atom.AtomRuntime<any, never> = Atom.runtime((get) =>
  Layer.succeedContext(get(contextAtom)),
)

/**
 * Mirror an `Atom` into an `AtomRef` for the enclosing scope. Subscribing
 * mounts the atom (its effect/stream starts now — the primitives are eager)
 * and keeps it alive until the scope closes; the ref is what `Async` and
 * `.value` reads consume. Returns the ref plus a `closed` probe (a retained
 * handle must turn into a `false` no-op after teardown). `accept` filters
 * which atom values reach the ref (a rejected value leaves the ref as is;
 * a rejected FIRST value is replaced by `fallback(value)`).
 */
export const mirror = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  scope: Scope.Scope,
  accept: (a: A) => boolean = () => true,
  fallback: (rejected: A) => A = (a) => a,
): Effect.Effect<{
  readonly ref: AtomRef.AtomRef<A>
  readonly closed: () => boolean
}> =>
  Effect.gen(function* () {
    const seed = registry.get(atom)
    const ref = AtomRef.make<A>(accept(seed) ? seed : fallback(seed))
    const unsub = registry.subscribe(atom, (v) => {
      if (accept(v)) ref.set(v)
    })
    let closed = false
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true
        unsub()
      }),
    )
    return { ref, closed: () => closed }
  })
