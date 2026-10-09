const DEFAULT_INTERVAL_MS = 5_000;

function encodedFrame(encoder, value) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

/**
 * Keep the request open while an async job runs and publish only bounded status frames.
 * @param {(signal: AbortSignal) => Promise<unknown>} run
 * @param {{requestSignal?: AbortSignal, intervalMs?: number}} [options]
 * @returns {Response}
 */
export function createNdjsonWorkStream(run, { requestSignal, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (typeof run !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('ndjson_stream_config_invalid');
  }

  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let timer;
  let streamController;
  let closed = false;

  const stop = (reason) => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!abortController.signal.aborted) abortController.abort(reason);
    requestSignal?.removeEventListener('abort', onRequestAbort);
  };

  const onRequestAbort = () => {
    stop(requestSignal?.reason);
    try { streamController?.close(); } catch { /* The consumer may already have canceled the stream. */ }
  };

  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(encodedFrame(encoder, { event: 'started' }));

      if (requestSignal?.aborted) onRequestAbort();
      else requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

      if (!closed) {
        timer = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encodedFrame(encoder, { event: 'keepalive' })); }
          catch { stop(); }
        }, intervalMs);
      }

      if (!closed) {
        Promise.resolve().then(() => run(abortController.signal)).then((result) => {
          if (closed) return;
          controller.enqueue(encodedFrame(encoder, { event: 'result', result }));
          stop();
          controller.close();
        }).catch(() => {
          if (closed) return;
          controller.enqueue(encodedFrame(encoder, { event: 'error', code: 'worker_unavailable' }));
          stop();
          controller.close();
        });
      }
    },
    cancel(reason) { stop(reason); },
  });

  return new Response(body, { status: 200, headers: {
    'Cache-Control': 'private, no-store, no-transform',
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'X-Accel-Buffering': 'no',
  } });
}
