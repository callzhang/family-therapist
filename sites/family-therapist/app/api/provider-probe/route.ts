import { env } from "cloudflare:workers";
import { apiMemberContext } from "../../../src/server/api-member-context";
import { therapistRunConfig } from "../../../src/server/therapist-config";
import { createResponsesRequest, ResponsesProviderError } from "../../../src/server/openai-responses.mjs";
import { runProviderProbe } from "../../../src/server/provider-probe.mjs";
import { HttpError, routeError } from "../../../src/server/member-context";
import { isRequestBodyEmpty } from "../../../src/server/request-body.mjs";
import { createNdjsonWorkStream } from "../../../src/server/ndjson-work-stream.mjs";

const messageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailableResponse(code = "provider_unconfigured", status = 503): Response {
  return Response.json({ status: "unavailable", code }, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const url = new URL(request.url);
    const messageId = url.searchParams.get("message_id");
    if (url.searchParams.size !== 1 || !messageIdPattern.test(messageId ?? "")) {
      throw new HttpError(400, "message_id 必须是有效的 UUID。", { code: "invalid_message_id" });
    }

    const task = await context.db.prepare(`SELECT checkpoint_json, run_config_json, status
      FROM therapist_tasks WHERE space_id = ? AND message_id = ?`)
      .bind(context.scope.space_id, messageId)
      .first<{ checkpoint_json: string | null; run_config_json: string | null; status: string }>();
    if (!task) {
      return Response.json({ error: "Task not found." }, {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    return Response.json(task, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof HttpError) return routeError(error);
    return Response.json({ error: "Provider probe state is unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
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
