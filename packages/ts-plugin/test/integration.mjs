#!/usr/bin/env node
/**
 * tsserver test harness for @efx/ts-plugin
 *
 * Spawns tsserver, opens the demo project, requests diagnostics for an .efx
 * file, and verifies that:
 * 1. The virtual .efx.tsx file is recognized
 * 2. No JSX namespace errors appear (the plugin compiled the .efx correctly)
 */
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "../../..")
const demoRoot = join(repoRoot, "apps/demo")
const servicesTs = join(demoRoot, "src/services.ts")
const counterEfx = join(demoRoot, "src/Counter.efx")

class TsServerClient {
  constructor() {
    this.seq = 0
    this.pending = new Map()
    this.events = []
    this.tsserver = null
    this.rl = null
  }

  start() {
    return new Promise((resolve, reject) => {
      const tsserverPath = join(repoRoot, "node_modules/typescript/lib/tsserver.js")
      this.tsserver = spawn("node", [tsserverPath, "--useInferredProjectPerProjectRoot"], {
        cwd: demoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          TSS_LOG: "-level verbose",
        },
      })

      this.rl = createInterface({ input: this.tsserver.stdout })
      this.rl.on("line", (line) => this.handleLine(line))

      this.tsserver.stderr.on("data", (data) => {
        const msg = data.toString()
        // Show relevant stderr for debugging
        for (const line of msg.trim().split("\n")) {
          if (line.includes("[efx]") || line.includes("plugin") || line.includes("Error")) {
            console.log("[stderr]", line)
          }
        }
      })

      this.tsserver.on("error", reject)
      this.tsserver.on("spawn", () => {
        console.log("tsserver spawned")
        resolve()
      })
    })
  }

  handleLine(line) {
    if (!line.startsWith("{")) return
    try {
      const msg = JSON.parse(line)
      if (msg.type === "response" && this.pending.has(msg.request_seq)) {
        const { resolve } = this.pending.get(msg.request_seq)
        this.pending.delete(msg.request_seq)
        resolve(msg)
      } else if (msg.type === "event") {
        this.events.push(msg)
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  send(command, args) {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq
      const request = { seq, type: "request", command, arguments: args }
      this.pending.set(seq, { resolve, reject })
      this.tsserver.stdin.write(JSON.stringify(request) + "\n")
    })
  }

  async close() {
    await this.send("exit", {})
    this.tsserver.kill()
  }
}

