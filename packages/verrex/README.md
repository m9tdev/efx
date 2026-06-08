# verrex

An experimental TypeScript UI framework where Effect's `<A, E, R>` channels
propagate from every leaf of the view tree to the root. Forgetting to provide
a service `Layer` becomes a **compile-time error that names the missing
service**.

The name carries the channels of an `Effect<View, E, R>` — **V** (View, the
`A`), **E** (Error), **R** (Requirements) — plus **X** for the JSX/TSX it
borrows: `V + E + R + X` → **verrex** (and the `.vx` source extension).

> Status: proof-of-concept, `0.x`, not for production. Expect breaking changes
> between minor versions.

## Install

```bash
pnpm add verrex effect            # effect is a peer dependency
pnpm add -D @verrex/ts-plugin     # editor support for .vx files
```

## Example

```tsx
// Counter.vx
import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"

export const Counter = Effect.fn("Counter")(function* (_props: {} = {}) {
  const count = AtomRef.make(0)
  return yield* (
    <div>
      <button onclick={() => count.update((n) => n + 1)}>+</button>
      <span> {count} clicks </span>
    </div>
  )
})
```

## Subpath exports

| Import | What you get |
|---|---|
| `verrex` | `h`, `mount`, `Await`, `list`, `Fragment`, `View`, `VerrexLive` |
| `verrex/vite` | Vite plugin that compiles `.vx` |
| `verrex/check` (+ `verrex-check` bin) | `.vx`-aware type-checker (replaces `tsc --noEmit`) |
| `verrex/compiler`, `verrex/language`, `verrex/testing` | compiler, Volar language plugin, test harness |

`verrex` ships its compiled `dist` alongside the original `src` with
declaration maps, so go-to-definition lands in the framework's TypeScript
source.

Full docs, architecture, and the live demo:
**https://github.com/m9tdev/verrex**

## License

MIT © Mathieu Post
