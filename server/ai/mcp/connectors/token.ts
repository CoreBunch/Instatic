import { generateOpaqueToken } from '../../../oauth/secrets'

/** A personal access token for an MCP connector. Only its hash is stored. */
export function generatePersonalAccessToken(): string {
  return generateOpaqueToken('imcp_pat_')
}
