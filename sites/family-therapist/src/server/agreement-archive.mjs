const encoder = new TextEncoder();
const PAGE_SIZE = 100;

function assertPage(page, cursor) {
  if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' || !Number.isSafeInteger(page.snapshot_seq)) throw new Error('Invalid archive page');
  if (page.has_more && (!page.next_after_id || page.next_after_id === cursor)) throw new Error('Archive page cursor did not advance');
}

function speaker(actorId, rolesByActor) {
  const role = rolesByActor[actorId];
  if (role === 'husband') return '丈夫';
  if (role === 'wife') return '妻子';
  if (role === 'therapist') return 'AI 咨询师';
  return role === 'member' ? '共同空间成员' : '空间成员';
}

function agreementKind(item) { return item.thread_id === null ? '共同相处原则' : '议题结论'; }

function agreementMarkdown(item) {
  return `### ${agreementKind(item)}\n\n${item.text}\n\n- Agreement UUID：${item.agreement_id}\n- 确认记录 UUID：${item.confirmation_message_id}\n- 版本：${item.version}\n- 确认序号：${item.message_seq}\n- 确认者：${item.confirmed_by}\n- 确认时间：${item.confirmed_at}\n\n`;
}

function operationMarkdown(item, rolesByActor) {
  const action = item.body?.action;
  const label = action?.type === 'propose' ? `提出：${action.kind ?? '共同议题'}` : action?.type === 'approve' ? '确认共同议题操作' : '共同议题操作';
  const body = JSON.stringify(item.body);
  const longestFence = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  return `### ${label} · ${item.created_at}\n\n- 操作记录 UUID：${item.message_id}\n- 操作者：${speaker(item.actor_id, rolesByActor)}\n- 原始操作者 ID：${item.actor_id}\n\n原始操作正文：\n\n${fence}json\n${body}\n${fence}\n\n`;
}

/** Streams confirmed agreements and source operations separately at one fixed space snapshot. */
export function createAgreementArchiveStream({ format, scope, snapshot, cutoff_message_id, readAgreementsPage, readUpdatesPage, rolesByActor = {} }) {
  if (!['md', 'jsonl'].includes(format)) throw new TypeError('format must be md or jsonl');
  if (!scope?.space_id || !scope?.actor_id || !Number.isSafeInteger(snapshot) || snapshot < 0) throw new TypeError('Authenticated archive scope and snapshot are required');
  async function* chunks() {
    if (format === 'jsonl') yield encoder.encode(`${JSON.stringify({ type: 'header', scope: '共同空间共识与操作记录', space_id: scope.space_id, snapshot_seq: snapshot, cutoff_message_id })}\n`);
    else yield encoder.encode(`# 共同原则与议题结论\n\n共同空间 UUID：${scope.space_id}\n读取快照序号：${snapshot}\n空间最后包含记录 UUID：${cutoff_message_id ?? '无'}\n\n> 本档案只收录已确认的共同原则与议题结论；历史操作另列，不代表待确认提议已成为共识。\n\n## 共同相处原则\n\n`);
    for (const category of ['principle', 'topic']) {
      if (format === 'md' && category === 'topic') yield encoder.encode('\n## 已确认的议题结论\n\n');
      let cursor = null;
      for (;;) {
        const page = await readAgreementsPage(cursor, PAGE_SIZE, snapshot, category);
        assertPage(page, cursor);
        if (page.snapshot_seq !== snapshot) throw new Error('Agreement archive snapshot changed');
        for (const item of page.items) {
          if (item.message_seq > snapshot || !item.confirmation_message_id || typeof item.text !== 'string' || (category === 'principle') !== (item.thread_id === null)) throw new Error('Malformed confirmed agreement record');
          if (format === 'jsonl') yield encoder.encode(`${JSON.stringify({ type: 'agreement', ...item })}\n`);
          else yield encoder.encode(agreementMarkdown(item));
        }
        if (!page.has_more) break;
        cursor = page.next_after_id;
      }
    }
    if (format === 'md') yield encoder.encode('## 历史操作记录（不等同于正式共识）\n\n');
    let cursor = null;
    for (;;) {
      const page = await readUpdatesPage(cursor, PAGE_SIZE, snapshot);
      assertPage(page, cursor);
      if (page.snapshot_seq !== snapshot) throw new Error('Operation archive snapshot changed');
      for (const item of page.items) {
        if (item.seq > snapshot) throw new Error('Operation archive exceeded its snapshot');
        if (item.kind !== 'discussion_command') continue;
        if (format === 'jsonl') yield encoder.encode(`${JSON.stringify({ type: 'operation', ...item })}\n`);
        else yield encoder.encode(operationMarkdown(item, rolesByActor));
      }
      if (!page.has_more) break;
      cursor = page.next_after_id;
    }
  }
  const iterator = chunks();
  return new ReadableStream({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); },
  });
}

export async function saveAgreementArchive({ streamOptions, key, bucket, createFixedLengthStream, measureReadableBytes, putKnownLengthStream }) {
  const makeStream = () => createAgreementArchiveStream(streamOptions);
  const byteLength = await measureReadableBytes(makeStream());
  const receipt = await putKnownLengthStream({
    stream: makeStream(), byteLength, createFixedLengthStream,
    put: (body) => bucket.put(key, body, { httpMetadata: { contentType: streamOptions.format === 'md' ? 'text/markdown; charset=utf-8' : 'application/x-ndjson; charset=utf-8' } }),
  });
  const saved = await bucket.get(key);
  if (!saved?.body || !receipt?.etag || receipt.size !== byteLength || saved.etag !== receipt.etag || saved.size !== receipt.size || saved.size !== byteLength) throw new Error('Agreement archive persistence verification failed');
  return { saved, receipt, byteLength };
}
