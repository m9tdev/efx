# @verrex/ts-plugin

The Volar-based TypeScript Language Service plugin for [verrex](https://github.com/m9tdev/verrex)'s
`.vx` files: diagnostics, hover, go-to-definition, find-references, inlay
hints, and JSX tag-pair highlights — full editor support for the angle-bracket
syntax verrex compiles into `h()` calls.

> Status: proof-of-concept, `0.x`, not for production.

## Install

```bash
pnpm add -D @verrex/ts-plugin
```

## Setup

Add it to your `tsconfig.json` and tell your editor to treat `.vx` as
TypeScript:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [{ "name": "@verrex/ts-plugin" }]
  }
}
```

- **VS Code:** run "TypeScript: Select TypeScript Version → Use Workspace
  Version" so the editor's TS server loads the plugin.
- **Neovim:** `autocmd BufRead,BufNewFile *.vx setfiletype typescriptreact`
  (plus `tsserver` configured for `typescriptreact`).

The plugin ships as a single bundled `dist/index.cjs` that tsserver loads via
`require()`.

Full docs: **https://github.com/m9tdev/verrex**

## License

MIT © Mathieu Post
