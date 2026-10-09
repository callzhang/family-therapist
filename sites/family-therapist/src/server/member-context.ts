import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { createQueryExecutor, QueryReadError } from "./queries.mjs";
import { authenticateBrowserMember } from "./browser-member.mjs";
import { MemberTokenError } from "./member-token.mjs";
import { snapshotSequence } from "./snapshot-sequence.mjs";

type D1 = NonNullable<Cloudflare.Env["DB"]>;
export type MemberContext = {
  user: { userId: string };
  db: D1;
  execute: ReturnType<typeof createQueryExecutor>;
  scope: { actor_id: string; space_id: string; snapshot_seq: number; purpose: "member_view" };
  role: string;
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

export async function memberContext(): Promise<MemberContext> {
  const db = env.DB;
  if (!db) throw new HttpError(503, "共同空间暂时无法读取，请稍后重试。");
  let identity: Awaited<ReturnType<typeof authenticateBrowserMember>>;
  try {
    const requestHeaders = await headers();
    identity = await authenticateBrowserMember({ db, cookieHeader: requestHeaders.get("cookie") });
  } catch (error) {
    if (error instanceof MemberTokenError) throw new HttpError(401, "请输入你的个人连接码以进入共同空间。", { code: "requires_member_token" });
    throw error;
  }
  const snapshot = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS snapshot_seq FROM messages WHERE space_id = ?").bind(identity.space_id).first<{ snapshot_seq: number }>();
  const snapshotSeq = snapshotSequence(snapshot);
  if (snapshotSeq === null) throw new HttpError(503, "暂时无法建立一致的读取快照，请稍后重试。", { code: "snapshot_unavailable" });
  return {
    user: { userId: identity.actor_id },
    db,
    execute: createQueryExecutor(db),
    scope: { actor_id: identity.actor_id, space_id: identity.space_id, snapshot_seq: snapshotSeq as number, purpose: "member_view" },
    role: identity.role,
  };
}

export function routeError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message, ...error.details }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  if (error instanceof QueryReadError) {
    const messages: Record<string, string> = {
      invalid_scope: "读取范围无效。",
      unsupported_purpose: "不支持此读取方式。",
      unsupported_query: "不支持此读取请求。",
      membership_required: "当前成员尚未加入共同空间。",
      transcript_forbidden: "这段对话当前不可读取。",
      thread_not_found: "共同空间中没有找到这段对话。",
      message_not_found: "共同空间中没有找到这条记录。",
      invalid_cursor: "读取位置已失效，请重新打开对话。",
      agreement_thread_not_found: "共同空间中没有找到相关议题。",
      invalid_result_set: "共同空间暂时无法读取，请稍后重试。",
      invalid_message_json: "一条已保存记录无法正常解析，请联系维护者。",
      invalid_record: "一条已保存的共同理解记录格式无效，请联系维护者。",
    };
    return Response.json({ error: messages[error.code] ?? "读取失败，请稍后重试。" }, { status: error.status });
  }
  console.error("Read-only member view failed", error);
  return Response.json({ error: "暂时无法读取共同空间，请稍后重试。" }, { status: 503 });
}
