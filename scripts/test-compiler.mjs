import { transformVerrex } from "../packages/verrex/src/compiler/index.ts"

const src = `
import { Effect } from "effect"
import { h, Fragment } from "@verrex/core"

export const Demo = (name: string) => Effect.gen(function*() {
  return yield* (
    <div class="page" data-id="x">
      <h1>Hello, {name}!</h1>
      {name && <p>Welcome.</p>}
      <>
        <span>fragment child 1</span>
        <span>fragment child 2</span>
      </>
      <Sub a={1} b={"two"} bool flag={true}>
        nested text
      </Sub>
    </div>
  )
})
`

const { code, map } = transformVerrex(src, "demo.vx")
console.log("=== output ===")
console.log(code)
console.log("=== map keys ===")
console.log(map ? Object.keys(map) : "(no map)")
