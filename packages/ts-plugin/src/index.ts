/**
 * TypeScript Language Service Plugin for `.vx` files using Volar.
 *
 * The entry that tsserver loads via `require()`. See:
 *   - `language-plugin.ts` — Volar contract (file id, virtual code)
 *   - `virtual-code.ts`    — per-file compiled state cache
 *   - `source-map.ts`      — Babel map → Volar mappings + offset converters
 *   - `jsx-tags.ts`        — JSX tag-pair lookup for document highlights
 *   - `service-proxy.ts`   — wraps Volar's LanguageService with `.vx` redirects
 */
import { pluginFactory } from "./service-proxy.ts"

export = pluginFactory
