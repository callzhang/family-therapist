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

export function createArchiveStream({ format, thread, snapshot, readPage, rolesByActor = {} }) {
  const encoder = new TextEncoder();
  async function* chunks() {
    if (format === 'jsonl') yield encoder.encode(`${JSON.stringify({ type: 'archive', snapshot_seq: snapshot, thread })}\n`);
    else yield encoder.encode(`# ${thread.title}\n\n状态：${thread.status}\nThread：${thread.thread_id}\n读取快照序号：${snapshot}\n摘要：${thread.summary}\n\n`);
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
