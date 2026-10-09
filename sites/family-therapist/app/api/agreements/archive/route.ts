import { apiMemberContext } from "../../../../src/server/api-member-context";
import { HttpError } from "../../../../src/server/member-context";
import { agentReadErrorResponse } from "../../../../src/server/updates.mjs";
import { agreementArchiveResponse } from "../../../../src/server/agreement-archive-route";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const bucket = (await import("cloudflare:workers")).env.BUCKET;
    if (!bucket) throw new HttpError(503, "档案下载暂时无法使用。");
    return await agreementArchiveResponse(context, request, bucket);
  } catch (error) {
    const queryResponse = agentReadErrorResponse(error);
    if (queryResponse) return queryResponse;
    if (error instanceof HttpError) return Response.json({ code: typeof error.details?.code === "string" ? error.details.code : "service_unavailable", error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    console.error("Agreement archive request failed", error);
    return Response.json({ code: "storage_unavailable", error: "共同原则档案暂时无法读取，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
