import { memberContext, routeError, HttpError } from "../../../../src/server/member-context";
import { createArchiveStream, measureReadableBytes, putKnownLengthStream } from "../../../../src/server/archive.mjs";

type Thread = { thread_id: string; title: string; status: string; summary: string; message_seq: number };
type Message = { message_id: string; thread_id: string | null; kind: string; actor_id: string; body: unknown; created_at: string; seq: number };

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    const context = await memberContext();
    const bucket = (await import("cloudflare:workers")).env.BUCKET;
    if (!bucket) throw new HttpError(503, "档案下载暂时不可用，请稍后重试。");
    const { threadId } = await params;
    const format = new URL(request.url).searchParams.get("format") ?? "md";
    if (format !== "md" && format !== "jsonl") throw new HttpError(400, "请选择 Markdown 或 JSONL 格式。");
    const thread = await context.execute("get_thread", { thread_id: threadId }, context.scope) as Thread;
    const membersResult = await context.db.prepare("SELECT user_id, role FROM members WHERE space_id = ?").bind(context.scope.space_id).all();
    const rolesByActor = Object.fromEntries((membersResult.results ?? []).map((record) => {
      const member = record as { user_id: string; role: string };
      return [member.user_id, member.role];
    }));
    const key = `private-archives/${encodeURIComponent(context.scope.space_id)}/${encodeURIComponent(context.user.userId)}/${encodeURIComponent(thread.thread_id)}/${context.scope.snapshot_seq}.${format}`;
    const archiveOptions = {
      format,
      thread,
      snapshot: context.scope.snapshot_seq,
      rolesByActor,
      readPage: (cursor: string | null) => context.execute("get_messages", { thread_id: thread.thread_id, after_message_id: cursor, limit: 100 }, context.scope) as Promise<{ items: Message[]; has_more: boolean; next_after_id: string | null }>,
    };
    const byteLength = await measureReadableBytes(createArchiveStream(archiveOptions));
    const contentType = format === "md" ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8";
    const receipt = await putKnownLengthStream({
      stream: createArchiveStream(archiveOptions),
      byteLength,
      createFixedLengthStream: (length: number) => new FixedLengthStream(length),
      put: (readable: ReadableStream<Uint8Array>) => bucket.put(key, readable, { httpMetadata: { contentType } }),
    });
    const saved = await bucket.get(key);
    if (!saved?.body || !receipt?.etag || receipt.size !== byteLength || saved.etag !== receipt.etag || saved.size !== receipt.size || saved.size !== byteLength) {
      throw new HttpError(503, "档案已生成，但存储校验未通过；请重试下载。");
    }
    const safeThreadName = thread.thread_id.replace(/[^a-zA-Z0-9-]/g, "");
    return new Response(saved.body, { headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="consultation-${safeThreadName}.${format === "md" ? "md" : "jsonl"}"`,
      "Cache-Control": "private, no-store",
      "X-Archive-Snapshot": String(context.scope.snapshot_seq),
      "X-Archive-ETag": saved.etag,
      "X-Archive-Size": String(saved.size),
    } });
  } catch (error) { return routeError(error); }
}
