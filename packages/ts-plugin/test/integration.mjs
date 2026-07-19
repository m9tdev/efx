#!/usr/bin/env node
/**
 * tsserver test harness for @verrex/ts-plugin
 *
 * Spawns tsserver, opens the demo project, requests diagnostics for an .vx
 * file, and verifies that:
 * 1. The virtual .vx.tsx file is recognized
 * 2. No JSX namespace errors appear (the plugin compiled the .vx correctly)
 */
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
import { readFileSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "../../..")
const demoRoot = join(repoRoot, "apps/demo")
const servicesTs = join(demoRoot, "src/services.ts")
const counterVerrex = join(demoRoot, "src/Counter.vx")

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
      const tsserverPath = join(
        repoRoot,
        "node_modules/typescript/lib/tsserver.js",
      )
      this.tsserver = spawn(
        "node",
        [tsserverPath, "--useInferredProjectPerProjectRoot"],
        {
          cwd: demoRoot,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            TSS_LOG: "-level verbose",
          },
        },
      )

      this.rl = createInterface({ input: this.tsserver.stdout })
      this.rl.on("line", (line) => this.handleLine(line))

      this.tsserver.stderr.on("data", (data) => {
        const msg = data.toString()
        // Show relevant stderr for debugging
        for (const line of msg.trim().split("\n")) {
          if (
            line.includes("[verrex]") ||
            line.includes("plugin") ||
            line.includes("Error")
          ) {
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

  // Wait for plugin to load and discover .vx files
  await new Promise((r) => setTimeout(r, 2000))

  console.log("\n3. Request semantic diagnostics for Counter.vx...")
  const diagResponse = await client.send("semanticDiagnosticsSync", {
    file: counterVerrex,
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
        d.text?.includes("jsx-runtime"),
    )
    if (jsxErrors.length > 0) {
      console.log("\n   FAIL: JSX-related errors found (plugin not working)")
      process.exitCode = 1
    } else {
      console.log(
        "\n   PASS: No JSX-related errors (other errors may be expected)",
      )
    }
  }

  console.log("\n4b. Request syntactic diagnostics...")
  const syntaxResponse = await client.send("syntacticDiagnosticsSync", {
    file: counterVerrex,
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
  // In Counter.vx, line 15 is: const count = AtomRef.make(0)
  // 'count' starts at column 9
  const hoverResponse = await client.send("quickinfo", {
    file: counterVerrex,
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
  await client.send("open", { file: counterVerrex })
  const inlayResponse = await client.send("provideInlayHints", {
    file: counterVerrex,
    start: 0,
    length: 1000,
  })
  const hints = inlayResponse.body || []
  console.log(`   Got ${hints.length} inlay hints:`)
  for (const h of hints.slice(0, 10)) {
    const text = typeof h.text === "string" ? h.text : JSON.stringify(h.text)
    const pos = h.position
      ? `${h.position.line}:${h.position.offset}`
      : "unknown"
    const kind = h.kind || "unknown"
    console.log(
      `     - [${pos}] kind=${kind} "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`,
    )
  }
  const hParamHints = hints.filter((h) => {
    const text = typeof h.text === "string" ? h.text : JSON.stringify(h.text)
    // Check for h() parameter hints (tag/props/children, including underscore-prefixed)
    return h.kind === "Parameter" && /^_?(tag|props|children):?$/i.test(text)
  })
  if (hParamHints.length > 0) {
    console.log(
      `   WARNING: ${hParamHints.length} h() parameter hints still present`,
    )
  } else {
    console.log("   PASS: No h() parameter hints")
  }

  // Counter.vx line 19 has: `<button onclick={() => count.update((n) => n + 1)}>+</button>`
  // With `includeInlayFunctionParameterTypeHints` on, tsserver emits a Type hint
  // `: number` for the `n` parameter. It must render IMMEDIATELY AFTER the `n`
  // (column 45 = the `)` position), not at column 44 = the `n` position itself —
  // that would render as `( : numbern)` instead of `(n: number)`. Stale source-map
  // mappings without `generatedLengths` produce the wrong column. See
  // `verrex/language/src/source-map.ts`.
  const paramTypeHint = hints.find((h) => {
    const text = typeof h.text === "string" ? h.text : JSON.stringify(h.text)
    return (
      h.kind === "Type" && /^:\s*number/.test(text) && h.position?.line === 19
    )
  })
  if (!paramTypeHint) {
    console.log(
      "   FAIL: missing ': number' Type hint on line 19's `n` parameter",
    )
    process.exitCode = 1
  } else if (paramTypeHint.position.offset === 45) {
    console.log("   PASS: ': number' hint at line 19 column 45 (after the `n`)")
  } else {
    console.log(
      `   FAIL: ': number' hint at line 19 column ${paramTypeHint.position.offset} — expected 45 (after the n)`,
    )
    process.exitCode = 1
  }

  // Positions are located dynamically (scan for the token) so these survive
  // demo-layout edits. tsserver positions are 1-based; +1 past `indexOf` lands
  // on the identifier's first char.
  const mainVerrex = join(demoRoot, "src/main.vx")
  const todosVerrex = join(demoRoot, "src/Todos.vx")
  await client.send("open", { file: mainVerrex })
  await client.send("open", { file: counterVerrex })
  await client.send("open", { file: todosVerrex })

  console.log("\n7. Test cross-file go-to-definition on the Counter import...")
  // Resolve `Counter` in `import { Counter } from "./Counter.vx"` → Counter.vx.
  const mainLines = readFileSync(mainVerrex, "utf8").split("\n")
  const importIdx = mainLines.findIndex((l) =>
    l.includes(`from "./Counter.vx"`),
  )
  if (importIdx === -1)
    throw new Error("could not find the Counter import in main.vx")
  const defResponse = await client.send("definition", {
    file: mainVerrex,
    line: importIdx + 1,
    offset: mainLines[importIdx].indexOf("Counter") + 1,
  })
  if (defResponse.body?.length > 0) {
    const def = defResponse.body[0]
    console.log(`   Definition: ${def.file} line ${def.start?.line}`)
    console.log(
      def.file?.endsWith("Counter.vx")
        ? "   PASS: cross-file go-to-definition works"
        : "   PARTIAL: Definition found but not in .vx file",
    )
  } else {
    console.log("   FAIL: No definition returned")
  }

  console.log("\n7b. Test go-to-definition on a <TodoRow /> JSX usage...")
  // The .vx-specific path: a JSX tag (rewritten to h(TodoRow, …)) must map
  // back through the source map to the component definition. TodoRow is used
  // and defined in Todos.vx.
  const todosLines = readFileSync(todosVerrex, "utf8").split("\n")
  // Match the real JSX usage (`<TodoRow item={item} />`), not the docstring
  // mention of `<TodoRow />`.
  const jsxIdx = todosLines.findIndex((l) => l.includes("<TodoRow item"))
  if (jsxIdx === -1)
    throw new Error("could not find <TodoRow usage in Todos.vx")
  const jsxOffset = todosLines[jsxIdx].indexOf("<TodoRow") + 2 // 1-based, land on 'T'
  console.log(`   <TodoRow /> at line ${jsxIdx + 1}, offset ${jsxOffset}`)
  const defResponse2 = await client.send("definition", {
    file: todosVerrex,
    line: jsxIdx + 1,
    offset: jsxOffset,
  })
  console.log(
    "   Definition response:",
    JSON.stringify(defResponse2.body, null, 2),
  )
  if (defResponse2.body?.length > 0) {
    const def = defResponse2.body[0]
    console.log(`   Definition: ${def.file} line ${def.start?.line}`)
    console.log(
      def.file?.endsWith("Todos.vx")
        ? "   PASS: JSX go-to-definition works"
        : `   PARTIAL: Definition found but not in .vx file: ${def.file}`,
    )
  } else {
    console.log("   FAIL: No definition returned for JSX usage")
  }

  console.log("\n8. Test find-references on Counter (from Counter.vx)...")
  // Find references to Counter from its definition - matches user's exact scenario
  const refsResponse = await client.send("references", {
    file: counterVerrex,
    line: 14,
    offset: 14, // Counter identifier in "export const Counter"
  })
  const refs = refsResponse.body?.refs || []
  console.log(`   Found ${refs.length} references:`)
  for (const ref of refs.slice(0, 10)) {
    const file = ref.file?.split("/").pop()
    console.log(`     - ${file} L${ref.start?.line}:${ref.start?.offset}`)
  }
  const verrexRefs = refs.filter((r) => r.file?.endsWith(".vx"))
  const tsRefs = refs.filter(
    (r) => r.file?.endsWith(".ts") && !r.file?.endsWith(".d.ts"),
  )
  if (verrexRefs.length >= 3) {
    console.log(`   PASS: ${verrexRefs.length} references in .vx files`)
  } else if (verrexRefs.length > 0) {
    console.log(
      `   PARTIAL: Only ${verrexRefs.length} .vx reference (expected at least 3: definition + import + usage)`,
    )
  } else if (tsRefs.length > 0) {
    console.log(
      `   PARTIAL: ${tsRefs.length} .ts references found but not converted to .vx`,
    )
  } else {
    console.log("   FAIL: No references found")
  }

  console.log("\n9. Check project files (looking for .vx files)...")
  const projectInfo = await client.send("projectInfo", {
    file: servicesTs,
    needFileNameList: true,
  })
  const files = projectInfo.body?.fileNames || []
  const verrexFiles = files.filter((f) => f.endsWith(".vx"))
  console.log(
    `   Project has ${files.length} files, ${verrexFiles.length} .vx files`,
  )
  if (verrexFiles.length > 0) {
    console.log(
      "   .vx files:",
      verrexFiles.map((f) => f.split("/").pop()).join(", "),
    )
  } else {
    console.log(
      "   FAIL: No .vx files in project (getExternalFiles not working)",
    )
    process.exitCode = 1
  }

  console.log(
    "\n10. Test mid-edit completions don't replace next-line tokens...",
  )
  // The user reported: typing `count.` and picking an entry glued onto the
  // `return` keyword on the next line. Babel's errorRecovery parses
  // `count.\n\nreturn` as `count.return`, so tsserver's replacementSpan
  // covers `return` — picking `set` would delete it. The proxy clamps any
  // cross-line span to insert-at-cursor.
  const lines = readFileSync(counterVerrex, "utf-8").split("\n")
  // Insert "  count." at index 16 → 1-based line 17, with `return yield* (`
  // shifted to line 18.
  lines.splice(16, 0, "  count.")
  const modified = lines.join("\n")
  await client.send("open", {
    file: counterVerrex,
    fileContent: modified,
    projectRootPath: demoRoot,
  })
  await new Promise((r) => setTimeout(r, 500))

  const complResp = await client.send("completionInfo", {
    file: counterVerrex,
    line: 17,
    offset: 9, // right after the `.` in "  count."
    triggerCharacter: ".",
    includeExternalModuleExports: false,
  })
  const replSpan = complResp.body?.optionalReplacementSpan
  if (!replSpan) {
    console.log(
      "   No optionalReplacementSpan returned — likely OK (editor inserts at cursor).",
    )
  } else if (
    replSpan.start.line === replSpan.end.line &&
    replSpan.start.line === 17
  ) {
    console.log(
      `   PASS: replacementSpan stays on line 17 (cursor line), cols ${replSpan.start.offset}-${replSpan.end.offset}`,
    )
  } else {
    console.log(
      `   FAIL: replacementSpan crosses lines: ${JSON.stringify(replSpan)}`,
    )
    process.exitCode = 1
  }
  const setEntry = (complResp.body?.entries || []).find((e) => e.name === "set")
  if (setEntry) {
    console.log("   PASS: 'set' entry present (AtomRef members enumerated)")
  } else {
    console.log(
      "   FAIL: 'set' entry missing — completion didn't enumerate count's members",
    )
    process.exitCode = 1
  }
  // Close the modified file so other test runs don't see it
  await client.send("close", { file: counterVerrex })

  await client.close()
  console.log("\nDone.")
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
