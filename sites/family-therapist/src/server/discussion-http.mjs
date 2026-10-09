import { DiscussionCommandError } from './discussion-commands.mjs';

const messages = Object.freeze({
  invalid_command: '议题请求格式无效，请检查后重试。', invalid_scope: '当前账号范围无法确认。',
  member_pair_required: '共同空间的两位成员状态无法确认。', membership_required: '当前账号尚未加入此共同空间。',
  membership_changed: '成员权限在保存期间发生变化，请刷新后重试。', projection_uninitialized: '已有议题历史尚未完成迁移，暂时不能修改。',
  projection_corrupt: '已保存的议题状态无法读取，请联系维护者。', projection_limit_exceeded: '共同议题记录已达到存储上限，请联系维护者。',
  unknown_thread: '共同空间中没有找到此议题。', duplicate_thread: '此议题 UUID 已用于其他记录。', duplicate_proposal: '此提议 UUID 已用于其他记录。',
  invalid_action: '当前议题操作不适用。', invalid_proposal: '提议格式无效。', empty_text: '提议内容不能为空。',
  approval_text_mismatch: '确认内容与原提议不完全一致，请重新核对。', unknown_proposal: '共同空间中没有找到此提议。',
  not_active: '只有进行中的议题可以确认或结束。', not_settled: '只有已结束的议题可以重新开启。', target_not_pending: '目标议题当前不能切换。',
  wrong_active_thread: '议题状态已变化，请刷新后重试。', wrong_target_thread: '目标议题状态已变化，请刷新后重试。', stale_proposal: '议题内容已有变化，请重新提出并确认。',
  command_conflict: '此消息 UUID 已用于其他操作，请为本次操作使用新的 UUID。', storage_conflict: '共同议题刚刚发生变化，请刷新后使用相同 UUID 重试。',
  storage_failed: '操作未能原子保存，请稍后查询 UUID 回执。', persistence_incomplete: '操作记录与议题状态尚未完整对应，请稍后查询 UUID 回执。',
});

export function discussionErrorResponse(error) {
  if (!(error instanceof DiscussionCommandError)) throw new TypeError('A DiscussionCommandError is required');
  return Response.json({ code: error.code, error: messages[error.code] ?? '暂时无法处理共同议题操作。' }, {
    status: error.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
