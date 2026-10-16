/**
 * Canonical client-side HTTP layer. Import the transport from here:
 *
 *   import { apiRequest, ApiError, isAbortError } from '@core/http'
 */
export {
  apiRequest,
  apiBlobRequest,
  apiTextRequest,
  readEnvelope,
  assertOk,
  responseErrorMessage,
  ApiError,
  isAbortError,
  registerApiErrorListener,
  type ApiErrorListener,
  type ApiErrorRequest,
  type FetchLike,
} from './apiClient'
export {
  ambientRequestHeaders,
  registerRequestHeaderProvider,
  withAmbientHeaders,
  type RequestHeaderProvider,
} from './requestHeaders'
