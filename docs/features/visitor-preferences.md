# Visitor Preferences

Native published-page controls for appearance, motion and decorative media.

Site Settings declares optional defaults; visitors select independent overrides in their own browser. The publisher emits a synchronous self-hosted document owner before styles, and every `base.preference` control reflects that owner's state. Canvas and private previews use the same installer with memory-only persistence.

## Contract

`src/core/visitor-preferences-schema/index.ts` owns the TypeBox schemas and derived types. `settings.visitorPreferences` is absent until enabled in Site Settings. When present, all three defaults are required and strictly validated:

| Preference | Choices | Effective behavior |
|---|---|---|
| `theme` | `system`, `default`, `alt` | Existing framework `theme-default` / `theme-alt` palettes; system follows the OS color scheme |
| `motion` | `system`, `reduced` | OS reduced motion always wins; explicit reduction adds it |
| `media` | `full`, `reduced` | Controls only declared decorative HTML5 video; independent of appearance |

The default is `{ theme: 'system', motion: 'system', media: 'full' }`. There is no claim that a palette choice measures or guarantees energy savings. Visitor selections do not write CMS data.

The document CSS sets `color-scheme: light` for the framework's default/light palette and `color-scheme: dark` for its alternate/dark palette. Native browser controls follow that scheme rather than pairing inherited dark-palette text with a light user-agent background.

## Published document owner

`src/core/visitor-preferences/runtime.ts` contains one typed installer. `browserAsset.ts` emits that installer, the pure resolver and static TypeBox-generated validators as `/_instatic/visitor-preferences.js`. The browser does not evaluate generated strings. The router serves fixed engine bytes; static publishing copies those bytes into the output slot. `visitorPreferencesHead.ts` emits the typed document configuration and synchronous script before authored styles, including pages with no visible preference control.

The preference owner in public documents reads/writes `instatic.site-preferences` in localStorage. In canvas and private previews, that owner never accesses this public store. OS changes, storage events, multiple controls and late hole content use one document owner. Changes dispatch a `CustomEvent<VisitorPreferencesState>` named `instatic:visitor-preferences-change` and notify owner subscribers.

Stored overrides are partial selections validated against the canonical schema. Invalid saved JSON is removed with visible `reset` feedback. An inaccessible store produces `unavailable`; a failed write leaves the current document functional with `session` feedback. Neither state claims that preferences were saved. These failures are logged with the `[visitor-preferences]` prefix.

## Controls and authored language

`src/modules/base/preference/` publishes a native label/select and semantic status captions. `preference` chooses one of the three dimensions. All labels, option captions and status messages are authored props, so normal catalogue/file bindings resolve them before rendering. The runtime only selects values, enables controls and switches authored status visibility; it contains no language dictionary or arbitrary text replacement.

One initiating control announces a change with `aria-live="polite"`; duplicate controls remain synchronized with `aria-live="off"`. The canvas shows a configuration placeholder until visitor defaults exist. Published controls require valid defaults, a nonempty label, every displayed option caption and every status caption. Missing catalogue values fail with a typed module error instead of producing unlabeled controls or an untranslated fallback.

## Decorative video

`base.video.playbackRole` is `content` by default. Content video retains its source, controls, loading and playback behavior. The `decorative` role requires a browser-origin root URL, `muted: true`, `controls: false`, `playsinline: true`, and configured visitor defaults. Ordinary self-hosted paths and resolved native public-file URLs are supported; remote URLs, protocol-relative URLs, backslashes and YouTube/iframe embeds are rejected.

The publisher emits the poster and declared source/loading/autoplay metadata, with no initial `src` or `autoplay` and `preload="none"`. The document owner alone attaches the source and autoplay after resolving preferences. Either reduced media or reduced motion prevents initial downloading and suspends an already loaded decorative video. Removing a decorative element also releases its playback and source; switching its authored role to content stops preference management. Poster images remain visible. The same owner manages canvas videos; invalid decorative settings remain editable through a visible placeholder.

Decorative video starts with `data-instatic-decorative-ready="false"`. The same document owner sets it to `true` when a current frame is available (`loadeddata`); empty/error events, source replacement and reduced media/motion clear it. Authored classes can use this state for a fade from a background or poster without a site script or a second loading owner. The attribute does not imply that playback is running. Content video is not managed. Event listeners are removed with the element's ownership and final document lease.

## Validation boundary

`ModuleDefinition.publishSchema` declares one TypeBox schema over resolved `{ props, settings }`. `validateModulePublishInput` runs after dynamic bindings and normal prop defaulting, before `render()`, and raises `ModulePublishValidationError` with the page/node/schema path. The common `parseModuleProps` boundary first validates/coerces every module against `propsSchema`; an unrecoverable value raises `ModulePropsValidationError` with its cause rather than replacing all authored props with module defaults. The same boundaries apply to normal SSR, private previews and hole fragments. Editorial binding fallbacks are not interpreted as resolved output.

Static publication generation validates values when it renders real public scopes and rows; request-dependent holes are validated when their fragment renders with the real request. A visitor-dependent URL cannot be known during static shell generation. The validator does not create a second tree traversal or resolve fake binding contexts.

Plugin module schemas cross QuickJS as declarative schema metadata with TypeBox symbols restored on the host. Executable transforms are rejected. The plugin builder, browser adapter and sandbox metadata all preserve `propsSchema` and `publishSchema`.

## Related

- [Publisher](publisher.md), [module engine](../reference/module-engine.md), [plugin system](plugin-system.md).
- `src/__tests__/visitorPreferences.test.ts`, `visitorPreferencesRuntime.test.ts`, `publisher/visitorPreferences.test.ts`, `typeboxSchemaWire.test.ts`, `canvasVisitorPreferences.test.tsx`, `server/visitorPreferencesPreview.test.ts`.
