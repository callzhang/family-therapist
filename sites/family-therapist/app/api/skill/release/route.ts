import { apiMemberContext } from "../../../../src/server/api-member-context";
import { routeError, HttpError } from "../../../../src/server/member-context";
import { agentReadErrorResponse } from "../../../../src/server/updates.mjs";
import { skillReleaseBundle } from "../../../../src/server/skill-release-bundle.mjs";

function failure(error: HttpError): Response {
  const response = typeof error.details?.code === "string"
    ? routeError(error)
    : Response.json({ code: "service_unavailable", error: error.message }, { status: error.status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  try {
    await apiMemberContext(request);
    return Response.json(skillReleaseBundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = agentReadErrorResponse(error);
    if (response) return response;
    if (error instanceof HttpError) return failure(error);
    console.error("Agent Skill release read failed", error);
    return Response.json({ code: "storage_unavailable", error: "共享空间暂时无法读取，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
