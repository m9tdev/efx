import { describe, expect, it } from "vitest"
import { transformVerrex } from "./transform.ts"

/** Convenience: just the emitted code, with whitespace normalized so tests
 *  don't break on formatting tweaks from @babel/generator. */
const compile = (src: string): string =>
  transformVerrex(src, "test.vx").code.replace(/\s+/g, " ").trim()

describe("JSX → h() rewrites", () => {
  it("intrinsic element with text child", () => {
    expect(
      compile(`
      const x = <div>hi</div>
    `),
    ).toContain(`h("div", {}, "hi")`)
  })

  it("intrinsic element with string attr", () => {
    expect(
      compile(`
      const x = <div class="page">hi</div>
    `),
    ).toContain(`h("div", { class: "page" }, "hi")`)
  })

  it("intrinsic element with boolean (no-value) attr", () => {
    expect(
      compile(`
      const x = <input disabled />
    `),
    ).toContain(`h("input", { disabled: true })`)
  })

  it("intrinsic element with hyphenated attr name", () => {
    expect(
      compile(`
      const x = <div data-id="42" />
    `),
    ).toContain(`h("div", { ["data-id"]: "42" })`)
  })

  it("intrinsic element with spread attribute", () => {
    expect(
      compile(`
      const x = <div {...props} />
    `),
    ).toMatch(/h\("div",\s*\{\s*\.\.\.props\s*\}\s*\)/)
  })

  it("capitalized tag becomes a direct call (component lowering)", () => {
    expect(
      compile(`
      const x = <Foo bar={1} />
    `),
    ).toContain(`Foo({ bar: 1 })`)
  })

  it("fragment <>...</> uses Fragment identifier", () => {
    expect(
      compile(`
      const x = <><span /><span /></>
    `),
    ).toContain(`Fragment({ children: [h("span", {}), h("span", {})] })`)
  })

  it("nested JSX is recursively rewritten", () => {
    const out = compile(`
      const x = <div><span>a</span></div>
    `)
    expect(out).toContain(`h("span", {}, "a")`)
    expect(out).toContain(`h("div", {}, h("span"`)
  })

  it("JSX inside `&&` is rewritten", () => {
    expect(
      compile(`
      const x = <div>{cond && <p>y</p>}</div>
    `),
    ).toContain(`h("p", {}, "y")`)
  })

  it("JSX inside ternary branches is rewritten", () => {
    const out = compile(`
      const x = <div>{cond ? <a /> : <b />}</div>
    `)
    expect(out).toContain(`h("a", {})`)
    expect(out).toContain(`h("b", {})`)
  })

  it("JSX inside .map(...) is rewritten", () => {
    expect(
      compile(`
      const x = <ul>{xs.map((x) => <li>{x}</li>)}</ul>
    `),
    ).toContain(`h("li", {},`)
  })
})

describe("get(...) reader sugar (docs/reactivity-migration.md)", () => {
  it("wraps a child expression that calls a free get(...) in h.reader((get) => …)", () => {
    const out = compile(`
      const x = <div>{get(count) * 2}</div>
    `)
    expect(out).toContain(`h("div", {}, h.reader(get => get(count) * 2))`)
  })

  it("wraps a non-handler attribute; leaves an on* attribute alone", () => {
    const out = compile(`
      const x = <div class={get(open) ? "a" : "b"} onclick={handler} />
    `)
    expect(out).toContain(`class: h.reader(get => get(open) ? "a" : "b")`)
    expect(out).toContain(`onclick: handler`)
    expect(out).not.toMatch(/onclick: h\.reader/)
  })

  it("leaves an expression with no get(...) untouched (static; type survives)", () => {
    const out = compile(`
      const x = <div>{item}{"hi"}{count + 1}</div>
    `)
    expect(out).toContain(`h("div", {}, item, "hi", count + 1)`)
    expect(out).not.toContain("h.reader")
  })

  it("wraps component children and attrs the same way", () => {
    const out = compile(`
      const x = <Row item={get(x)}>{get(y)}</Row>
    `)
    expect(out).toContain(
      `Row({ item: h.reader(get => get(x)), children: [h.reader(get => get(y))] })`,
    )
  })

  it("nested JSX inside a wrapped expression gets its own reader (inner get is bound by then)", () => {
    const out = compile(`
      const x = <div>{get(open) ? <p>{get(name)}</p> : null}</div>
    `)
    expect(out).toContain(
      `h.reader(get => get(open) ? h("p", {}, h.reader(get => get(name))) : null)`,
    )
  })

  it("does not wrap when get is bound in scope (an atom body's param, a local)", () => {
    const out = compile(`
      const a = atom((get) => <div>{get(x)}</div>)
      const get = () => 1
      const y = <span>{get(z)}</span>
    `)
    expect(out).not.toContain("h.reader")
    expect(out).toContain(`h("div", {}, get(x))`)
    expect(out).toContain(`h("span", {}, get(z))`)
  })

  it("nested-function shadowing inside the expression is respected", () => {
    const out = compile(`
      const x = <div>{items.map((get) => get(1))}</div>
    `)
    expect(out).not.toContain("h.reader")
  })

  it("a free get(...) inside a nested function is a compile error", () => {
    expect(() =>
      compile(`
        const x = <div>{items.map((i) => get(i).name)}</div>
      `),
    ).toThrow(/get\(\.\.\.\) inside a nested function is not reactive/)
    expect(() =>
      compile(`
        const x = <div onclick={() => get(count)} />
      `),
    ).toThrow(/nested function/)
  })

  it("a row arrow rendering JSX is fine: the get lives in the row's own JSX", () => {
    const out = compile(`
      const x = <For each={items} key={(i) => i.id}>{(row) => <li>{get(row).name}</li>}</For>
    `)
    expect(out).toContain(
      `children: [row => h("li", {}, h.reader(get => get(row).name))]`,
    )
  })

  it("type-only wrappers are transparent to the walk", () => {
    const out = compile(`
      const x = <div>{(get(count) as number) satisfies number}</div>
    `)
    expect(out).toContain(
      `h.reader(get => get(count) as number satisfies number)`,
    )
  })

  it("does not rewrite `.value` reads or `.map` calls (no h.read / h.track / list sugar)", () => {
    const out = compile(`
      const x = <ul>{todos.value.map((t) => <li>{t.value.title}</li>)}</ul>
    `)
    expect(out).toContain(`todos.value.map(t => h("li", {}, t.value.title))`)
    expect(out).not.toContain("h.read")
    expect(out).not.toContain("h.track")
    expect(out).not.toContain("list(")
  })
})

