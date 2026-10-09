import { apiMemberContext } from "../../../src/server/api-member-context";
import { routeError, HttpError } from "../../../src/server/member-context";
import { agentReadErrorResponse, getSpaceUpdates, parseSpaceUpdateParams } from "../../../src/server/updates.mjs";

function memberErrorResponse(error: HttpError): Response {
  const response = typeof error.details?.code === "string"
    ? routeError(error)
    : Response.json({ code: "service_unavailable", error: error.message }, { status: error.status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const params = parseSpaceUpdateParams(new URL(request.url).searchParams);
    const result = await getSpaceUpdates({ db: context.db, scope: context.scope, ...params });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = agentReadErrorResponse(error);
    if (response) return response;
    if (error instanceof HttpError) return memberErrorResponse(error);
    console.error("Agent updates read failed", error);
    return Response.json({ code: "storage_unavailable", error: "共同空间暂时无法读取，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
