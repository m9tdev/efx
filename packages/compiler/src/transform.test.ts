import { describe, expect, it } from "@effect/vitest"
import { transformEfx } from "./transform.ts"

/** Convenience: just the emitted code, with whitespace normalized so tests
 *  don't break on formatting tweaks from @babel/generator. */
const compile = (src: string): string =>
  transformEfx(src, "test.efx").code.replace(/\s+/g, " ").trim()

describe("JSX → h() rewrites", () => {
  it("intrinsic element with text child", () => {
    expect(compile(`const x = <div>hi</div>`))
      .toContain(`h("div", {}, "hi")`)
  })

  it("intrinsic element with string attr", () => {
    expect(compile(`const x = <div class="page">hi</div>`))
      .toContain(`h("div", { class: "page" }, "hi")`)
  })

  it("intrinsic element with boolean (no-value) attr", () => {
    expect(compile(`const x = <input disabled />`))
      .toContain(`h("input", { disabled: true })`)
  })

  it("intrinsic element with hyphenated attr name", () => {
    expect(compile(`const x = <div data-id="42" />`))
      .toContain(`h("div", { ["data-id"]: "42" })`)
  })

  it("intrinsic element with spread attribute", () => {
    expect(compile(`const x = <div {...props} />`))
      .toMatch(/h\("div",\s*\{\s*\.\.\.props\s*\}\s*\)/)
  })

  it("capitalized tag becomes identifier (component)", () => {
    expect(compile(`const x = <Foo bar={1} />`))
      .toContain(`h(Foo, { bar: 1 })`)
  })

  it("fragment <>...</> uses Fragment identifier", () => {
    expect(compile(`const x = <><span /><span /></>`))
      .toContain(`h(Fragment, {}, h("span", {}), h("span", {}))`)
  })

  it("nested JSX is recursively rewritten", () => {
    const out = compile(`const x = <div><span>a</span></div>`)
    expect(out).toContain(`h("span", {}, "a")`)
    expect(out).toContain(`h("div", {}, h("span"`)
  })

  it("JSX inside `&&` is rewritten", () => {
    expect(compile(`const x = <div>{cond && <p>y</p>}</div>`))
      .toContain(`h("p", {}, "y")`)
  })

  it("JSX inside ternary branches is rewritten", () => {
    const out = compile(`const x = <div>{cond ? <a /> : <b />}</div>`)
    expect(out).toContain(`h("a", {})`)
    expect(out).toContain(`h("b", {})`)
  })

  it("JSX inside .map(...) is rewritten", () => {
    expect(compile(`const x = <ul>{xs.map((x) => <li>{x}</li>)}</ul>`))
      .toContain(`h("li", {},`)
  })
})

describe("tracking-scope rewrites (h.track / h.read / h.peek)", () => {
  it("`.value` reads become h.read(...) and the expression is wrapped in h.track", () => {
    const out = compile(`const x = <div>{ref.value}</div>`)
    expect(out).toContain(`h.read(ref)`)
    expect(out).toContain(`h.track(() =>`)
  })

  it("bare identifier in ternary test becomes h.peek(...) and wraps in h.track", () => {
    const out = compile(`const x = <div>{loading ? <a /> : <b />}</div>`)
    expect(out).toContain(`h.peek(loading)`)
    expect(out).toContain(`h.track(() =>`)
  })

  it("bare identifier in `&&` becomes h.peek and wraps in h.track", () => {
    const out = compile(`const x = <div>{show && <p />}</div>`)
    expect(out).toContain(`h.peek(show)`)
    expect(out).toContain(`h.track(() =>`)
  })

  it("bare identifier under `!` becomes h.peek", () => {
    const out = compile(`const x = <div>{!hidden ? <a /> : <b />}</div>`)
    expect(out).toContain(`h.peek(hidden)`)
  })

  it("static expressions DO NOT get wrapped in h.track", () => {
    // `<Row item={item} />` — `item` is a bare identifier in attribute
    // position; there's no .value read and no test-position rewrite,
    // so wrapping would only strip the static type to `unknown`.
    const out = compile(`const x = <Row item={item} />`)
    expect(out).toContain(`h(Row, { item: item })`)
    expect(out).not.toContain(`h.track`)
  })

  it("static literal attribute values are not wrapped", () => {
    expect(compile(`const x = <Foo n={42} s={"hi"} />`))
      .not.toContain(`h.track`)
  })

  it("`.value` assignment (LHS) is NOT rewritten as a read", () => {
    // We only intercept reads — `obj.value = …` stays as a real assignment.
    expect(compile(`const x = <div>{(ref.value = 1, ref.value)}</div>`))
      .toMatch(/ref\.value = 1/)
  })
})

describe("runtime auto-imports", () => {
  it("adds `import { h } from \"@efx/runtime\"` when JSX is present", () => {
    const out = compile(`const x = <div />`)
    expect(out).toContain(`import { h } from "@efx/runtime"`)
  })

  it("adds `Fragment` too when <>...</> is used", () => {
    const out = compile(`const x = <><span /></>`)
    expect(out).toMatch(/import \{[^}]*Fragment[^}]*\} from "@efx\/runtime"/)
    expect(out).toMatch(/import \{[^}]*h[^}]*\} from "@efx\/runtime"/)
  })

  it("does NOT inject if `h` is already imported under its own name", () => {
    const src = `import { h } from "@efx/runtime"\nconst x = <div />`
    const matches = compile(src).match(/import \{[^}]*\bh\b[^}]*\} from "@efx\/runtime"/g)
    expect(matches?.length).toBe(1)
  })

  it("extends an existing @efx/runtime import instead of adding a new one", () => {
    const src = `import { mount } from "@efx/runtime"\nconst x = <div />`
    const out = compile(src)
    expect(out).toMatch(/import \{[^}]*mount[^}]*h[^}]*\} from "@efx\/runtime"/)
    const importLines = out.split(";").filter((s) => s.includes(`from "@efx/runtime"`))
    expect(importLines.length).toBe(1)
  })

  it("does NOT add runtime import when there's no JSX", () => {
    const out = compile(`const x = 1; const y = 2;`)
    expect(out).not.toContain(`@efx/runtime`)
  })

  it("preserves unrelated imports verbatim", () => {
    const out = compile(`import { Effect } from "effect"\nconst x = <div />`)
    expect(out).toContain(`import { Effect } from "effect"`)
  })
})

describe("TypeScript syntax survives", () => {
  it("type annotations are preserved", () => {
    expect(compile(`const greet = (name: string) => <p>hi {name}</p>`))
      .toContain(`name: string`)
  })

  it("generator functions are preserved", () => {
    expect(compile(`const f = function* () { return <div /> }`))
      .toContain(`function* ()`)
  })

  it("`yield*` survives the rewrite", () => {
    expect(compile(`const f = function* () { yield* effect; return <div /> }`))
      .toContain(`yield* effect`)
  })

  it("type parameters on functions survive", () => {
    expect(compile(`const id = <T,>(x: T): T => { return (<p>{x}</p> as any) as T }`))
      .toMatch(/<T(,)?>/)
  })
})
