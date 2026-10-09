import { env } from "cloudflare:workers";
import { createQueryExecutor } from "./queries.mjs";
import { authenticateMemberToken, MemberTokenError } from "./member-token.mjs";
import { HttpError } from "./member-context";

type D1 = NonNullable<Cloudflare.Env["DB"]>;
export type ApiMemberContext = {
  db: D1;
  execute: ReturnType<typeof createQueryExecutor>;
  scope: { actor_id: string; space_id: string; snapshot_seq: number; purpose: "member_view" };
  role: string;
};

export async function apiMemberContext(request: Request): Promise<ApiMemberContext> {
  const db = env.DB;
  if (!db) throw new HttpError(503, "共同空间暂时无法读取，请稍后重试。");
  let identity: Awaited<ReturnType<typeof authenticateMemberToken>>;
  try {
    identity = await authenticateMemberToken({ db, request });
  } catch (error) {
    if (error instanceof MemberTokenError) throw new HttpError(error.status, error.message, { code: error.code });
    throw error;
  }
  const snapshot = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS snapshot_seq FROM messages WHERE space_id = ?")
    .bind(identity.space_id)
    .first<{ snapshot_seq: number }>();
  if (!snapshot) throw new HttpError(503, "暂时无法建立一致的读取快照，请稍后重试。");
  return {
    db,
    execute: createQueryExecutor(db),
    scope: { actor_id: identity.actor_id, space_id: identity.space_id, snapshot_seq: snapshot.snapshot_seq, purpose: "member_view" },
    role: identity.role,
  };
}
