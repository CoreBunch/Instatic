/**
 * The server's own version, read from `package.json` at build time. A running
 * instance reports it through the Manager API so a supervising manager knows
 * which release it is talking to.
 */
import pkg from '../package.json' with { type: 'json' }

export const SERVER_VERSION: string = pkg.version