async function main() {
  const client = new TsServerClient()
  await client.start()

  console.log("\n1. Configure project...")
  await client.send("configure", {
    hostInfo: "test-harness",
    preferences: {
      includeInlayParameterNameHints: "all",
      includeInlayVariableTypeHints: true,
      includeInlayFunctionParameterTypeHints: true,
    },
  })

  console.log("\n2. Open a .ts file to trigger configured project + plugin...")
  const openTsResponse = await client.send("open", {
    file: servicesTs,
    projectRootPath: demoRoot,
  })
  console.log("   open services.ts:", JSON.stringify(openTsResponse, null, 2))

  // Wait for plugin to load and discover .efx files
  await new Promise((r) => setTimeout(r, 2000))

  console.log("\n3. Request semantic diagnostics for Counter.efx...")
  const diagResponse = await client.send("semanticDiagnosticsSync", {
    file: counterEfx,
  })

  console.log("\n4. Diagnostics result:")
  const diags = diagResponse.body || []
  if (diags.length === 0) {
    console.log("   No semantic diagnostics - PASS (no JSX errors)")
  } else {
    console.log(`   ${diags.length} semantic diagnostic(s):`)
    for (const d of diags) {
      console.log(`   - [${d.start?.line}:${d.start?.offset}] ${d.text}`)
    }

    // Check for JSX-related errors
    const jsxErrors = diags.filter(
      (d) =>
        d.text?.includes("JSX") ||
        d.text?.includes("IntrinsicElements") ||
        d.text?.includes("jsx-runtime")
    )
    if (jsxErrors.length > 0) {
      console.log("\n   FAIL: JSX-related errors found (plugin not working)")
      process.exitCode = 1
    } else {
      console.log("\n   PASS: No JSX-related errors (other errors may be expected)")
    }
  }

  console.log("\n4b. Request syntactic diagnostics...")
  const syntaxResponse = await client.send("syntacticDiagnosticsSync", {
    file: counterEfx,
  })
  const syntaxDiags = syntaxResponse.body || []
  if (syntaxDiags.length === 0) {
    console.log("   No syntactic errors - PASS")
  } else {
    console.log(`   ${syntaxDiags.length} syntactic error(s):`)
    for (const d of syntaxDiags) {
      console.log(`   - [${d.start?.line}:${d.start?.offset}] ${d.text}`)
    }
  }

  console.log("\n5. Test hover (quickinfo) on 'count' variable...")
  // In Counter.efx, line 15 is: const count = AtomRef.make(0)
  // 'count' starts at column 9
  const hoverResponse = await client.send("quickinfo", {
    file: counterEfx,
    line: 15,
    offset: 9,
  })
  if (hoverResponse.body?.displayString) {
    console.log("   Hover result:", hoverResponse.body.displayString)
    if (hoverResponse.body.displayString.includes("AtomRef")) {
      console.log("   PASS: Got AtomRef type info")
    }
  } else {
    console.log("   No hover info returned (position mapping may be off)")
  }

  console.log("\n6. Test inlay hints...")
  // Open the file first
  await client.send("open", { file: counterEfx })
  const inlayResponse = await client.send("provideInlayHints", {
    file: counterEfx,
    start: 0,
    length: 1000,
  })
  const hints = inlayResponse.body || []
  console.log(`   Got ${hints.length} inlay hints:`)
  for (const h of hints.slice(0, 10)) {
    const text = typeof h.text === 'string' ? h.text : JSON.stringify(h.text)
    const pos = h.position ? `${h.position.line}:${h.position.offset}` : 'unknown'
    const kind = h.kind || 'unknown'
    console.log(`     - [${pos}] kind=${kind} "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`)
  }
  const hParamHints = hints.filter(h => {
    const text = typeof h.text === 'string' ? h.text : JSON.stringify(h.text)
    // Check for h() parameter hints (tag/props/children, including underscore-prefixed)
    return h.kind === 'Parameter' && /^_?(tag|props|children):?$/i.test(text)
  })
  if (hParamHints.length > 0) {
    console.log(`   WARNING: ${hParamHints.length} h() parameter hints still present`)
  } else {
    console.log("   PASS: No h() parameter hints")
  }

  // Counter.efx line 19 has: `<button onclick={() => count.update((n) => n + 1)}>+</button>`
  // With `includeInlayFunctionParameterTypeHints` on, tsserver emits a Type hint
  // `: number` for the `n` parameter. It must render IMMEDIATELY AFTER the `n`
  // (column 45 = the `)` position), not at column 44 = the `n` position itself —
  // that would render as `( : numbern)` instead of `(n: number)`. Stale source-map
  // mappings without `generatedLengths` produce the wrong column. See
  // `@efx/language/src/source-map.ts`.
  const paramTypeHint = hints.find(h => {
    const text = typeof h.text === 'string' ? h.text : JSON.stringify(h.text)
    return h.kind === 'Type' && /^:\s*number/.test(text) && h.position?.line === 19
  })
  if (!paramTypeHint) {
    console.log("   FAIL: missing ': number' Type hint on line 19's `n` parameter")
    process.exitCode = 1
  } else if (paramTypeHint.position.offset === 45) {
    console.log("   PASS: ': number' hint at line 19 column 45 (after the `n`)")
  } else {
    console.log(`   FAIL: ': number' hint at line 19 column ${paramTypeHint.position.offset} — expected 45 (after the n)`)
    process.exitCode = 1
  }

  console.log("\n7. Test go-to-definition on Counter import in main.efx...")
  const mainEfx = join(demoRoot, "src/main.efx")
  await client.send("open", { file: mainEfx })
  // Also open Counter.efx so tsserver knows its content
  await client.send("open", { file: counterEfx })
  // Line 3: import { Counter } from "./Counter"
  // 'Counter' starts around column 10
  const defResponse = await client.send("definition", {
    file: mainEfx,
    line: 3,
    offset: 10,
  })
  console.log("   Definition response:", JSON.stringify(defResponse.body, null, 2))
  if (defResponse.body?.length > 0) {
    const def = defResponse.body[0]
    console.log(`   Definition: ${def.file} line ${def.start?.line}`)
    if (def.file?.endsWith("Counter.efx")) {
      console.log("   PASS: Go-to-definition works")
    } else {
      console.log("   PARTIAL: Definition found but not in .efx file")
    }
  } else {
    console.log("   FAIL: No definition returned")
  }

  console.log("\n7b. Test go-to-definition on <Counter /> JSX usage...")
  // Line 15: <Counter />
  const defResponse2 = await client.send("definition", {
    file: mainEfx,
    line: 15,
    offset: 8,
  })
  console.log("   Definition response:", JSON.stringify(defResponse2.body, null, 2))
  // Also test on the import to compare
  const defResponse3 = await client.send("definition", {
    file: mainEfx,
    line: 3,
    offset: 10,
  })
  console.log("   Import definition response:", JSON.stringify(defResponse3.body?.[0], null, 2))
  if (defResponse2.body?.length > 0) {
    const def = defResponse2.body[0]
    console.log(`   Definition: ${def.file} line ${def.start?.line}`)
    if (def.file?.endsWith("Counter.efx")) {
      console.log("   PASS: JSX go-to-definition works")
    } else {
      console.log("   PARTIAL: Definition found but not in .efx file:", def.file)
    }
  } else {
    console.log("   FAIL: No definition returned for JSX usage")
  }

  console.log("\n8. Test find-references on Counter (from Counter.efx)...")
  // Find references to Counter from its definition - matches user's exact scenario
  const refsResponse = await client.send("references", {
    file: counterEfx,
    line: 14,
    offset: 14, // Counter identifier in "export const Counter"
  })
  const refs = refsResponse.body?.refs || []
  console.log(`   Found ${refs.length} references:`)
  for (const ref of refs.slice(0, 10)) {
    const file = ref.file?.split("/").pop()
    console.log(`     - ${file} L${ref.start?.line}:${ref.start?.offset}`)
  }
  const efxRefs = refs.filter(r => r.file?.endsWith(".efx"))
  const tsRefs = refs.filter(r => r.file?.endsWith(".ts") && !r.file?.endsWith(".d.ts"))
  if (efxRefs.length >= 3) {
    console.log(`   PASS: ${efxRefs.length} references in .efx files`)
  } else if (efxRefs.length > 0) {
    console.log(`   PARTIAL: Only ${efxRefs.length} .efx reference (expected at least 3: definition + import + usage)`)
  } else if (tsRefs.length > 0) {
    console.log(`   PARTIAL: ${tsRefs.length} .ts references found but not converted to .efx`)
  } else {
    console.log("   FAIL: No references found")
  }

  console.log("\n9. Check project files (looking for .efx files)...")
  const projectInfo = await client.send("projectInfo", {
    file: servicesTs,
    needFileNameList: true,
  })
  const files = projectInfo.body?.fileNames || []
  const efxFiles = files.filter((f) => f.endsWith(".efx"))
  console.log(`   Project has ${files.length} files, ${efxFiles.length} .efx files`)
  if (efxFiles.length > 0) {
    console.log("   .efx files:", efxFiles.map((f) => f.split("/").pop()).join(", "))
  } else {
    console.log("   FAIL: No .efx files in project (getExternalFiles not working)")
    process.exitCode = 1
  }

  await client.close()
  console.log("\nDone.")
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
