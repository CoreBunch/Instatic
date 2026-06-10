/**
 * Gated fetch shim evaluated inside every plugin QuickJS VM.
 *
 * Plugins with 'network.outbound' permission AND a matching networkAllowedHosts
 * entry can issue outbound HTTP. The host enforces both checks; this shim
 * provides a Response-like facade for the familiar fetch API.
 *
 * Bodies are byte-safe in both directions. Request bodies accept
 * `string | ArrayBuffer | TypedArray/DataView` — strings travel as UTF-8
 * text, buffers as base64 (anything else throws a TypeError instead of
 * silently stringifying). Response bodies arrive from the host tagged with
 * `bodyEncoding` ('utf8' | 'base64'); `text()`/`json()` decode through
 * TextDecoder and `arrayBuffer()` returns the exact upstream bytes. The
 * base64 codec comes from base64.ts (shared with the crypto shim).
 *
 * AbortSignal threading: each call mints a unique abortId and, if the
 * plugin's signal aborts, fires network.abort to cancel the host-side
 * in-flight request.
 */

export const FETCH_SHIM = `// ------- gated fetch -------
// Plugins with the 'network.outbound' permission AND a matching entry in
// the manifest's networkAllowedHosts can issue outbound HTTP. The host
// enforces both checks (kernel-of-correctness); this shim provides a
// Response-like façade so plugin code can use the familiar fetch API.
//
// AbortSignal threading: each call mints a unique abortId and registers
// it on the host. If the plugin's signal aborts before the host fetch
// completes, the polyfill fires the network.abort api-call so the host's
// AbortController cancels the in-flight request instead of waiting for
// it to settle. The host fetch's pending promise is also raced against
// a local rejection so the plugin's await resolves immediately.
let __fetch_abort_seq = 0;

function __materializeResponse(result) {
  const isBase64 = result.bodyEncoding === 'base64';
  function bodyBytes() {
    return isBase64 ? __base64ToBytes(result.body) : new TextEncoder().encode(result.body);
  }
  function bodyText() {
    return isBase64 ? new TextDecoder().decode(__base64ToBytes(result.body)) : result.body;
  }
  return {
    status: result.status,
    ok: result.ok,
    headers: {
      get: function (name) { return result.headers[String(name).toLowerCase()] || null; },
      has: function (name) { return Object.prototype.hasOwnProperty.call(result.headers, String(name).toLowerCase()); },
      forEach: function (cb) { for (const k of Object.keys(result.headers)) cb(result.headers[k], k); },
    },
    text: async function () { return bodyText(); },
    json: async function () { return JSON.parse(bodyText()); },
    arrayBuffer: async function () {
      const bytes = bodyBytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

// Serialize a fetch request body for the wire. Strings travel as UTF-8
// text; ArrayBuffers and TypedArray/DataView views travel as base64 so the
// host sends the exact bytes upstream. Everything else (FormData, Blob,
// URLSearchParams, streams) is rejected loudly — silently coercing to
// '[object FormData]' was a data-corruption bug.
function __serializeFetchBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return { body: body, bodyEncoding: 'utf8' };
  if (body instanceof ArrayBuffer) {
    return { body: __bytesToBase64(new Uint8Array(body)), bodyEncoding: 'base64' };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: __bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      bodyEncoding: 'base64',
    };
  }
  const tag = Object.prototype.toString.call(body).slice(8, -1);
  throw new TypeError(
    'fetch body must be a string, ArrayBuffer, or TypedArray/DataView in the plugin sandbox (got ' + tag + '). ' +
    'FormData, Blob, URLSearchParams, and streams are not supported — serialize to a string or bytes first.',
  );
}

function __abortError(reason) {
  if (reason && typeof reason === 'object') return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

globalThis.fetch = async function fetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
  const opts = init && typeof init === 'object' ? init : {};
  const serializedBody = __serializeFetchBody(opts.body);
  const serialized = {
    method: typeof opts.method === 'string' ? opts.method : 'GET',
    headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {},
  };
  if (serializedBody) {
    serialized.body = serializedBody.body;
    serialized.bodyEncoding = serializedBody.bodyEncoding;
  }
  const signal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
  if (signal && signal.aborted) throw __abortError(signal.reason);

  __fetch_abort_seq += 1;
  const abortId = 'a' + __fetch_abort_seq + '_' + Date.now().toString(36);
  serialized.abortId = abortId;

  const hostPromise = __hostCall('network.fetch', [url, serialized]);

  if (!signal) {
    const result = await hostPromise;
    return __materializeResponse(result);
  }

  // Race the host fetch against the signal — if abort wins, also tell the
  // host to cancel the in-flight request so its socket / response stream
  // is torn down instead of leaking until natural completion.
  let abortListener = null;
  const abortPromise = new Promise(function (_, reject) {
    abortListener = function () {
      reject(__abortError(signal.reason));
      // Fire-and-forget — if the host call already returned, the host's
      // map entry is gone and this is a no-op.
      try { __hostCall('network.abort', [{ abortId: abortId }]); } catch (_) {}
    };
    signal.addEventListener('abort', abortListener);
  });

  try {
    const result = await Promise.race([hostPromise, abortPromise]);
    return __materializeResponse(result);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
};

`
