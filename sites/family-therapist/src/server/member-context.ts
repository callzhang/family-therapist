import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../app/chatgpt-auth";
import { createQueryExecutor } from "./queries.mjs";

type D1 = NonNullable<Cloudflare.Env["DB"]>;
export type MemberContext = {
  user: NonNullable<Awaited<ReturnType<typeof getChatGPTUser>>>;
  db: D1;
  execute: ReturnType<typeof createQueryExecutor>;
  scope: { actor_id: string; space_id: string; snapshot_seq: number; purpose: "member_view" };
  role: string;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function memberContext(): Promise<MemberContext> {
  const user = await getChatGPTUser();
  if (!user) throw new HttpError(401, "Sign in with ChatGPT to view this space.");
  const db = env.DB;
  if (!db) throw new HttpError(503, "The shared space is temporarily unavailable.");
  const membership = await db.prepare("SELECT space_id, role FROM members WHERE user_id = ? LIMIT 2").bind(user.userId).all();
  const matches = membership.results ?? [];
  if (matches.length === 0) throw new HttpError(403, "You are not a member of a shared space.");
  if (matches.length !== 1) throw new HttpError(403, "Your account is connected to more than one space.");
  const row = matches[0] as { space_id: string; role: string };
  const snapshot = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS snapshot_seq FROM messages WHERE space_id = ?").bind(row.space_id).first<{ snapshot_seq: number }>();
  if (!snapshot) throw new HttpError(503, "A reading snapshot could not be created.");
  return {
    user,
    db,
    execute: createQueryExecutor(db),
    scope: { actor_id: user.userId, space_id: row.space_id, snapshot_seq: snapshot.snapshot_seq, purpose: "member_view" },
    role: row.role,
  };
}

export function routeError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Unable to read this information.";
  if (/membership is required/i.test(message)) return Response.json({ error: "You are not a member of this space." }, { status: 403 });
  if (/unknown or out-of-scope/i.test(message)) return Response.json({ error: "That conversation is not available in this space." }, { status: 404 });
  console.error("Read-only member view failed", error);
  return Response.json({ error: "Unable to read this information right now." }, { status: 503 });
}
