export function archiveBodyText(body) {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return null;
  if (typeof body.text === 'string') return body.text;
  if (typeof body.reply === 'string') return body.reply;
  if (Array.isArray(body.sections)) return body.sections.map((item) => {
    if (!item || typeof item !== 'object') return JSON.stringify(item);
    const section = item;
    return `${typeof section.heading === 'string' ? `### ${section.heading}\n\n` : ''}${typeof section.text === 'string' ? section.text : JSON.stringify(section)}`;
  }).join('\n\n');
  return null;
}

export function formatArchiveMessage(message, rolesByActor) {
  const role = rolesByActor[message.actor_id];
  const speaker = message.kind === 'therapist_reply' ? '咨询师' : message.kind === 'understanding_updated' ? '共同理解更新' : role === 'husband' ? '丈夫' : role === 'wife' ? '妻子' : role === 'therapist' ? '咨询师' : role === 'member' ? '共同空间成员' : role ?? '共同空间成员';
  return `## ${speaker} · ${message.created_at}\n\n记录 UUID：${message.message_id}\n\n${archiveBodyText(message.body) ?? `暂不支持的记录正文：${JSON.stringify(message.body)}`}\n\n`;
}

/** @param {{format: 'md'|'jsonl', thread: object, snapshot: number, cutoff_message_id?: string|null, readPage: (cursor: string|null) => Promise<any>, rolesByActor?: Record<string,string>}} options */
export function createArchiveStream({ format, thread, snapshot, cutoff_message_id = null, readPage, rolesByActor = {} }) {
  const encoder = new TextEncoder();
  async function* chunks() {
    if (format === 'jsonl') yield encoder.encode(`${JSON.stringify({ type: 'archive', snapshot_seq: snapshot, cutoff_message_id, thread })}\n`);
    else yield encoder.encode(`# ${thread.title}\n\n状态：${thread.status}\nThread：${thread.thread_id}\n读取快照序号：${snapshot}\n最后包含记录 UUID：${cutoff_message_id ?? '无'}\n摘要：${thread.summary}\n\n`);
    let cursor = null;
    for (;;) {
      const page = await readPage(cursor);
      for (const message of page.items) yield encoder.encode(format === 'jsonl' ? `${JSON.stringify({ type: 'message', ...message })}\n` : formatArchiveMessage(message, rolesByActor));
      if (!page.has_more || !page.next_after_id) break;
      cursor = page.next_after_id;
    }
  }
  const iterator = chunks();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); },
  });
}

export async function measureReadableBytes(stream) {
  const reader = stream.getReader();
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return byteLength;
      byteLength += value.byteLength;
      if (!Number.isSafeInteger(byteLength)) throw new RangeError('Archive byte length exceeds the FixedLengthStream limit');
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function putKnownLengthStream({ stream, byteLength, createFixedLengthStream, put }) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError('Archive byte length must be a non-negative safe integer');
  const fixed = createFixedLengthStream(byteLength);
  const abort = new AbortController();
  const putPromise = Promise.resolve().then(() => put(fixed.readable));
  const pipePromise = stream.pipeTo(fixed.writable, { signal: abort.signal });
  try {
    const [, receipt] = await Promise.all([pipePromise, putPromise]);
    if (!receipt) throw new Error('Archive storage did not return a write receipt');
    return receipt;
  } catch (error) {
    abort.abort(error);
    await Promise.allSettled([pipePromise, putPromise]);
    throw error;
  }
}
