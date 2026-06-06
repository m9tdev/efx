import { describe, it, expect } from "vitest"
import { efx } from "./index.ts"

// The plugin's `transform` is authored as a plain method, so it's a function
// at runtime; normalize in case a future Vite shape wraps it in `{ handler }`.
const runTransform = (code: string, id: string) => {
  const hook = efx().transform
  const fn = typeof hook === "function" ? hook : hook!.handler
  return (fn as (c: string, i: string) => unknown).call(
    {} as never,
    code,
    id,
  ) as Promise<{ code: string; map?: { sources: string[] }; moduleType?: string } | null>
}

describe("efx() transform", () => {
  it("rewrites JSX to h() calls and emits plain JavaScript", async () => {
    const out = await runTransform(`
      const v = <div class="x">{1}</div>
    `, "/abs/Test.efx")
    expect(out).not.toBeNull()
    expect(out!.code).toContain('h("div"')
    expect(out!.code).not.toContain("<div") // JSX is gone
    expect(out!.moduleType).toBe("js") // Rolldown skips lang-detection
  })

  it("strips TypeScript types (Oxc step ran)", async () => {
    const out = await runTransform(
      `
      const n: number = 1
      const v = <div>{n}</div>
    `,
      "/abs/Typed.efx",
    )
    expect(out!.code).not.toContain(": number")
  })

  it("returns a source map whose sources point at the original .efx", async () => {
    const out = await runTransform(`
      const v = <div>{1}</div>
    `, "/abs/Counter.efx")
    expect(out!.map).toBeTruthy()
    expect(JSON.stringify(out!.map!.sources)).toContain("Counter.efx")
  })

  it("ignores non-.efx ids", async () => {
    const out = await runTransform(`
      const x = 1
    `, "/abs/plain.ts")
    expect(out).toBeNull()
  })

  it("fails loudly on a real syntax error (errorRecovery: false)", async () => {
    // Build path must not silently ship a recovered/garbage module.
    await expect(
      runTransform(`
        const v = <div>{
      `, "/abs/Broken.efx"),
    ).rejects.toBeTruthy()
  })
})
