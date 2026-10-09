import { getSpaceUpdates } from "./updates.mjs";
import { saveAgreementArchive } from "./agreement-archive.mjs";
import { measureReadableBytes, putKnownLengthStream } from "./archive.mjs";

type Scope = { actor_id: string; space_id: string; snapshot_seq: number; purpose: "member_view" };
type Context = { db: any; scope: Scope; user?: { userId: string }; role?: string };

export async function agreementArchiveResponse(context: Context, request: Request, bucket: R2Bucket): Promise<Response> {
  const format = new URL(request.url).searchParams.get("format") ?? "md";
  if (format !== "md" && format !== "jsonl") return Response.json({ error: "请选择 Markdown 或 JSONL 格式。" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  const last = await context.db.prepare("SELECT message_id FROM messages WHERE space_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1")
    .bind(context.scope.space_id, context.scope.snapshot_seq).first() as { message_id: string } | null;
  const roles = await context.db.prepare("SELECT user_id, role FROM members WHERE space_id = ?").bind(context.scope.space_id).all();
  const rolesByActor = Object.fromEntries((roles.results ?? []).map((row: { user_id: string; role: string }) => [row.user_id, row.role]));
  const streamOptions = {
    format, scope: context.scope, snapshot: context.scope.snapshot_seq, cutoff_message_id: last?.message_id ?? null, rolesByActor,
    async readAgreementsPage(cursor: string | null, limit: number, snapshot: number, category: "principle" | "topic") {
      const isGlobal = category === "principle";
      const found = await context.db.prepare(`SELECT av.agreement_id, av.thread_id, av.message_seq, av.version, av.text,
          confirmation.message_id AS confirmation_message_id, confirmation.actor_id AS confirmed_by, confirmation.created_at AS confirmed_at
        FROM agreement_versions av INNER JOIN messages confirmation ON confirmation.space_id = av.space_id AND confirmation.seq = av.message_seq
        WHERE av.space_id = ? AND av.message_seq <= ? AND av.confirmed = 1 AND ((? = 1 AND av.thread_id IS NULL) OR (? = 0 AND av.thread_id IS NOT NULL))
          AND av.message_seq = (SELECT MAX(v.message_seq) FROM agreement_versions v WHERE v.space_id = av.space_id AND v.agreement_id = av.agreement_id AND v.message_seq <= ?)
          AND (? IS NULL OR av.agreement_id > ?)
        ORDER BY av.agreement_id ASC LIMIT ?`).bind(context.scope.space_id, snapshot, Number(isGlobal), Number(isGlobal), snapshot, cursor, cursor, limit + 1).all();
      if (!Array.isArray(found.results)) throw new Error("共同共识档案查询返回无效结果。");
      const items = found.results.slice(0, limit);
      return { items, has_more: found.results.length > limit, next_after_id: items.at(-1)?.agreement_id ?? cursor, snapshot_seq: snapshot };
    },
    async readUpdatesPage(cursor: string | null, limit: number, snapshot: number) {
      return getSpaceUpdates({ db: context.db, scope: context.scope, after_message_id: cursor, limit, snapshot_seq: snapshot });
    },
  };
  const key = `private-agreement-archives/${encodeURIComponent(context.scope.space_id)}/${encodeURIComponent(context.scope.actor_id)}/${context.scope.snapshot_seq}.${format}`;
  try {
    const { saved, byteLength } = await saveAgreementArchive({
      streamOptions, key, bucket, createFixedLengthStream: (length: number) => new FixedLengthStream(length),
      measureReadableBytes, putKnownLengthStream,
    });
    return new Response(saved.body, { headers: {
      "Content-Type": format === "md" ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="shared-agreements.${format === "md" ? "md" : "jsonl"}"`,
      "Cache-Control": "private, no-store", "X-Archive-Snapshot": String(context.scope.snapshot_seq),
      "X-Archive-Cutoff-Message": last?.message_id ?? "", "X-Archive-ETag": saved.etag, "X-Archive-Size": String(byteLength),
    } });
  } catch (error) {
    console.error("Agreement archive could not be persisted and verified", error);
    return Response.json({ error: "共同原则档案暂时无法保存或校验，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
