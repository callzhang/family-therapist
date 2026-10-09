import { env } from "cloudflare:workers";
import { apiMemberContext } from "../../../../src/server/api-member-context";
import { therapistRunConfig } from "../../../../src/server/therapist-config";
import { createOpenAIResponsesRequest } from "../../../../src/server/openai-responses.mjs";
import { runNextTherapistTask } from "../../../../src/server/therapist-worker.mjs";
import { HttpError, routeError } from "../../../../src/server/member-context";
import { isRequestBodyEmpty } from "../../../../src/server/request-body.mjs";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!await isRequestBodyEmpty(request)) throw new HttpError(400, "此操作不接受请求正文。", { code: "request_body_not_allowed" });
    const context = await apiMemberContext(request);
    const config = therapistRunConfig();
    if (!config || !env.OPENAI_API_KEY) {
      return Response.json({ status: "unavailable", code: "provider_unconfigured", error: "咨询服务尚未配置。" },
        { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const requestResponse = await createOpenAIResponsesRequest({ apiKey: env.OPENAI_API_KEY });
    const result = await runNextTherapistTask({
      db: context.db,
      space_id: context.scope.space_id,
      actor_id: context.scope.actor_id,
      config,
      request: requestResponse,
    });
    return Response.json(result, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof HttpError) return routeError(error);
    return Response.json({ status: "unavailable", code: "worker_unavailable", error: "咨询任务暂时无法处理。" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
