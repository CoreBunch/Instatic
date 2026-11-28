# WordPress migration pilot

The WordPress exporter captures an editorial site and its public theme. The Bun converter builds a native Instatic ZIP for the existing Site Import wizard. The conversion runs offline and the operator reviews a JSON report before publishing.

## Run a migration

1. From an Instatic checkout with dependencies installed, package the plugin with `(cd integrations/wordpress && zip -r instatic-export.zip instatic-export)`. In WordPress, open **Plugins → Add Plugin → Upload Plugin**, select the ZIP and activate it. PHP needs DOM and ZipArchive. WordPress must be able to request its own anonymous pages. Pretty permalinks are required for the pilot.
2. Open **Tools → Instatic export** and download the private source ZIP. WP-CLI on the same installation can also run `wp instatic export /private/path/source.zip`. The source package contains unpublished text, raw block markup and custom field data. Store it outside the public web root.
3. From the Instatic checkout, run `bun run wordpress:convert /private/path/source.zip /private/path/site.zip [mapping.json]`. Choose a new output filename. Review `site.zip.report.json`, which lists source counts, imported totals and individual items needing attention. Keep the source ZIP for recovery.
4. On a **fresh disposable Instatic instance**, open **Data → Import site**, choose the converted ZIP, review its tables and media, then choose **Replace everything → Replace site**. This restores the shell and replaces existing destination data. Each run compiles a fresh design. Rerunning against an edited site requires manual reconciliation.
5. Publish the site design. Publish the intended public entries in Content. Open the public detail pages, archive and contact form with the original WordPress origin blocked. Keep drafts offline and resolve the report before cutover.

## What transfers

- Published pages become editable page trees through the ordinary Site Import planner and commit transaction. The homepage owns the root route. When every imported document shares an identical direct header and footer, they become one everywhere template.
- Publicly registered editorial post types become collections, including empty types. The first public entry supplies a native entry template. Entries preserve body HTML, slug, original byline, featured media and mapped fields. Imported rows start as drafts. Empty types need an entry template when the first public record is authored.
- Non-password-protected draft posts in these collections arrive as editable drafts. Private, scheduled, password-protected and unpublished page documents stay in the private source package. Other registered types appear in the source inventory. Accounts, arbitrary plugin tables, commerce transactions and private plugin configuration require separate migration work.
- Taxonomy terms become rows with parent relations. Posts retain term memberships. The source retains Gutenberg block markup, parsed blocks, repeated public meta values and values from the ACF groups discovered for each selected type. Protected metadata needs a provider adapter. The converter maps text, textarea, number, email, URL, boolean, media, gallery and single-target post relationships. Unsupported field definitions/values stay in the source package with a review item.
- The importer localizes same-origin theme stylesheets, media, image candidates and font files collected from the public pages. The converted stylesheet restores the browser defaults WordPress themes inherit before applying theme CSS. Cross-origin files, dynamic widgets, template variants, shortcodes and custom forms require review. Per-entry screenshots and source inventories are useful checks for themes with user-specific or conditional markup.
- Each archive becomes a native collection loop. The pilot keeps the first card's title link and reports a simplified card when its other contents cannot be bound. Common titles and bodies use Gutenberg and classic theme selectors. A missing required selector fails conversion with the affected URL.
- Use a mapping for site-specific selectors, galleries, contact form targets or reviewed local scripts. Text bindings refer to ACF field names. A form mapping creates a native table and binds controls by their HTML names. Its submission goes to Instatic. WordPress plugin mail delivery and webhook side effects require their own integration. The `scripts` array accepts exact root-relative JS paths that the owner has reviewed for independent operation.

See the executable [portfolio mapping](../../tests/wordpress/mapping.json), [source plugin](../../integrations/wordpress/instatic-export/instatic-export.php), [Site Import](site-import.md) and [native archive semantics](site-transfer.md).

## Reproduce the portfolio acceptance test

Use a new local WordPress site titled **Instatic disposable migration fixture**. Install ACF Pro for its Gallery field. Copy `tests/wordpress/theme` into its theme directory as `migration-pilot`, and install the exporter. Run the following from the Instatic checkout, setting the paths to the disposable WordPress root and an existing private output directory.

```sh
wp --path="$WP_ROOT" plugin activate advanced-custom-fields-pro instatic-export
wp --path="$WP_ROOT" theme activate migration-pilot
wp --path="$WP_ROOT" rewrite structure '/%postname%/'
wp --path="$WP_ROOT" eval-file "$PWD/tests/wordpress/seed.php"
wp --path="$WP_ROOT" instatic export "$PILOT_DIR/source.zip"
bun run wordpress:convert "$PILOT_DIR/source.zip" "$PILOT_DIR/site.zip" tests/wordpress/mapping.json
WORDPRESS_PILOT_BUNDLE="$PILOT_DIR/site.zip" WORDPRESS_PILOT_ORIGIN="$WP_LOCAL_ORIGIN" \
  bunx playwright test --project=e2e tests/e2e/wordpress-migration.e2e.ts
```

The browser case replaces its disposable E2E site. Run it alone. It drives the actual picker, publishes the design and entries, exercises the visitor routes with outside requests blocked, edits a client and a project field, creates another project, and submits the native contact form. It checks that draft and private project URLs return 404. Supplying the local source origin also compares six element rectangles and the complete viewport screenshots on the Atlas detail page at 390 × 844 and 1280 × 844. The ordinary Bun suite covers conversion, a failing selector and recognition of private source packages without requiring WordPress.
