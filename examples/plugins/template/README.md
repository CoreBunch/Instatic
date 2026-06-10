# Template Plugin

Minimal starter plugin for the Instatic. Use this as the base for your own plugin.

## Quick start

```bash
# 1. Copy the template
cp -r examples/plugins/template my-plugin

# 2. Edit plugin.json
#    Change id, name, description, author, and the permissions your plugin needs.

# 3. Edit editor/index.js and server/index.js
#    Implement your activate() / deactivate() logic.

# 4. Package and install
cd my-plugin
zip -qr ../my-plugin.zip .
# Upload the .zip from the admin UI → Plugins → Install plugin
```

## What's included

| File | Purpose |
|---|---|
| `plugin.json` | Plugin manifest — identity, permissions, entrypoints |
| `editor/index.js` | Editor entrypoint — commands, toolbar buttons, palette providers |
| `server/index.js` | Server entrypoint — lifecycle hooks, CMS routes |

## Command Spotlight (⌘K) integration

The template demonstrates all three levels of palette integration:

### 1. Basic command (auto-surfaced)

Any command registered with `api.editor.commands.register` automatically appears in the Command Spotlight palette under **"Plugin commands"**. No extra code needed:

```js
api.editor.commands.register({
  id: 'acme.template.ping',
  label: 'Template Ping',
  run: () => ({ message: 'Done!' }),
})
```

### 2. Richer palette command

Use `api.editor.palette.registerCommand` for commands authored specifically for the palette — with subtitle, icon, argument collection, or workspace gating:

```js
api.editor.palette.registerCommand({
  id: 'acme.template.greet',
  label: 'Greet user…',
  subtitle: 'Collect a name, then say hello',
  iconName: 'person-wave',
  destructive: false,
  workspaces: ['any'],
  args: [
    { id: 'name', label: 'Name', type: 'text', placeholder: 'Your name' },
    { id: 'tone', label: 'Tone', type: 'select', options: [
      { value: 'formal', label: 'Formal' },
      { value: 'casual', label: 'Casual' },
    ]},
  ],
  run: () => {},
})
```

### 3. Live-search provider

Register a provider to return dynamic search results on each keystroke. Results appear under your provider's label as a group in the palette:

```js
api.editor.palette.registerProvider({
  id: 'acme.template.items',   // must start with "<pluginId>."
  label: 'My items',
  search: async (query) => {
    const res = await fetch('/admin/api/cms/plugins/acme.template/runtime/items?q=' + query)
    const data = await res.json()
    return data.items.map(item => ({
      id: item.id,
      title: item.title,
      subtitle: item.category,
      run: async () => { /* open item, navigate, etc. */ },
    }))
  },
})
```

Both `registerCommand` and `registerProvider` require the `editor.commands` permission in `plugin.json`.

## Permissions

The template requests:

| Permission | Why |
|---|---|
| `cms.routes` | Register a `/status` health-check route |
| `editor.code` | Required for `entrypoints.editor` — editor entrypoints run **unsandboxed** in the admin window |
| `editor.commands` | Register commands + palette commands and providers |
| `editor.toolbar` | Add a toolbar button |

Remove permissions you don't need — users see the full permission list before installing.
A plugin that drops its editor entrypoint (and any app-kind admin pages) can drop
`editor.code` too; everything else then runs inside the QuickJS sandbox.

## Further reading

- [Plugin system docs](../../../docs/features/plugin-system.md)
- [Full showcase plugin](../showcase/)
