# @instatic/plugin-sdk

Typed builders and the `instatic-plugin` CLI for writing plugins for the
[Instatic](https://instatic.com) CMS.

The CLI runs on [Bun](https://bun.sh). Each SDK version is built from the
Instatic release with the same number, so install the one that matches the CMS
your plugin targets.

## Start a plugin

```bash
bun add -d @instatic/plugin-sdk@<version>
bunx instatic-plugin init acme.hello
cd hello && bun install
```

The same package is attached to every Instatic release, for installs that
cannot use npm:

```bash
bun add -d https://github.com/CoreBunch/Instatic/releases/download/v<version>/instatic-plugin-sdk-<version>.tgz
```

```bash
bunx instatic-plugin lint     # validate the manifest and sources
bunx instatic-plugin build    # write dist/ and a .plugin.zip
bunx instatic-plugin dev --uploads <instatic>/uploads   # rebuild into a running CMS
```

## Write one

```ts
import { definePlugin, permissions } from '@instatic/plugin-sdk'

export default definePlugin({
  id: 'acme.hello',
  name: 'Hello',
  version: '0.1.0',
  permissions: [permissions.cmsHooks],
})
```

Code that runs in the editor imports React, `@instatic/host-ui` and
`@instatic/host-hooks`. The editor supplies all three at runtime, so they are
never installed or bundled. Their types ship in this package; add
`@types/react` for JSX.

## TypeScript settings

The scaffold's `tsconfig.json` sets the two options the declaration files
need: `"moduleResolution": "bundler"` and `"skipLibCheck": true`. The editor
store type that `useEditorStore` returns mentions host libraries a plugin does
not install; with `skipLibCheck` those members read as `any`.

Full documentation:
[plugin-system.md](https://github.com/CoreBunch/Instatic/blob/main/docs/features/plugin-system.md).
