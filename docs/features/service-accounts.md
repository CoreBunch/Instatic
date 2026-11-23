# Service accounts and the Instatic CLI

An external agent can use the CMS API from an existing Codex or Claude Code session. The installation supplies the CLI, the account’s effective permissions, and a searchable guide. Branch and content writes go through the same handlers as the admin UI.

## Connect an agent

1. Open **AI → Service accounts → Create service account**. Enter a name, choose the connection lifetime, and select permissions you hold. The Roles picker groups supported permissions by feature and offers **Select all** and **Clear all** across the form or within each group. For a copy-editing agent that can create its own branch, choose **View site**, **Create branches**, and **Edit site content**. Add **Edit site styles** or **Edit site structure** if its job includes those changes.
2. The new account opens in the inspector. Choose **Copy agent prompt** and paste it into the agent session. The prompt asks the agent to check the installed CLI, obtain your approval if installation is needed, then run the connection command. The versioned package comes from your installation. The command contains the origin and public account ID.
3. Match the code in the terminal with the one shown in your browser, review permissions and expiry, and choose **Authorize CLI**. After pairing, the browser returns to the account and shows **Connected**. Creation and approval use admin step-up. Remote sites need an HTTPS public origin. A local loopback site can pair over HTTP.
4. Give the session a task such as “Create a branch called review, fix the hero heading on the homepage, check it at mobile width, and tell me what you changed.” The agent reports back in that session.

The CLI requires Bun 1.4 and a working OS credential store. Pair on the machine running the CLI. The connection uses a temporary listener bound to 127.0.0.1, a random state, and a one-minute single-use authorization code with an S256 proof. Use `connect --no-open` to open the printed URL yourself. The resulting opaque bearer credential expires with the connector (one hour to 30 days). The system credential store holds the token under the site account’s ID. The server stores its hash. Use **Copy agent prompt** again to pair another device. Reconnecting a device replaces the previous credential when the new device finishes the exchange.

## Use the CLI

Pass the public ID from the prompt with `--account` or set `INSTATIC_ACCOUNT` in the shell used for subsequent commands. Each invocation selects its account explicitly. Standard output carries the result, errors go to standard error, and failures exit nonzero.

```sh
export INSTATIC_ACCOUNT='PUBLIC_ACCOUNT_ID_FROM_PROMPT'
instatic whoami
instatic api lookup branch
instatic api describe POST branches
instatic api POST branches --json '{"name":"review"}'
instatic api GET pages --branch review
```

Choose the returned page ID, read a fresh editable payload, and modify the matching node in `changedPages[0].nodes`. Preserve the remaining fields and sequence numbers. If a write returns HTTP 409, reread the current draft and reconcile the intended change.

```sh
instatic api GET draft-page/PAGE_ID --branch review > change.json
# Edit the relevant node in change.json.
instatic api PUT site-document --branch review --file change.json
instatic api GET branches/review/merge
instatic screenshot PAGE_ID --branch review --viewport 390x844 --out hero.png
```

Open the returned PNG in the agent’s image viewer to inspect the result. Capture uses the branch review renderer and script-disabled local Chromium. No admin tab needs to be open. Set `INSTATIC_CHROMIUM` to an installed Chromium executable, or approve installation of the matching Playwright Chromium. The screenshot result includes its absolute path, dimensions and count of skipped asset requests. Assets are fetched from the same origin without the CLI credential. Screens relying on external assets or runtime JavaScript can differ from the public page.

## Permissions and lifecycle

- A connector receives grants from the same capability list as a custom role. Role management is reserved for the installation owner. **Select all** grants the available capabilities you currently hold. The connector’s scope is installation-wide. A branch ID selects a draft. A connector with site-edit capabilities can also target main. The CLI requires an explicit branch for a site-document save.
- The CMS resolves a distinct actor for each connector. Content ownership, branch ownership and existing mutation audit records identify that actor. It has no interactive login. The creating administrator owns management and approval of its connection.
- Every authenticated call checks the connector’s expiry and revocation, its creator’s current account status and connector-management permission, and the intersection of the selected capabilities with the creator’s current capabilities. The target handler enforces its own row, branch, role and write-diff policies.
- The CLI can call operational HTTP endpoints under `/admin/api/cms/` and `/admin/api/ai/`, including plugin installation, user administration, exports and publishing. Each handler applies its normal capability and ownership checks. Login, personal security, connector issuance and browser workspace callbacks require a browser session. Omit `--branch` for installation-wide changes such as plugin installation.
- For sensitive actions, the CMS applies the sponsor’s step-up policy. When you approve a CLI connection, its credential inherits the remaining password-confirmation window from that browser approval. When a command requires fresh confirmation, run the same `instatic connect` command and approve again. Ordinary reads can continue until the connector expires or is revoked.
- `api lookup [search terms]` searches built-in CMS and AI operations and live plugin routes for this account. Search by method, path, description, or capability. The list reflects the current grant. Every GET also supports HEAD to read response headers. Ownership, resource type, branch state and fresh approval are checked on the actual request.
- Copy the method and path template from lookup into `api describe METHOD PATH`. It returns the path parameters, query schema, request body format, JSON schema or multipart fields, and a CLI command template. Replace colon-prefixed path parameters with URL-encoded values. Add query parameters to the quoted path. Pass JSON with `--json` or `--file`, multipart files with `--upload` and optional repeated `--field NAME=VALUE`, and binary inputs with `--raw`. Save binary responses with `--out`.
- A plugin route’s input instructions come from the plugin that registered it. A route without published instructions is marked as such. Unloading the plugin removes its routes from discovery.
- **Revoke access** invalidates future requests and pending approvals. It also works when the CLI machine has been lost. `instatic forget` clears the credential on the current machine. The manager’s default restore and transfer settings also clear issued CLI credentials and pending approvals. Reconnect the account on the restored installation.

## Install a plugin

Grant **Install or uninstall plugins**. Inspect the package, review its requested permissions, then supply the permissions you approve. For a package whose only declared permission is `cms.routes`, the commands are:

```sh
instatic api POST plugins/inspect-package --upload plugin.zip
instatic api POST plugins/package --upload plugin.zip --field 'grantedPermissions=["cms.routes"]'
```

The CMS checks the grants against the manifest. Enabling, disabling or restarting an installed plugin uses the separate **plugin lifecycle** permission.
