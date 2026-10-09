import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../app/chatgpt-auth";
import { createQueryExecutor, QueryReadError } from "./queries.mjs";
import { chatGPTSignInPath } from "../../app/chatgpt-auth";

type D1 = NonNullable<Cloudflare.Env["DB"]>;
export type MemberContext = {
  user: NonNullable<Awaited<ReturnType<typeof getChatGPTUser>>>;
  db: D1;
  execute: ReturnType<typeof createQueryExecutor>;
  scope: { actor_id: string; space_id: string; snapshot_seq: number; purpose: "member_view" };
  role: string;
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

export async function memberContext(): Promise<MemberContext> {
  const user = await getChatGPTUser();
  if (!user) throw new HttpError(401, "请先使用 ChatGPT 登录，再查看共同空间。", { sign_in_url: chatGPTSignInPath("/") });
  const db = env.DB;
  if (!db) throw new HttpError(503, "共同空间暂时无法读取，请稍后重试。");
  const membership = await db.prepare("SELECT space_id, role FROM members WHERE user_id = ? LIMIT 2").bind(user.userId).all();
  const matches = membership.results ?? [];
  if (matches.length === 0) throw new HttpError(403, "当前账号尚未加入共同空间。");
  if (matches.length !== 1) throw new HttpError(403, "当前账号对应多个共同空间，暂时无法确定读取范围。");
  const row = matches[0] as { space_id: string; role: string };
  const snapshot = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS snapshot_seq FROM messages WHERE space_id = ?").bind(row.space_id).first<{ snapshot_seq: number }>();
  if (!snapshot) throw new HttpError(503, "暂时无法建立一致的读取快照，请稍后重试。");
  return {
    user,
    db,
    execute: createQueryExecutor(db),
    scope: { actor_id: user.userId, space_id: row.space_id, snapshot_seq: snapshot.snapshot_seq, purpose: "member_view" },
    role: row.role,
  };
}

export function routeError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message, ...error.details }, { status: error.status });
  if (error instanceof QueryReadError) {
    const messages: Record<string, string> = {
      invalid_scope: "读取范围无效。",
      unsupported_purpose: "不支持此读取方式。",
      unsupported_query: "不支持此读取请求。",
      membership_required: "当前账号尚未加入共同空间。",
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
