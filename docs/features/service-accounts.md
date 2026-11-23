# Service accounts and the Instatic CLI

An external agent can use the CMS API from an existing Codex or Claude Code session. The installation supplies the CLI, the account’s effective permissions, and a searchable guide. Branch and content writes go through the same handlers as the admin UI.

## Connect an agent

1. Open **AI → Service accounts → Create service account**. Enter a name, choose the connection lifetime, and select permissions you hold. For a copy-editing agent that can create its own branch, choose **View site**, **Create branches**, and **Edit site content**. Add **Edit site styles** or **Edit site structure** if its job includes those changes.
2. The new account opens in the inspector. Choose **Copy agent prompt** and paste it into the agent session. The prompt asks the agent to check the installed CLI, obtain your approval if installation is needed, then run the connection command. Choose **View prompt** to read the full instructions. The versioned package comes from your installation. The command contains the origin and public account ID.
3. Match the code in the terminal with the one shown in your browser, review permissions and expiry, and choose **Authorize CLI**. After pairing, the browser returns to the account and shows **Connected**. Creation and approval use admin step-up. Remote sites need an HTTPS public origin. A local loopback site can pair over HTTP.
4. Give the session a task such as “Create a branch called review, fix the hero heading on the homepage, check it at mobile width, and tell me what you changed.” The agent reports back in that session.

The CLI requires Bun 1.4 and a working OS credential store. Pair on the machine running the CLI. The connection uses a temporary listener bound to 127.0.0.1, a random state, and a one-minute single-use authorization code with an S256 proof. Use `connect --no-open` to open the printed URL yourself. The resulting opaque bearer credential expires with the connector (one hour to 30 days). The system credential store holds the token under the site account’s ID. The server stores its hash. For a connected account, **Reconnect CLI** opens the pairing prompt again. Reconnecting a device replaces the previous credential when the new device finishes the exchange.

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

- The connector’s scope is installation-wide. A branch ID selects a draft. A connector with site-edit capabilities can also target main. The CLI requires an explicit branch for a site-document save.
- The CMS resolves a distinct actor for each connector. Content ownership, branch ownership and existing mutation audit records identify that actor. It has no interactive login. The creating administrator owns management and approval of its connection.
- Every authenticated call checks the connector’s expiry and revocation, its creator’s current account status and connector-management permission, and the intersection of the selected capabilities with the creator’s current capabilities. The target handler enforces its own row, branch, role and write-diff policies.
- The CMS accepts CLI credentials on branch, page, site, component, layout, data, media, plugin and mail APIs. The AI provider, model and defaults routes also support them. Personal security, connector management, and actions requiring a human step-up remain personal-session operations. Global writes carrying a branch header are refused for mail, media, plugins and AI settings.
- `api lookup` searches a permission-filtered guide to common operations. `api describe METHOD PATH` provides details for a listed entry, including a request schema where available. `api METHOD PATH` also accepts other routes in the supported resource groups, including their query parameters. Use `--json` or `--file` for JSON and `--upload` for a multipart file.
- **Revoke access** invalidates future requests and pending approvals. It also works when the CLI machine has been lost. `instatic forget` clears the credential on the current machine. The manager’s default restore and transfer settings also clear issued CLI credentials and pending approvals. Reconnect the account on the restored installation.
