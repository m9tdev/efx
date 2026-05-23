// Bundles the plugin (with its workspace deps inlined) into a single CJS
// file so that tsserver's `require()` can load it without touching any
// `.ts` source. `typescript` is left external — every consumer has it
// installed already and we want to use the host's copy.
import { build } from "esbuild"

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/index.cjs",
  external: ["typescript", "typescript/lib/tsserverlibrary"],
  logLevel: "info",
})
