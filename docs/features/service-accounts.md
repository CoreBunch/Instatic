# CLI connections

An external agent can use the CMS API from an existing Codex or Claude Code session. The installation supplies the CLI, the account’s effective permissions, and a searchable guide. Branch and content writes go through the same handlers as the admin UI.

## Connect an agent

1. Open **AI → CLI → Create CLI connection**. Enter a name, choose the connection lifetime, and select permissions you hold. The Roles picker groups supported permissions by feature and offers **Select all** and **Clear all** across the form or within each group. For a copy-editing agent that can create its own branch, choose **View site**, **Create branches**, and **Edit site content**. Add **Edit site styles** or **Edit site structure** if its job includes those changes.
2. The new connection opens in the inspector. Choose **Copy agent prompt** and paste it into the agent session. The prompt asks the agent to check the installed CLI, obtain your approval if installation is needed, then run the connection command. The versioned package comes from your installation. The command contains the origin and public account ID.
3. Match the code in the terminal with the one shown in your browser, review permissions and expiry, and choose **Authorize CLI**. After pairing, the browser returns to the connection and shows **Connected**. Creation and approval use admin step-up. Remote sites need an HTTPS public origin. A local loopback site can pair over HTTP.
4. Give the session a task such as “Create a branch called review, fix the hero heading on the homepage, check it at mobile width, and tell me what you changed.” The agent reports back in that session.

After expiry, the connection owner can choose **Renew access**, select a new lifetime, and confirm through the same step-up flow used for creation. The new window starts at renewal. A previously paired CLI can resume immediately with its existing credential and effective permissions. An unpaired connection still needs browser pairing. The same connection can be renewed again after its next expiry. **Revoke access** permanently ends access, including for an expired connection.

The selected connection has its own URL. While the inspector is visible, it refreshes the connection status and shows three recent activity rows. Repeated operations on the same branch share a count. **View all** shows up to ten individual events. The connection owner sees creation, approval, renewal with the new expiry, and revocation alongside dispatched CMS and AI operations, with the time, branch when supplied, and HTTP status on failure. The server keeps up to 100 operation records per account and stores catalog route templates in place of raw URLs or request bodies.

The CLI requires Bun 1.4. Pair on the machine running the agent. A sandboxed terminal needs permission to listen on loopback and write to its private credential directory. Pairing uses a temporary listener on 127.0.0.1, a random state, a one-minute single-use authorization code and an S256 proof. Use `connect --no-open` to open the printed URL yourself.

CLI 1.0.0 stores the opaque bearer credential in the current user’s profile. On Unix, the default directory is `~/.instatic/credentials` (0700), with one file per account (0600). On Windows the default is the Instatic credentials directory under Local AppData and it inherits the profile’s ACL. Set `INSTATIC_CREDENTIAL_DIR` to an absolute private directory for an isolated agent workspace. Protect this directory as a secret. Completing the exchange replaces the previous device credential. The CMS retains only its hash.

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

Use a page ID or a slash-prefixed slug such as `/` or `/login`. Inspect at the viewport where the problem occurs, then open the returned PNG. The JSON reports visible node IDs, bounds, horizontal overflow, inline styles and assigned rules. Each rule lists pages and components that reference its class directly. A rendered element with a null node ID has no editable target in this page.

```sh
instatic canvas inspect PAGE_ID --branch review --viewport 390x844 --out before.png
instatic api describe PATCH canvas/pages/:id
instatic canvas edit PAGE_ID --branch review --revision REVISION_FROM_INSPECT --json '[{"op":"rule","rule":"RULE_ID","context":"MOBILE_CONTEXT_ID","property":"white-space","value":"normal"}]'
instatic canvas inspect PAGE_ID --branch review --viewport 390x844 --out after.png
```

Use IDs and contexts from inspect. To focus the output, add `--node NODE_ID`. A batch accepts text on an unbound text node, an inline CSS declaration, a shared rule declaration (optionally in a responsive context), an HTML fragment under a container using `insertHtml`, or a native membership form using `memberForm`. Set a CSS value to `null` to remove the declaration. A rule edit affects every use of that selector on the branch. The CMS checks the complete batch against normal role permissions and commits it atomically. The response includes the committed page revision. After HTTP 409, read the affected pages again and reconcile the change. For document-level edits the lower-level `draft-page/:id` and `site-document` operations remain available.

Open the returned PNG in the agent’s image viewer to inspect the result. Capture uses the branch review renderer and script-disabled local Chromium. No admin tab needs to be open. Set `INSTATIC_CHROMIUM` to an installed Chromium executable, or approve installation of the matching Playwright Chromium. The screenshot result includes its absolute path, dimensions and count of skipped asset requests. Assets are fetched from the same origin without the CLI credential. Screens relying on external assets or runtime JavaScript can differ from the public page.

## Build and verify membership pages

`instatic api lookup "public signup"` returns a workflow guide and matching permitted operations. The guide includes the installation’s member settings and assigned pages when the grant allows reading them. It identifies the permissions needed for writes, describes native form actions and includes a minimal page example.