describe("runtime auto-imports", () => {
  it('adds `import { h } from "@verrex/core"` when JSX is present', () => {
    const out = compile(`
      const x = <div />
    `)
    expect(out).toContain(`import { h } from "@verrex/core"`)
  })

  it("adds `Fragment` too when <>...</> is used", () => {
    const out = compile(`
      const x = <><span /></>
    `)
    expect(out).toMatch(/import \{[^}]*Fragment[^}]*\} from "@verrex\/core"/)
    expect(out).toMatch(/import \{[^}]*h[^}]*\} from "@verrex\/core"/)
  })

  it("does NOT inject if `h` is already imported under its own name", () => {
    const src = `
      import { h } from "@verrex/core"
      const x = <div />
    `
    const matches = compile(src).match(
      /import \{[^}]*\bh\b[^}]*\} from "@verrex\/core"/g,
    )
    expect(matches?.length).toBe(1)
  })

  it("extends an existing verrex import instead of adding a new one", () => {
    const src = `
      import { mount } from "@verrex/core"
      const x = <div />
    `
    const out = compile(src)
    expect(out).toMatch(/import \{[^}]*mount[^}]*h[^}]*\} from "@verrex\/core"/)
    const importLines = out
      .split(";")
      .filter((s) => s.includes(`from "@verrex/core"`))
    expect(importLines.length).toBe(1)
  })

  it("does NOT add runtime import when there's no JSX", () => {
    const out = compile(`
      const x = 1; const y = 2;
    `)
    expect(out).not.toContain(`verrex`)
  })

  it("preserves unrelated imports verbatim", () => {
    const out = compile(`
      import { Effect } from "effect"
      const x = <div />
    `)
    expect(out).toContain(`import { Effect } from "effect"`)
  })
})

