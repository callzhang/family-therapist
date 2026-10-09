import { env } from "cloudflare:workers";
import { apiMemberContext } from "../../../src/server/api-member-context";
import { therapistRunConfig } from "../../../src/server/therapist-config";
import { createResponsesRequest, ResponsesProviderError } from "../../../src/server/openai-responses.mjs";
import { runProviderProbe } from "../../../src/server/provider-probe.mjs";
import { HttpError, routeError } from "../../../src/server/member-context";
import { isRequestBodyEmpty } from "../../../src/server/request-body.mjs";
import { createNdjsonWorkStream } from "../../../src/server/ndjson-work-stream.mjs";

function unavailableResponse(code = "provider_unconfigured", status = 503): Response {
  return Response.json({ status: "unavailable", code }, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!await isRequestBodyEmpty(request)) {
      throw new HttpError(400, "此操作不接受请求正文。", { code: "request_body_not_allowed" });
    }
    await apiMemberContext(request);
    const config = therapistRunConfig();
    if (!config || !env.THERAPIST_API_KEY || !env.THERAPIST_API_BASE_URL) return unavailableResponse();

    const providerRequest = await createResponsesRequest({
      apiKey: env.THERAPIST_API_KEY,
      baseUrl: env.THERAPIST_API_BASE_URL,
    });

    return createNdjsonWorkStream(
      (signal) => runProviderProbe({
        model: config.model,
        request: (payload) => providerRequest(payload, { signal }),
      }),
      { requestSignal: request.signal },
    );
  } catch (error) {
    if (error instanceof HttpError) return routeError(error);
    if (error instanceof ResponsesProviderError) return unavailableResponse(error.code, error.status ?? 503);
    return unavailableResponse("provider_probe_unavailable");
  }
}
