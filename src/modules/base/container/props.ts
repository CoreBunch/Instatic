import { Type, type Static } from '@core/utils/typeboxHelpers'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const ContainerPropsSchema = Type.Object({
  tag: Type.String({ default: 'div' }),
  customTag: Type.String({ default: '' }),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
  /**
   * Auth gate (D16) — a list of member group ids allowed to view this
   * container's subtree. An empty array (default) means NOT gated (public).
   * When non-empty, the container publishes as an `<instatic-gated>`
   * placeholder carrying the module's `staticPlaceholder` fallback, and a
   * runtime observer lazy-fetches the real subtree from
   * `/_instatic/gate/<nodeId>`, which renders it only for visitors who are a
   * member of at least one of the listed groups. Everyone else — including
   * anonymous visitors and JS-less clients — sees the baked fallback.
   *
   * Phase 3 unified gating on groups: the Phase-2 role-based gate (member /
   * admin string) is retired in favour of this group list, the single concept
   * used for both page-level (D14) and section-level gating.
   */
  authGate: Type.Array(Type.String(), { default: [] }),
})

export type ContainerStoredProps = Static<typeof ContainerPropsSchema>