describe("jsxRanges output", () => {
  const ranges = (src: string) => transformVerrex(src, "test.vx").jsxRanges

  const firstElement = (src: string) => {
    const rs = ranges(src)
    const r = rs[0]
    if (!r || r.kind !== "element")
      throw new Error("expected first range to be element")
    return r
  }

  it("single element records its full span and tag name positions", () => {
    const src = `
      const x = <div>hi</div>
    `
    const r = firstElement(src)
    expect(src.slice(r.start, r.end)).toBe(`<div>hi</div>`)
    expect(src.slice(r.openingTag.start, r.openingTag.end)).toBe(`<div>`)
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(`div`)
    expect(r.isSelfClosing).toBe(false)
    const closing = r.closingTag
    if (!closing) throw new Error("expected closingTag")
    expect(src.slice(closing.start, closing.end)).toBe(`</div>`)
    expect(src.slice(closing.nameStart, closing.nameEnd)).toBe(`div`)
  })

  it("self-closing element has no closingTag and isSelfClosing=true", () => {
    const src = `
      const x = <Foo bar={1} />
    `
    const r = firstElement(src)
    expect(r.isSelfClosing).toBe(true)
    expect(r.closingTag).toBeUndefined()
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(`Foo`)
  })

  it("fragment records both <> and </> tag positions, no names", () => {
    const src = `
      const x = <><span /></>
    `
    const frag = ranges(src).find((r) => r.kind === "fragment")
    if (!frag || frag.kind !== "fragment") throw new Error("expected fragment")
    expect(src.slice(frag.openingTag.start, frag.openingTag.end)).toBe(`<>`)
    expect(src.slice(frag.closingTag.start, frag.closingTag.end)).toBe(`</>`)
  })

  it("nested elements emit parent before children in source order", () => {
    const src = `
      const x = <div><span>a</span></div>
    `
    const rs = ranges(src)
    expect(rs.length).toBe(2)
    const [outer, inner] = rs
    if (!outer || !inner) throw new Error("expected two ranges")
    expect(outer.kind).toBe("element")
    expect(inner.kind).toBe("element")
    expect(src.slice(outer.start, outer.end)).toBe(`<div><span>a</span></div>`)
    expect(src.slice(inner.start, inner.end)).toBe(`<span>a</span>`)
  })

  it("dotted member tag name covers the full Foo.Bar span", () => {
    const src = `
      const x = <Foo.Bar />
    `
    const r = firstElement(src)
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(
      `Foo.Bar`,
    )
  })

  it("ranges are empty when there's no JSX", () => {
    expect(
      ranges(`
      const x = 1
    `),
    ).toEqual([])
  })

  it("ternary branches both produce ranges", () => {
    const src = `
      const x = <div>{cond ? <a /> : <b />}</div>
    `
    const tags = ranges(src)
      .filter((r) => r.kind === "element")
      .map((r) => src.slice(r.openingTag.nameStart, r.openingTag.nameEnd))
    expect(tags).toContain("div")
    expect(tags).toContain("a")
    expect(tags).toContain("b")
  })
})

describe("TypeScript syntax survives", () => {
  it("type annotations are preserved", () => {
    expect(
      compile(`
      const greet = (name: string) => <p>hi {name}</p>
    `),
    ).toContain(`name: string`)
  })

  it("generator functions are preserved", () => {
    expect(
      compile(`
      const f = function* () { return <div /> }
    `),
    ).toContain(`function* ()`)
  })

  it("`yield*` survives the rewrite", () => {
    expect(
      compile(`
      const f = function* () { yield* effect; return <div /> }
    `),
    ).toContain(`yield* effect`)
  })

  it("type parameters on functions survive", () => {
    expect(
      compile(`
      const id = <T,>(x: T): T => { return (<p>{x}</p> as any) as T }
    `),
    ).toMatch(/<T(,)?>/)
  })
})

describe("parse-error tolerance (mid-edit source)", () => {
  // The editor calls transformVerrex on every keystroke; mid-edit source is
  // routinely unparseable. Throwing would leave the language plugin without a
  // virtual code, and completion requests would fall back to the project's
  // global scope (999 entries of DOM ambient declarations instead of the
  // expected member list). errorRecovery: true on @babel/parser keeps the AST
  // coming. Note: recovery isn't omnipotent — JSX-interior parse errors like
  // `<div>{x.}</div>` still throw — but the common "type a dot in user code"
  // case works.
  it("does not throw on `obj.` followed by a keyword", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() => transformVerrex(src, "test.vx")).not.toThrow()
  })

  it("emits a recognizable member access for `obj.` recovery", () => {
    // Babel's recovery turns `x.\n\nreturn` into `x.return` (next keyword
    // becomes the property name). The exact property name doesn't matter
    // — what matters is that `x.` lands inside a member-access shape so the
    // source map covers it and tsserver returns members of `x`.
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    const out = compile(src)
    expect(out).toMatch(/x\.\w+/)
  })

  // The build path (verrex/vite) passes `errorRecovery: false` so a real
  // syntax error throws loudly — a Vite overlay in dev, a failed build in CI —
  // instead of the compiler silently recovering and shipping a broken module.
  it("throws on genuinely broken source when errorRecovery is false", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() =>
      transformVerrex(src, "test.vx", { errorRecovery: false }),
    ).toThrow()
  })

  it("still recovers by default (editor path) for the same source", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() => transformVerrex(src, "test.vx")).not.toThrow()
  })
})

