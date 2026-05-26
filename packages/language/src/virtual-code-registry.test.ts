import { describe, expect, it } from "vitest"
import type { CodegenContext } from "@volar/language-core"
import type * as ts from "typescript"
import { createEfxLanguagePlugin } from "./language-plugin.ts"
import { VirtualCodeRegistry } from "./virtual-code.ts"

/**
 * Concurrency regression: two independent consumers of the LanguagePlugin
 * (e.g. two `runCheck` calls in one Node process) must see only their own
 * virtual codes. With the previous module-level Map cache, the second
 * consumer would observe entries created by the first.
 */

const snapshotOf = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

// The plugin's createVirtualCode doesn't consult the ctx — we never call
// getAssociatedScript — so a stub is fine here. Tests don't run inside Volar.
const stubCtx: CodegenContext<string> = {
  getAssociatedScript: () => undefined,
}

const buildVC = (
  plugin: ReturnType<typeof createEfxLanguagePlugin<string>>,
  fileName: string,
  source: string,
) => {
  const create = plugin.createVirtualCode
  if (!create) throw new Error("plugin.createVirtualCode missing")
  return create(fileName, "efx", snapshotOf(source), stubCtx)
}

describe("VirtualCodeRegistry isolation", () => {
  it("two plugins with separate registries do not see each other's virtual codes", () => {
    const registryA = new VirtualCodeRegistry()
    const registryB = new VirtualCodeRegistry()
    const pluginA = createEfxLanguagePlugin<string>((s) => s, registryA)
    const pluginB = createEfxLanguagePlugin<string>((s) => s, registryB)

    const aPath = "/proj-a/Counter.efx"
    const bPath = "/proj-b/Other.efx"

    const vcA = buildVC(pluginA, aPath, "const x = <div/>")
    const vcB = buildVC(pluginB, bPath, "const y = <span/>")

    expect(vcA).toBeDefined()
    expect(vcB).toBeDefined()

    expect(registryA.get(aPath)).toBe(vcA)
    expect(registryB.get(bPath)).toBe(vcB)
    expect(registryA.get(bPath)).toBeUndefined()
    expect(registryB.get(aPath)).toBeUndefined()
  })

  it("a registry returns the same instance Volar received from createVirtualCode", () => {
    const registry = new VirtualCodeRegistry()
    const plugin = createEfxLanguagePlugin<string>((s) => s, registry)
    const fileName = "/proj/Counter.efx"

    const vc = buildVC(plugin, fileName, "const x = <div/>")
    expect(vc).toBeDefined()
    expect(registry.get(fileName)).toBe(vc)
  })
})
