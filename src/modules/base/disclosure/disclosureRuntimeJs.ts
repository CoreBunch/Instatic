import { installDisclosureBehavior } from './behavior'

/** Self-contained compiled vanilla JS; served by the canonical module-JS channel. */
export const DISCLOSURE_RUNTIME_JS = `(${installDisclosureBehavior.toString()})(document);`
