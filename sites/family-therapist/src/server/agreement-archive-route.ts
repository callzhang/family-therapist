import { getSpaceUpdates } from "./updates.mjs";
import { filterAgreementPage, saveAgreementArchive } from "./agreement-archive.mjs";
import { measureReadableBytes, putKnownLengthStream } from "./archive.mjs";
import type { MemberContext } from "./member-context";
import type { ApiMemberContext } from "./api-member-context";

type Context = Pick<MemberContext | ApiMemberContext, "db" | "execute" | "scope">;

export async function agreementArchiveResponse(context: Context, request: Request, bucket: R2Bucket): Promise<Response> {
  const format = new URL(request.url).searchParams.get("format") ?? "md";
  if (format !== "md" && format !== "jsonl") return Response.json({ error: "请选择 Markdown 或 JSONL 格式。" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  const last = await context.db.prepare("SELECT message_id FROM messages WHERE space_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1")
    .bind(context.scope.space_id, context.scope.snapshot_seq).first() as { message_id: string } | null;
  const roles = await context.db.prepare("SELECT user_id, role FROM members WHERE space_id = ?").bind(context.scope.space_id).all();
  const rolesByActor = Object.fromEntries((roles.results ?? []).map((record) => {
    const row = record as { user_id: string; role: string };
    return [row.user_id, row.role];
  }));
  const streamOptions = {
    format, scope: context.scope, snapshot: context.scope.snapshot_seq, cutoff_message_id: last?.message_id ?? null, rolesByActor,
    async readAgreementsPage(cursor: string | null, limit: number, snapshot: number, category: "principle" | "topic") {
      const page = await context.execute("get_agreements", { thread_id: null, after_agreement_id: cursor, limit }, { ...context.scope, snapshot_seq: snapshot }) as {
        items: { agreement_id: string; thread_id: string | null; version: number; text: string; message_seq: number; confirmation_message_id: string; confirmation_actor_id: string; confirmed_at: string }[];
        has_more: boolean; next_after_id: string | null; snapshot_seq: number;
      };
      return filterAgreementPage(page, category);
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
