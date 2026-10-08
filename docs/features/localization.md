# Language files

Language files supply shared interface text to native page and Visual Component nodes during canvas rendering and publication.

## TL;DR

- **General settings → Language files** creates ordinary JSON SiteFiles and opens them in the native code editor.
- `settings.localization.catalogues` maps language tags to stable file IDs. `settings.language` is the default; `page.language` overrides it explicitly.
- Bind shared labels with `{site.translations.header.contact}`. The normal native binding engine resolves text, attributes, and SEO text.
- Dictionary JSON is not downloaded by visitors. Localized HTML is baked statically, with the resolved language on `<html lang>`.
- Malformed files, mismatched key sets, missing translations, empty text, and unconfigured page languages prevent publication. There is no implicit fallback to another language.

## Catalogue shape

```json
{
  "language": "en",
  "messages": {
    "header": { "contact": "Contact us" },
    "common": { "readMore": "Read more" }
  }
}
```

The file has `type: 'config'` and a `.json` path, for example `locales/en.json`. Nested dictionaries contain strings only. Keys start with a letter and contain letters, digits, underscores or hyphens; dots separate paths in bindings. Reserved object keys are rejected. All configured languages must declare identical leaf keys. Adding a language creates the same key structure with empty values so authors translate it explicitly before publication.

`src/core/localization-schema/index.ts` owns the TypeBox schemas. `src/core/localization/index.ts` validates configured files, canonicalizes BCP-47 tags, checks key coverage, and resolves one language. `LocalizationError.path` identifies the file or key to fix. Cached catalogues revalidate when mappings or file content change.

## Native bindings and reusable components

`buildSiteFrame(site, page.language)` adds `language` and `translations` to the existing Site binding frame. The native picker lists dictionary leaves under **Translations** and shows the current language's value. Both inline string tokens and whole-prop bindings use the same strict translation resolver.

A shared Visual Component can contain a token directly, or bind text to a native parameter whose default/instance value is a token. Its structure is authored once; localized copies of the component are unnecessary. Slots continue to host editorial content as ordinary CMS nodes.

Plain translation text passes through the publisher's normal escaping. Rich-text destinations continue to use the existing markdown/sanitization boundary. Language dictionaries are text data, not executable scripts, page trees or rendered HTML caches.

## Editing and publication

Page settings allow an explicit language or inheritance from the site default. The language is stored in `data_rows.cells_json.language`, carried by the page's Y-document metadata, and preserved through duplication and template composition. Migration `031_page_language` appends the built-in field to every existing pages table in both database dialects; it does not replace table fields or content.

The canvas and publisher build the same language frame. Invalid intermediate JSON confines the preview error to the canvas boundary while the code editor remains usable; correcting the file restores the preview. Inline editing does not replace a translation token with resolved literal text. Edit the language file through General settings instead.

Language bindings are known at publication time and do not introduce dynamic holes or a DOM translation runtime. Root body attributes also resolve through the native binding engine before HTML attribute sanitization.

Full-site publication validates all configured catalogues, page languages and authored translation references before creating published snapshots or page versions. This includes shared component defaults and instance values, native attributes, whole-prop bindings and site SEO text. Escaped literal tokens retain the normal token parser behavior. Invalid translations leave the previous publication active; the publish endpoint returns a 422 error envelope naming the file or key to fix, surfaced by the existing operation toast.

## Content boundaries

Use language files for shared labels, accessibility text, validation messages and reusable interface copy. Editorial pages, articles, and authored rich content remain in the CMS, with their explicit language. Product identifiers, quantities, prices and route alternatives are structured domain/route data, not translation strings.

## Related

- [Templates and bindings](templates.md)
- [Visual Components](visual-components.md)
- [Site shell and files](site-shell.md)
- [Content storage](content-storage.md)
