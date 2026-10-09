import { apiMemberContext } from "../../../../src/server/api-member-context";
import { HttpError } from "../../../../src/server/member-context";
import { DiscussionCommandError, getDiscussionReceipt } from "../../../../src/server/discussion-commands.mjs";
import { discussionErrorResponse } from "../../../../src/server/discussion-http.mjs";

export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const { messageId } = await params;
    const receipt = await getDiscussionReceipt({ db: context.db, scope: context.scope, messageId });
    if (!receipt) return Response.json({ code: "receipt_not_found", error: "没有找到当前成员提交的议题操作回执。" }, {
      status: 404, headers: { "Cache-Control": "private, no-store" },
    });
    return Response.json(receipt, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DiscussionCommandError) return discussionErrorResponse(error);
    if (error instanceof HttpError) return Response.json({
      code: typeof error.details?.code === "string" ? error.details.code : "api_unavailable",
      error: error.message,
    }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    console.error("Discussion receipt lookup failed", error);
    return Response.json({ code: "storage_failed", error: "暂时无法读取共同议题操作回执。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
