/**
 * Tool classification — which agent tools need which pre-flight step.
 *
 * Kept beside the executor rather than inside it so adding a tool means
 * editing one table, and the dispatch stays a dispatch.
 */

/**
 * Tools that target a node by id and should switch the canvas to that node's
 * document before running, so the mutation lands in the right tree and stays
 * visible to the user.
 *
 * Excludes catalog/page/token tools (no node target) and
 * `site_render_snapshot` (captures the live DOM, so a node outside the
 * mounted canvas is genuinely uncapturable, not navigable).
 */
export const AUTO_NAVIGATE_TOOLS: ReadonlySet<string> = new Set([
  'site_insert_html',
  'site_get_node_html',
  'site_replace_node_html',
  'site_delete_node',
  'site_update_node_props',
  'site_move_node',
  'site_rename_node',
  'site_duplicate_node',
  'site_assign_class',
  'site_remove_class',
  // Component tools target a node too: `site_create_component` componentizes
  // `fromNodeId` (which must be on the active PAGE), `site_insert_component`
  // places a ref under `parentId`, and `site_bind_component_prop` binds a node
  // inside the component definition.
  'site_create_component',
  'site_insert_component',
  'site_bind_component_prop',
  'site_bind_component_variant',
])

/**
 * Tools that mutate the site document, and therefore must wait for every
 * collab doc to finish its first sync before running.
 *
 * A write landing inside that window is refused wholesale — correctly, since
 * it could never reach the relay — but the tool would still report the ids it
 * meant to create, so the caller saw success and an empty document. Human
 * editing never hits this (the gate is sub-second); a tool chain that creates
 * a page and immediately fills it hits it nearly every time.
 */
export const SITE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'site_insert_html',
  'site_replace_node_html',
  'site_delete_node',
  'site_update_node_props',
  'site_move_node',
  'site_rename_node',
  'site_duplicate_node',
  'site_assign_class',
  'site_remove_class',
  'site_apply_css',
  'site_add_page',
  'site_delete_page',
  'site_rename_page',
  'site_duplicate_page',
  'site_set_page_template',
  'site_clear_page_template',
  'site_set_color_tokens',
  'site_set_font_tokens',
  'site_set_type_scale',
  'site_set_spacing_scale',
  'site_write_code_asset',
  'site_patch_code_asset',
  'site_create_component',
  'site_insert_component',
  'site_set_component_params',
  'site_bind_component_prop',
  'site_bind_component_variant',
])
