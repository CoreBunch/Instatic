# Smoke Test

> Plugin id: `local.smoke-test`

## Develop

```bash
instatic-plugin dev          # watch + sync into the running CMS
instatic-plugin build        # produce a .plugin.zip
```

The dev command writes built files directly into the host CMS's
`uploads/plugins/local.smoke-test/<version>/` directory. On first run it
auto-detects the host's `uploads/` folder by walking up from the plugin
directory; pass `--uploads <path>` (or set `INSTATIC_UPLOADS_DIR`) when running
outside the instatic monorepo.

You'll need to install the plugin once via the admin UI (`/admin/plugins` →
Upload Plugin) so the host registers it and approves permissions. After
that, every `instatic-plugin dev` rebuild flows in without another upload.

See [docs/features/plugin-system.md](../instatic/docs/features/plugin-system.md)
for the full plugin SDK surface.
