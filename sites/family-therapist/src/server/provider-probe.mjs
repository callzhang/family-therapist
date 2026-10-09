import { ResponsesProviderError } from './openai-responses.mjs';

const PROBE_INPUT = 'Reply exactly OK.';

/** @param {{model: string, request: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>}} options */
export async function runProviderProbe({ model, request }) {
  const startedAt = performance.now();
  const metadata = {
    status: null,
    elapsed_ms: 0,
    output_tokens: null,
    output_types: [],
  };

  try {
    const response = await request({
      model,
      input: PROBE_INPUT,
      reasoning: { effort: 'medium' },
      max_output_tokens: 128,
    });
    return {
      ...metadata,
      status: typeof response.status === 'string' ? response.status : null,
      elapsed_ms: Math.round(performance.now() - startedAt),
      output_tokens: Number.isSafeInteger(response.usage?.output_tokens) ? response.usage.output_tokens : null,
      output_types: Array.isArray(response.output)
        ? response.output.flatMap((item) => typeof item?.type === 'string' ? [item.type] : [])
        : [],
    };
  } catch (error) {
    if (!(error instanceof ResponsesProviderError)) throw error;
    return {
      ...metadata,
      elapsed_ms: Math.round(performance.now() - startedAt),
      error_code: /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : 'provider_error',
      http_status: Number.isSafeInteger(error.status) ? error.status : null,
    };
  }
}