describe("JSX text whitespace (cleanJSXElementLiteralChild parity)", () => {
  it("collapses a newline between two words to a single space", () => {
    const src = `const x = <p>a framework whose
      point is honesty</p>`
    expect(compile(src)).toContain(`"a framework whose point is honesty"`)
  })

  it("preserves internal spaces in single-line text", () => {
    expect(compile(`const x = <span> clicks: </span>`)).toContain(
      `h("span", {}, " clicks: ")`,
    )
  })

  it("drops pure-whitespace / blank-line nodes", () => {
    const src = `const x = <div>

      hi

    </div>`
    expect(compile(src)).toContain(`h("div", {}, "hi")`)
  })

  it("trims whitespace adjacent to an element boundary (React parity: a tag on its own line concatenates)", () => {
    const src = `const x = <p>paired
      <code>unmount</code></p>`
    // "paired" carries no trailing space — the source must add {" "} for one,
    // exactly as in React.
    expect(compile(src)).toContain(`"paired"`)
    expect(compile(src)).not.toContain(`"paired "`)
  })

  it('keeps an explicit {" "} spacer between text and an element', () => {
    const src = `const x = <p>use a{" "}
      <code>.vx</code> file</p>`
    expect(compile(src)).toContain(`"use a"`)
    expect(compile(src)).toContain(`" "`)
  })
})

describe("Component.make name injection", () => {
  it("injects the declared name as a second argument", () => {
    const out = compile(`
      export const Counter = Component.make(function* () {
        return yield* <div>hi</div>
      })
    `)
    expect(out).toContain(`Component.make(function*`)
    expect(out).toContain(`, "Counter")`)
  })

  it("injects for a non-exported const too", () => {
    const out = compile(`
      const Local = Component.make(function* () {
        return yield* <div>hi</div>
      })
    `)
    expect(out).toContain(`"Local")`)
  })

  it("leaves an explicitly named call alone", () => {
    const out = compile(`
      export const Counter = Component.make(fn, "Custom")
    `)
    expect(out).toContain(`Component.make(fn, "Custom")`)
    expect(out).not.toContain(`"Counter"`)
  })

  it("does not fire on other Component members or bare make calls", () => {
    const out = compile(`
      const a = Component.makeOther(fn)
      const b = make(fn)
    `)
    expect(out).not.toContain(`"a"`)
    expect(out).not.toContain(`"b"`)
  })

  it("does not fire on an aliased namespace (fails soft, no named span)", () => {
    const out = compile(`
      const Aliased = C.make(fn)
    `)
    expect(out).toContain(`C.make(fn)`)
    expect(out).not.toContain(`"Aliased"`)
  })

  it("does not fire on a destructuring declarator", () => {
    const out = compile(`
      const { x } = Component.make(fn)
    `)
    expect(out).toContain(`Component.make(fn)`)
  })
})

describe("component-tag lowering (direct calls, #71)", () => {
  it("no attrs, no children → zero-arg call (propless components stay callable)", () => {
    expect(compile(`const x = <Counter />`)).toContain(`Counter()`)
  })

  it("children land as a `children` array prop", () => {
    const out = compile(`const x = <Layout><span />hi</Layout>`)
    expect(out).toContain(`Layout({ children: [h("span", {}), "hi"] })`)
  })

  it("attrs and children combine in one props object", () => {
    const out = compile(`const x = <Layout pad={2}><span /></Layout>`)
    expect(out).toContain(`Layout({ pad: 2, children: [h("span", {})] })`)
  })

  it("JSX children override an explicit children attr (React semantics)", () => {
    const out = compile(`const x = <Layout children={old}><span /></Layout>`)
    expect(out).not.toContain(`old`)
    expect(out).toContain(`children: [h("span", {})]`)
  })

  it("member-expression tags lower to direct calls too", () => {
    expect(compile(`const x = <UI.Button label="ok" />`)).toContain(
      `UI.Button({ label: "ok" })`,
    )
  })

  it("spread attrs pass through into the props object", () => {
    expect(compile(`const x = <Foo {...rest} />`)).toContain(`Foo({ ...rest })`)
  })

  it("a component-only file imports no `h` at all", () => {
    const out = compile(`export const x = <Counter />`)
    expect(out).not.toContain(`import`)
  })

  it("a fragment-only file imports Fragment but not h", () => {
    const out = compile(`const x = <>{Counter()}</>`)
    expect(out).toMatch(/import \{ Fragment \} from "@verrex\/core"/)
    expect(out).not.toMatch(/\bh\b[^.]*from/)
  })

  it("intrinsics still route through h (and import it)", () => {
    const out = compile(`const x = <div><Counter /></div>`)
    expect(out).toContain(`h("div", {}, Counter())`)
    expect(out).toMatch(/import \{ h \} from "@verrex\/core"/)
  })

  it("namespaced tags stay string-tagged through h", () => {
    expect(compile(`const x = <svg:rect width="1" />`)).toContain(
      `h("svg:rect", { width: "1" })`,
    )
  })

  it("a spread child expands into the children array (component) and the call args (intrinsic)", () => {
    expect(compile(`const x = <Foo>{...items}</Foo>`)).toContain(
      `Foo({ children: [...items] })`,
    )
    expect(compile(`const y = <div>{...items}</div>`)).toContain(
      `h("div", {}, ...items)`,
    )
  })
})
