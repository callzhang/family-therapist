import { IntakeError, MAX_INTAKE_BODY_BYTES } from './intake.mjs';

const messages = Object.freeze({
  invalid_command: '提交内容格式无效，请检查后重试。',
  invalid_scope: '当前账号范围无法确认。',
  membership_required: '当前账号尚未加入此共同空间。',
  persistence_invalid: '已保存的表达无法正常读取，请联系维护者。',
  persistence_incomplete: '表达记录尚未完整入队，请稍后查询回执。',
  message_conflict: '此消息 UUID 已用于其他内容，请为本次表达使用新的 UUID。',
  thread_not_found: '共同空间中没有找到此议题。',
  thread_not_active: '只能向当前进行中的议题提交表达。',
  stale_thread: '议题版本已变化，请刷新并重新确认表达后再提交。',
  persistence_failed: '表达未能原子保存并入队，请稍后查询 UUID 回执。',
  intake_rejected: '提交期间成员权限或议题状态已变化，请刷新后重试。',
  invalid_message_id: '消息 UUID 格式无效。',
  invalid_content_type: '请以 JSON 格式提交已确认的表达。',
  invalid_body: '表达请求不是有效的 UTF-8 JSON。',
  body_too_large: '确认表达超过了允许的请求大小。',
});

export async function readBoundedJson(request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new IntakeError('invalid_content_type', 415, 'Invalid content type');
  if (!request.body) throw new IntakeError('invalid_body', 400, 'A JSON expression request is required');

  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_INTAKE_BODY_BYTES) {
        await reader.cancel('intake body limit exceeded');
        throw new IntakeError('body_too_large', 413, 'Intake body exceeds the configured limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new IntakeError('invalid_body', 400, 'Invalid UTF-8 JSON request body'); }
}

export function intakeErrorResponse(error) {
  if (!(error instanceof IntakeError)) throw new TypeError('An IntakeError is required');
  return Response.json({ code: error.code, error: messages[error.code] ?? '请求暂时无法处理。' }, {
    status: error.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export function receiptNotFoundResponse() {
  return Response.json({ code: 'receipt_not_found', error: '没有找到当前成员提交的表达回执。' }, {
    status: 404,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
