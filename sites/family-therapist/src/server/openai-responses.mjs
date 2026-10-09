const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

export class ResponsesProviderError extends Error {
  constructor(message, { code = 'provider_error', status = null, request_id = null } = {}) {
    super(message);
    this.name = 'ResponsesProviderError';
    this.code = code;
    this.status = status;
    this.request_id = request_id;
  }
}

async function boundedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('response limit exceeded').catch(() => {});
        throw new ResponsesProviderError('Provider response exceeded the configured limit.', { code: 'provider_response_too_large' });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/i.test(value) ? value : null;
}

function combineAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Provider request timed out.', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, cleanup: () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  } };
}

/** @param {{apiKey: string, baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} options Makes a server-authenticated Responses call to a configured HTTPS endpoint. */
export async function createResponsesRequest({ apiKey, baseUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ResponsesProviderError('Provider credentials are unavailable.', { code: 'provider_unconfigured' });
  let endpoint;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('invalid');
    endpoint = `${base.href.replace(/\/$/, '')}/responses`;
  } catch {
    throw new ResponsesProviderError('Provider configuration is invalid.', { code: 'provider_unconfigured' });
  }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new ResponsesProviderError('Provider configuration is invalid.', { code: 'provider_unconfigured' });
  return async function request(payload, { signal: callSignal } = {}) {
    const requestSignal = combineAbortSignal(callSignal ?? signal, timeoutMs);
    try {
      if (requestSignal.signal.aborted) throw new ResponsesProviderError('Provider request could not be completed.', { code: 'provider_transport_error' });
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'manual', signal: requestSignal.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'FamilyTherapist/1.0' },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new ResponsesProviderError('Provider request could not be completed.', { code: 'provider_transport_error' });
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ResponsesProviderError('Provider redirect responses are not allowed.', { code: 'provider_redirect_error' });
      }
      const requestIdHeader = response.headers.get('x-request-id');
      const requestId = requestIdHeader && /^[\w.-]{1,128}$/.test(requestIdHeader) ? requestIdHeader : null;
      let text;
      try { text = await boundedText(response, MAX_RESPONSE_BYTES); }
      catch (error) {
        if (error instanceof ResponsesProviderError) throw error;
        if (requestSignal.signal.aborted) throw new ResponsesProviderError('Provider request could not be completed.', { code: 'provider_transport_error' });
        throw new ResponsesProviderError('Provider returned an unreadable response.', { code: 'provider_invalid_response', status: response.status, request_id: requestId });
      }
      if (!response.ok) {
        let providerCode = null;
        try { providerCode = safeCode(JSON.parse(text)?.error?.code); } catch { /* The body is intentionally not exposed. */ }
        throw new ResponsesProviderError('Provider request failed.', { code: providerCode ?? 'provider_http_error', status: response.status, request_id: requestId });
      }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
        return value;
      } catch {
        throw new ResponsesProviderError('Provider returned an invalid response.', { code: 'provider_invalid_response', status: response.status, request_id: requestId });
      }
    } finally { requestSignal.cleanup(); }
  };
}
