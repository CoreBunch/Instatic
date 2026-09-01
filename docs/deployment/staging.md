# Staging Environment

Instatic staging uses two independent instances: production keeps its own database and uploads, while staging runs continuously against a second database on a separate origin such as `https://staging.example.com`. Production pushes a validated site-transfer payload to staging only when an authorized operator requests a refresh.

## Configure the staging instance

Deploy the same Instatic version as production with a separate `DATABASE_URL`, a separate persistent `UPLOADS_DIR`, and its own `INSTATIC_SECRET_KEY`. Route the staging subdomain to that service, then set:

```txt
INSTATIC_ENVIRONMENT=staging
STAGING_SYNC_TOKEN=<at-least-32-random-bytes>
PUBLIC_ORIGIN=https://staging.example.com
```

Generate the receiver token with a cryptographically secure secret generator, for example `openssl rand -hex 32`. The receiver route returns 404 unless both staging mode and a token are configured. It accepts only a constant-time-checked bearer token and is not authenticated by an admin browser session.

Complete the staging instance's setup wizard once so it has an active owner. A refresh imports the selected production state and republishes it using that local owner identity.

## Connect production

Open **Settings > Staging** on production and enter the staging origin, the exact receiver token, whether to include the site shell, and either all data tables or a selected table set. Save the configuration, then use **Test connection**.

The token is encrypted with production's `INSTATIC_SECRET_KEY` and is never returned by the API. If that key changes, the UI requires the token to be entered again.

## Refresh behavior

**All database tables** uses the existing full replacement import: staging rows and custom table definitions absent from production are removed. **Selected tables** replaces only the selected tables and their rows; other staging tables remain untouched. Redirects targeting synchronized rows travel with the payload. The site shell is optional in either mode.

After the import commits, staging runs the normal full-site publish pipeline so the subdomain updates in the same request. Configuration changes and refreshes require the `deployment.manage` capability and a fresh step-up authentication window. Each action is recorded in the audit log, and the latest refresh status is persisted for the Settings screen.

Uploaded media bytes are not copied by database refresh. Keep staging uploads on separate persistent storage and mirror the required files with the normal backup/storage tooling when production content references local media. This prevents a database refresh from silently overwriting or deleting an independently managed staging media volume.

The validated JSON database payload is limited to 64 MiB. For a larger dataset,
reduce the refresh to selected tables or use the normal database backup and restore
workflow for the initial staging seed.

## Safety rules

- Never set `INSTATIC_ENVIRONMENT=staging` on production.
- Use HTTPS for remote staging origins. Plain HTTP is accepted only for loopback development addresses.
- Give production and staging different databases, upload volumes, and `INSTATIC_SECRET_KEY` values.
- Rotate `STAGING_SYNC_TOKEN` immediately if it is exposed, then update the saved production configuration.
- Keep both instances on the same release before refreshing; the standard migration runner should complete on staging first.
