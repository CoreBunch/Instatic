/**
 * HTML importer — legacy rule-based mapping (REPLACED).
 *
 * Phase 3 of the Lossless HTML-Node Roundtrip migration replaced the
 * imperative `HTML_TO_MODULE_RULES` table with a two-phase approach:
 *
 *   1. Every element becomes a DOM-native node (`tag`, `attributes`,
 *      `textContent`) via `createDomNode`.
 *   2. `registry.getByClaimSelector(el)` checks each module's
 *      `htmlContract.claimSelector` against the element. The first match
 *      wins; `htmlContract.fromHtml(el)` extracts overlay props.
 *
 * Module overlays are optional and additive — they provide editing UX but
 * never discard HTML fidelity. Unclaimed attributes remain in
 * `node.attributes` and serialize directly to HTML.
 *
 * The actual walk logic lives in `walkAndMap.ts`.
 */
