import { memberContext, routeError, HttpError } from "../../../../src/server/member-context";

type Thread = { thread_id: string; title: string; status: string; summary: string; message_seq: number };
type Message = { message_id: string; thread_id: string | null; kind: string; actor_id: string; body: unknown; created_at: string; seq: number };

function textOf(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.reply === "string") return obj.reply;
  if (Array.isArray(obj.sections)) return obj.sections.map((s) => {
    if (!s || typeof s !== "object") return JSON.stringify(s);
    const section = s as Record<string, unknown>;
    return `${typeof section.heading === "string" ? `### ${section.heading}\n\n` : ""}${typeof section.text === "string" ? section.text : JSON.stringify(section)}`;
  }).join("\n\n");
  return null;
}

function markdown(message: Message): string {
  const content = textOf(message.body);
  const role = message.kind === "user_message" ? "Member" : message.kind === "assistant_message" ? "Therapist" : message.kind;
  return `## ${role} · ${message.created_at}\n\n${content ?? `Record details: ${JSON.stringify(message.body)}`}\n\n`;
}

function artifactStream(format: string, thread: Thread, snapshot: number, execute: Awaited<ReturnType<typeof memberContext>>["execute"], scope: Awaited<ReturnType<typeof memberContext>>["scope"]) {
  const encoder = new TextEncoder();
  async function* chunks() {
    if (format === "jsonl") yield encoder.encode(`${JSON.stringify({ type: "archive", snapshot_seq: snapshot, thread })}\n`);
    else yield encoder.encode(`# ${thread.title}\n\nStatus: ${thread.status}\nThread: ${thread.thread_id}\nSnapshot sequence: ${snapshot}\nSummary: ${thread.summary}\n\n`);
    let cursor: string | null = null;
    for (;;) {
      const page = await execute("get_messages", { thread_id: thread.thread_id, after_message_id: cursor, limit: 100 }, scope) as { items: Message[]; has_more: boolean; next_after_id: string | null };
      for (const message of page.items) yield encoder.encode(format === "jsonl" ? `${JSON.stringify({ type: "message", ...message })}\n` : markdown(message));
      if (!page.has_more || !page.next_after_id) break;
      cursor = page.next_after_id;
    }
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    const context = await memberContext();
    const bucket = (await import("cloudflare:workers")).env.BUCKET;
    if (!bucket) throw new HttpError(503, "Archive downloads are temporarily unavailable.");
    const { threadId } = await params;
    const format = new URL(request.url).searchParams.get("format") ?? "md";
    if (format !== "md" && format !== "jsonl") throw new HttpError(400, "Choose Markdown or JSONL format.");
    const thread = await context.execute("get_thread", { thread_id: threadId }, context.scope) as Thread;
    const key = `private-archives/${encodeURIComponent(context.user.userId)}/${encodeURIComponent(thread.thread_id)}/${context.scope.snapshot_seq}.${format}`;
    const body = artifactStream(format, thread, context.scope.snapshot_seq, context.execute, context.scope);
    await bucket.put(key, body, { httpMetadata: { contentType: format === "md" ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8" } });
    const saved = await bucket.get(key);
    if (!saved?.body) throw new HttpError(503, "The archive could not be verified after saving.");
    return new Response(saved.body, { headers: {
      "Content-Type": format === "md" ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="consultation-${thread.thread_id}.${format === "md" ? "md" : "jsonl"}"`,
      "Cache-Control": "private, no-store",
      "X-Archive-Snapshot": String(context.scope.snapshot_seq),
    } });
  } catch (error) { return routeError(error); }
}
