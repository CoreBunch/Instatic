# CSP Manager

Installable declarative plugin for additive, site-wide Content Security Policy sources. Zip `plugin.json` at the package root, install it from the Plugins workspace, and approve both requested permissions.

The host-owned CSP Manager page stores rows in this site's plugin-record storage. Each enabled row must use one of `script-src`, `connect-src`, `img-src`, or `frame-src` and an exact canonical HTTPS origin such as `https://connect.facebook.net`; wildcards, paths, credentials, non-HTTPS URLs, CSP keywords, and token injection are rejected before persistence.

Disabling or uninstalling the plugin revokes every contribution immediately without removing the site's base policy. Disabling a row or deleting it removes that one contribution on the next render/publish.
