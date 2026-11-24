# Template Plugin

Minimal raw-zip starter plugin for Instatic. Use this when you want to inspect the runtime `plugin.json` shape directly; new TypeScript-authored plugins should usually start with `bun instatic-plugin init`.

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

## Third-party scripts and frames on published pages

Published pages block scripts and frames from other sites. To load a provider's hosted script, or let it open a frame, request `frontend.assets` and name the hosts:

```json
{
  "permissions": ["frontend.assets"],
  "frontend": {
    "assets": [{ "kind": "script", "src": "https://js.example.com/v3", "strategy": "async" }],
    "origins": { "scripts": ["js.example.com"], "frames": ["js.example.com"] }
  }
}
```

Hosts are bare names or `*.example.com`. Whoever installs the plugin sees each one before approving it, with a warning under every wildcard. A wildcard directly under a shared-hosting domain (`*.github.io`, `*.vercel.app`) is refused: name the exact host.

Inline code runs only as a declared `script-inline` asset, which the page allows by its hash. Inline event handlers (`onclick="…"`) are blocked on published pages; attach handlers from your script.

## Sending email

A plugin sends only emails it declares. Request `mail.send` (site members) or `mail.send.external` (any address) and list the templates:

```json
{
  "permissions": ["mail.send"],
  "mail": {
    "templates": [
      {
        "key": "welcome",
        "label": "Welcome",
        "description": "Sent after a member joins.",
        "variables": [{ "name": "link", "label": "Link", "sample": "https://example.com/start", "kind": "link" }],
        "subject": "Welcome to {site.name}",
        "body": "Thanks for joining.\n\n[Get started]({link})"
      }
    ]
  }
}
```

```js
const site = await api.cms.site.publicUrl()
await api.cms.mail.send({
  template: 'welcome',
  to: { member: memberId },
  variables: { link: `${site}/start` },
})
```

The site owner can reword each template under Email → Templates. `send` resolves once the email is queued; listen for `mail.delivered` and `mail.failed` (with `cms.hooks`) to learn how it went. This is for transactional email to one recipient at a time, not newsletters. Templates are Markdown: raw HTML is stripped, images are not allowed, and links you write out must be `https`. Declare a variable that carries an address with `"kind": "link"`: it must stand alone in the template or be the whole address of a link (`[Open]({link})`), and `instatic-plugin lint` refuses a template that glues one into text. Other variables are text: they may sit anywhere, but a value that contains an address is refused when you send. The owner reads each template before installing, and again when an update changes one.

## Storing records safely

Declare a resource in `plugin.json`, add the `cms.storage` permission, and read and write it through `api.cms.storage.collection(id)`. A plugin's handlers run interleaved (and once per server instance), so never "look, then create". Name a `uniqueField` and let the database decide:

```json
"resources": [{
  "id": "events",
  "title": "Events",
  "uniqueField": "eventId",
  "fields": [
    { "id": "eventId", "type": "text", "label": "Event id", "required": true },
    { "id": "state", "type": "text", "label": "State" }
  ]
}]
```

```js
const events = api.cms.storage.collection('events')

// Exactly one of any number of concurrent calls gets created: true.
const claim = await events.createIfAbsent({ eventId: body.id, state: 'received' })
if (!claim.created) return { ok: true }

// Read, change, write back: applies only if nobody changed the record since.
try {
  await events.update(claim.record.id, { eventId: body.id, state: 'done' }, { ifVersion: claim.record.version })
} catch (err) {
  if (!err.message.startsWith('storage_conflict:')) throw err
  // someone else got there first: read again and decide
}
```

`create` rejects with a `storage_duplicate:` message when the key is taken. Full reference: "Plugin-owned records" in `docs/features/plugin-system.md`.

## Member routes for apps

A site member can sign in to an app the site owner registered. A plugin lets such an app call one of its member routes by declaring an app scope and naming it on the route. `server/index.js` carries a commented example:

```json
{
  "permissions": ["cms.routes", "members.read"],
  "appScopes": [{ "name": "read", "description": "See your saved items" }]
}
```

```js
api.cms.routes.member.get('/items', { app: { scope: 'read' } }, (ctx) => listItems(ctx.member.id))
```

The member reads `description` before allowing the app, so say plainly what the scope lets the app do. If a later version changes the description or removes the scope, members are asked again.

## Managed media ingestion

A plugin can import source images into managed media without moving bytes through QuickJS. For allowlisted HTTPS images, request both permissions and allow the upstream hosts:

```json
{
  "permissions": ["cms.schedule", "media.import", "network.outbound"],
  "networkAllowedHosts": ["images.example-crm.com"]
}
```

Then upsert each source by a stable identity:

```js
const result = await api.cms.media.upsert({
  sourceKey: `listing:${listing.id}:photo:${photo.id}`,
  source: { kind: 'remote', url: photo.url },
  sourceVersion: photo.updatedAt,
  filename: photo.filename,
  altText: listing.address,
})
```

The first call creates a media asset, an unchanged version returns it without downloading, and a changed version replaces its binary while preserving `result.asset.id`.

Bundled plugin assets need only `media.import`:

```js
await api.cms.media.upsert({
  sourceKey: 'starter:default-hero',
  source: { kind: 'pluginAsset', path: 'assets/default-hero.jpg' },
  sourceVersion: api.plugin.version,
  filename: 'default-hero.jpg',
})
```

The path is package-relative. Plugins cannot read arbitrary host filesystem paths through this API.

## Further reading

- [Plugin system docs](../../../docs/features/plugin-system.md)

For optional signed package updates, see the signed plugin updates section in [the plugin system guide](../../../docs/features/plugin-system.md).
