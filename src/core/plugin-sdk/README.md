# @instatic/plugin-sdk

Typed builders and the `instatic-plugin` CLI for writing plugins for the
[Instatic](https://instatic.com) CMS.

The CLI runs on [Bun](https://bun.sh). Each SDK version is built from the
Instatic release with the same number, so install the one that matches the CMS
your plugin targets.

## Start a plugin

```bash
mkdir plugins && cd plugins
bun add -d https://github.com/CoreBunch/Instatic/releases/download/v<version>/instatic-plugin-sdk-<version>.tgz
bun run instatic-plugin init acme.hello
cd hello && bun install
```

Install the package first, then run its CLI with `bun run instatic-plugin`,
which only runs what is installed. Do not use a bare `bunx instatic-plugin`:
with nothing installed it would download whatever npm serves under that name.

The scaffold is a project of its own, with the same SDK dependency in its
`package.json` and these scripts:

```bash
bun run typecheck
bun run lint     # validate the manifest and sources
bun run build    # write dist/ and hello.plugin.zip
bun run dev -- --uploads <instatic>/uploads   # rebuild into a running CMS
```

To build against an Instatic version that has no release yet, run
`bun run sdk:pack` in that Instatic checkout and depend on the file it writes
(`file:../instatic/.tmp/plugin-sdk/instatic-plugin-sdk-<version>.tgz`).

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
never installed or bundled. Their types ship in this package. `@types/react`
is a required peer, which the scaffold declares.

The declaration files need `"moduleResolution": "bundler"`, which the
scaffold's `tsconfig.json` sets.

Full documentation:
[plugin-system.md](https://github.com/CoreBunch/Instatic/blob/main/docs/features/plugin-system.md).
