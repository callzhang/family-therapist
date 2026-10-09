import { env } from "cloudflare:workers";
import { BrowserMemberError, clearBrowserMemberSession, createBrowserMemberSession } from "../../../src/server/browser-member.mjs";
import { MemberTokenError } from "../../../src/server/member-token.mjs";

function errorResponse(error: unknown): Response {
  if (error instanceof MemberTokenError) {
    const code = error.code === "member_token_required" ? "requires_member_token" : "invalid_member_token";
    const message = code === "requires_member_token" ? "请输入你的个人连接码以进入共同空间。" : "连接码无效，请检查后重试。";
    return Response.json({ code, error: message }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }
  if (error instanceof BrowserMemberError) {
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  }
  return Response.json({ code: "service_unavailable", error: "暂时无法建立共同空间会话，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return errorResponse(new Error("database unavailable"));
  try { return await createBrowserMemberSession({ db: env.DB, request }); }
  catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request): Promise<Response> {
  try { return clearBrowserMemberSession(request); }
  catch (error) { return errorResponse(error); }
}
