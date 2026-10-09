import { apiMemberContext } from "../../../src/server/api-member-context";
import { HttpError } from "../../../src/server/member-context";
import { DiscussionCommandError, executeDiscussionCommand, getCurrentDiscussion } from "../../../src/server/discussion-commands.mjs";
import { discussionErrorResponse } from "../../../src/server/discussion-http.mjs";
import { readBoundedJson, intakeErrorResponse } from "../../../src/server/intake-http.mjs";
import { IntakeError } from "../../../src/server/intake.mjs";

function respond(error: unknown): Response {
  if (error instanceof DiscussionCommandError) return discussionErrorResponse(error);
  if (error instanceof IntakeError) return intakeErrorResponse(error);
  if (error instanceof HttpError) return Response.json({
    code: typeof error.details?.code === "string" ? error.details.code : "api_unavailable",
    error: error.message,
  }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  console.error("Discussion command failed", error);
  return Response.json({ code: "storage_failed", error: "暂时无法处理共同议题操作。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const result = await getCurrentDiscussion({ db: context.db, scope: context.scope });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return respond(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await apiMemberContext(request);
    const command = await readBoundedJson(request);
    const receipt = await executeDiscussionCommand({ db: context.db, scope: context.scope, command });
    return Response.json(receipt, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return respond(error); }
}
