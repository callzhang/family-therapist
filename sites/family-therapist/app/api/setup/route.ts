import { env } from "cloudflare:workers";
import { MemberSetupError, initializeMemberSpace } from "../../../src/server/member-setup.mjs";
import { MemberTokenError } from "../../../src/server/member-token.mjs";

function errorResponse(error: unknown): Response {
  if (error instanceof MemberTokenError) {
    const code = error.code === "member_token_required" ? "member_token_required" : "invalid_member_token";
    const message = code === "member_token_required" ? "需要成员令牌。" : "成员令牌无效。";
    return Response.json({ code, error: message }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }
  if (error instanceof MemberSetupError) {
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  }
  return Response.json({ code: "setup_unavailable", error: "暂时无法验证共同空间初始化状态，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return errorResponse(new Error("database unavailable"));
  try {
    const result = await initializeMemberSpace({ db: env.DB, seedJson: env.THERAPIST_MEMBER_SEED, request });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