```sh
instatic canvas read / /login /signup --branch main
instatic canvas edit /signup --branch main --revision REV --json '[{"op":"memberForm","parent":"PARENT_NODE_ID","action":"signup"}]'
instatic check membership
```

Use the `document` from a canvas read as the starting point for an incremental `PUT site-document`. A single read returns the shell once and includes sequences and revisions for the requested pages. Both the document save and canvas edit return revisions. Editing a shared rule changes the shell revision for all pages on the branch.

The membership check visits the published login, signup and verification forms in a signed-out browser and tests anonymous access to the dashboard. On a disposable loopback installation, `instatic check membership --live --out ./evidence` also creates a test member, follows the confirmation email, opens the protected dashboard, signs out and signs back in. It saves screenshots of the signup result and dashboard. The test member remains on the disposable installation.

For live checks, set `INSTATIC_TEST_INBOX` to a private directory watched by your local mail-capture fixture. The CLI prints a unique test email address on stderr. Have the fixture write the captured verification URL to `<directory>/<that email>.url` within 30 seconds. The CLI checks the link’s origin and assigned verification path. The fixture can receive test mail independently of the service account’s permissions.

## Discover canvas modules and build a collection listing

`instatic canvas modules` lists insertable modules. Pass an ID such as `base.loop` for its defaults, property controls and registered property schema. Use `instatic canvas collection --branch review` to list collection IDs available on that branch. Pass a table ID or slug to get its field tokens, source options, loop properties and an `insertHtml` edit. For a named collection, `instatic api lookup "list events" --branch review` returns the same example.

Set the returned edit’s `parent` to a container from `canvas read`, then pass the edit in an array to `canvas edit` with that page’s revision. Each row renders its primary field and, for routable tables, a detail link. The example sorts by the first date field ascending when present, or by creation date descending. Choose the field, direction and row limit for the task.

## Check a branch as a visitor

`instatic visit /events --branch review` opens a fresh Chromium context, runs the branch scripts, and reports visible text, input fields, links, script errors and blocked requests. The CLI renders each document at its public path, including query strings and entry permalinks. It uses the existing branch preview renderer and checks branch permissions on each navigation. Each navigation applies the draft page’s access rule and live table protection to a signed-out visitor. Listings omit protected content. A hidden route reports 404. A route requiring sign-in stops the check with 403. The account needs **View site** and permission to preview that branch. Shared review links keep their current tokens.

Pass ordered steps with `--json` or `--file`. Use `fill` with a CSS selector or `fillLabel` with an exact field label. `clickLink` follows an exact accessible link name. Text assertions match exact visible text. Path assertions include the query and fragment.

```sh
instatic visit /events --branch review --viewport 390x844 --out detail.png \
  --json '[{"fillLabel":"Search walks","value":"fossil"},{"expectText":"Fossil walk"},{"expectHidden":"Marsh walk"},{"clickLink":"Fossil walk"},{"expectPath":"/events/fossils"}]'
```

A failed navigation or assertion exits nonzero and identifies the step. With `--out`, the CLI captures the final or failing viewport. The isolated browser receives rendered HTML and same-origin assets. The service credential stays in the CLI. Cross-origin resources, service workers, sockets, form submissions and background API calls are outside this read-only check. Use `check membership` for the published signup and login workflow.

## Permissions and lifecycle

- A connector receives grants from the same capability list as a custom role. Role management is reserved for the installation owner. **Select all** grants the available capabilities you currently hold. The connector’s scope is installation-wide. A branch ID selects a draft. A connector with site-edit capabilities can also target main. The CLI requires an explicit branch for a site-document save.
- Each CLI connection uses a distinct service account in the CMS. Content ownership, branch ownership and existing mutation audit records identify that actor. It has no interactive login. The creating administrator owns management and approval of its connection.
- Every authenticated call checks the connector’s expiry and revocation, its creator’s current account status and connector-management permission, and the intersection of the selected capabilities with the creator’s current capabilities. The target handler enforces its own row, branch, role and write-diff policies.
- The CLI can call operational HTTP endpoints under `/admin/api/cms/` and `/admin/api/ai/`, including plugin installation, user administration, exports and publishing. Each handler applies its normal capability and ownership checks. Login, personal security, connector issuance and browser workspace callbacks require a browser session. Omit `--branch` for installation-wide changes such as plugin installation and AI provider configuration. Pass `--branch` on a chat request to select the draft its server-side tools read.
- The owner confirms their password when creating the grant and authorizing the device. An authenticated service account can perform permitted operational actions for the grant’s lifetime, including sensitive actions. Browser sessions continue to use the installation’s normal step-up policy. The two nullable step-up timestamps from migration 042 are historical. Grant authorization uses the connection expiry.
- `api lookup [search terms]` searches built-in CMS and AI operations and live plugin routes for this account. Search by method, path, description, or capability. The list reflects the current grant. Every GET also supports HEAD to read response headers. Ownership, resource type and branch state are checked on the actual request.
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
