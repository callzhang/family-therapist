import { memberContext, routeError } from "../../../src/server/member-context";
import { parseUnderstandingRecord } from "../../../src/server/queries.mjs";

const PAGE = 100;
const DISPLAY = 50;

export async function GET(request: Request) {
  try {
    const context = await memberContext();
    const url = new URL(request.url);
    const threads: unknown[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await context.execute("list_threads", { limit: PAGE, after_thread_id: after, status: null }, context.scope) as { items: unknown[]; has_more: boolean; next_after_id: string | null };
      threads.push(...page.items);
      if (!page.has_more || !page.next_after_id) break;
      after = page.next_after_id;
    }
    const agreements: unknown[] = [];
    let agreementAfter: string | undefined;
    for (;;) {
      const page = await context.execute("get_agreements", { limit: PAGE, after_agreement_id: agreementAfter, thread_id: null }, context.scope) as { items: unknown[]; has_more: boolean; next_after_id: string | null };
      agreements.push(...page.items);
      if (!page.has_more || !page.next_after_id) break;
      agreementAfter = page.next_after_id;
    }
    const selectedId = url.searchParams.get("thread") || (threads as {thread_id:string;status:string}[]).find((t) => t.status === "active")?.thread_id || (threads as {thread_id:string}[]).at(-1)?.thread_id || null;
    let selected = null;
    let messages: unknown[] = [];
    let hasEarlier = false;
    let understanding: unknown = null;
    let therapistTask: unknown = null;
    if (selectedId) {
      selected = await context.execute("get_thread", { thread_id: selectedId }, context.scope);
      const thread = selected as { thread_id: string };
      therapistTask = await context.db.prepare(`SELECT t.message_id, t.status, t.last_error_code, t.created_at
        FROM therapist_tasks t INNER JOIN messages m ON m.message_id = t.message_id
        WHERE t.space_id = ? AND t.thread_id = ? AND m.seq <= ?
        ORDER BY m.seq DESC LIMIT 1`)
        .bind(context.scope.space_id, thread.thread_id, context.scope.snapshot_seq)
        .first<{ message_id: string; status: string; last_error_code: string | null; created_at: string }>();
      const tail = await context.db.prepare("SELECT message_id FROM messages WHERE space_id = ? AND thread_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1 OFFSET ?").bind(context.scope.space_id, thread.thread_id, context.scope.snapshot_seq, DISPLAY).first<{message_id:string}>();
      hasEarlier = Boolean(tail);
      const cursor = tail?.message_id;
      const page = await context.execute("get_messages", { thread_id: thread.thread_id, after_message_id: cursor ?? null, limit: DISPLAY }, context.scope) as { items: unknown[] };
      messages = page.items;
      const latest = await context.db.prepare("SELECT message_id, body_json, created_at FROM messages WHERE space_id = ? AND thread_id = ? AND kind = 'understanding_updated' AND seq <= ? ORDER BY seq DESC LIMIT 1").bind(context.scope.space_id, thread.thread_id, context.scope.snapshot_seq).first<{message_id:string;body_json:string;created_at:string}>();
      if (latest) {
        const record = parseUnderstandingRecord(latest.body_json, latest.message_id) as Record<string, unknown>;
        understanding = { ...record, message_id: latest.message_id, created_at: latest.created_at };
      }
    }
    const membersResult = await context.db.prepare("SELECT user_id, role FROM members WHERE space_id = ? ORDER BY role").bind(context.scope.space_id).all();
    const members = (membersResult.results ?? []).map((r) => ({ user_id: (r as {user_id:string}).user_id, role: (r as {role:string}).role }));
    return Response.json({ snapshot_seq: context.scope.snapshot_seq, refreshed_at: new Date().toISOString(), viewer_id: context.user.userId, role: context.role, members, threads, selected, messages, has_earlier: hasEarlier, understanding, therapist_task: therapistTask, agreements }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return routeError(error); }
}
