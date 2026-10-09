const MAX_EMPTY_CHUNKS = 32;

export async function isRequestBodyEmpty(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || BigInt(contentLength) !== 0n)) {
    try { await request.body?.cancel(); } catch { /* A locked or failed body stays rejected. */ }
    return false;
  }

  if (request.body === null) return true;

  const reader = request.body.getReader();
  let ended = false;
  try {
    for (let chunks = 0; chunks < MAX_EMPTY_CHUNKS; chunks += 1) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        return true;
      }
      if (value?.byteLength) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (!ended) {
      try { await reader.cancel(); } catch { /* A failed or already closed body remains rejected. */ }
    }
    try { reader.releaseLock(); } catch { /* A still-pending read keeps the stream locked. */ }
  }
}
