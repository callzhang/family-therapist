import { apiMemberContext } from "../../../../src/server/api-member-context";
import { HttpError, routeError } from "../../../../src/server/member-context";
import { IntakeError } from "../../../../src/server/intake.mjs";
import { intakeErrorResponse, readBoundedJson } from "../../../../src/server/intake-http.mjs";
import { agentReadErrorResponse, validateAgentQueryArguments } from "../../../../src/server/updates.mjs";

function memberErrorResponse(error: HttpError): Response {
  const response = typeof error.details?.code === "string"
    ? routeError(error)
    : Response.json({ code: "service_unavailable", error: error.message }, { status: error.status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const { name } = await params;
    const rawArguments = await readBoundedJson(request);
    const arguments_ = validateAgentQueryArguments(name, rawArguments);
    const result = await context.execute(name, arguments_, context.scope);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof IntakeError) return intakeErrorResponse(error);
    const response = agentReadErrorResponse(error);
    if (response) return response;
    if (error instanceof HttpError) return memberErrorResponse(error);
    console.error("Agent query failed", error);
    return Response.json({ code: "storage_unavailable", error: "暂时无法读取共同空间，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
