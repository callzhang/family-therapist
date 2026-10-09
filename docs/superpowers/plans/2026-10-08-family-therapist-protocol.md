# Family Therapist Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可运行、可回归验证的 UUID 历史分页与夫妻共同讨论状态规则，供后续生产 API 调用。

**Architecture:** 两个无平台依赖的纯模块，输入是已通过身份与范围校验的数据，返回分页结果或新的讨论状态。没有内存服务器、模型模拟服务或生产存储替身；真实数据库事务与认证在阶段 B 实现并单独验证。

**Tech Stack:** JavaScript ES modules，Node 24（当前本机已确认 v24.10.0），node:test、node:assert/strict；不安装外部依赖。

---

## 执行位置与文件图

仓库：`/Users/derek/Projects/family-therapist`。规划 worktree：`/Users/derek/Projects/family-therapist-planning`。执行者先检查当前分支与工作区；使用包含最新批准文档的独立开发 worktree，不覆盖其他任务。

代码路径均相对于执行 worktree：

| 文件 | 职责 |
| --- | --- |
| packages/protocol/history.mjs | 已排序、已授权的消息集合分页与快照边界 |
| packages/protocol/discussion.mjs | thread/共识/双人确认纯状态转换 |
| tests/protocol/history.test.mjs | 游标边界和完整历史场景 |
| tests/protocol/discussion.test.mjs | 版本、状态、非同意场景 |
| docs/operations/protocol.md | 明确生产适配器必须承担的身份、UUID 和事务职责 |

这些模块不进行自然语言关键词检查。pending/active/settled、proposal kind 是产品已确认的有限状态协议，不是用硬编码词语判断咨询语义。

## Task 1：UUID 分页与固定历史快照

**Create:** `packages/protocol/history.mjs`

**Test:** `tests/protocol/history.test.mjs`

- [x] **Step 1：写入以下完整测试。** UUID 以标识使用，服务器 seq 决定顺序；例子故意使用与顺序相反的 UUID 和时间。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHistory } from '../../packages/protocol/history.mjs';

const ids = [
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];
const records = ids.map((message_id, i) => ({
  message_id, seq: i + 1, body: `message ${i + 1}`,
  created_at: `2026-10-0${3 - i}T00:00:00Z`,
}));

test('first page records a stable upper UUID and excludes it only after consumed', () => {
  const first = pageHistory(records, { limit: 1 });
  assert.deepEqual(first.messages.map(x => x.message_id), [ids[0]]);
  assert.equal(first.through_message_id, ids[2]);
  assert.equal(first.next_after_message_id, ids[0]);
  assert.equal(first.has_more, true);
  const appended = [...records, { message_id: '00000000-0000-4000-8000-000000000004', seq: 4 }];
  const rest = pageHistory(appended, {
    after_message_id: first.next_after_message_id,
    through_message_id: first.through_message_id, limit: 10,
  });
  assert.deepEqual(rest.messages.map(x => x.message_id), ids.slice(1));
  assert.equal(rest.has_more, false);
  const live = pageHistory(appended, { after_message_id: rest.next_after_message_id });
  assert.equal(live.messages.length, 1);
  assert.equal(live.messages[0].seq, 4);
});

test('empty increment keeps the cursor, empty history has null cursor', () => {
  const end = pageHistory(records, { after_message_id: ids[2] });
  assert.deepEqual(end.messages, []);
  assert.equal(end.next_after_message_id, ids[2]);
  assert.equal(end.has_more, false);
  assert.equal(pageHistory([]).next_after_message_id, null);
});

test('unknown or reversed boundaries fail explicitly', () => {
  assert.throws(() => pageHistory(records, { after_message_id: 'outside' }), /invalid_cursor/);
  assert.throws(() => pageHistory(records, { through_message_id: 'outside' }), /invalid_snapshot/);
  assert.throws(() => pageHistory(records, {
    after_message_id: ids[2], through_message_id: ids[0],
  }), /reversed_snapshot/);
  assert.throws(() => pageHistory(records, { limit: 0 }), /invalid_limit/);
});

test('a cursor from another authorized scope is not silently accepted', () => {
  assert.throws(() => pageHistory(records.slice(1), { after_message_id: ids[0] }), /invalid_cursor/);
});

test('repository order and uniqueness must be valid', () => {
  assert.throws(() => pageHistory([records[1], records[0]]), /invalid_order/);
  assert.throws(() => pageHistory([records[0], { ...records[0], seq: 2 }]), /duplicate_uuid/);
});

test('returned records cannot mutate retained history', () => {
  const page = pageHistory(records);
  page.messages[0].body = 'changed';
  assert.equal(records[0].body, 'message 1');
});
```

- [x] **Step 2：执行失败测试。**

Run: `node --test tests/protocol/history.test.mjs`

Expected: FAIL，导入的 history.mjs 不存在；如果是其他错误先修复测试设置。

- [x] **Step 3：写入以下完整实现。** 这里用完整数组表达契约；生产查询必须在数据库按授权范围和 seq 分页，不能将所有历史加载进 Worker 内存。

```js
export function pageHistory(records, {
  after_message_id = null, through_message_id = null, limit = 100,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit');
  const seen = new Set();
  let previous = 0;
  for (const item of records) {
    if (!Number.isSafeInteger(item.seq) || item.seq <= previous) throw new Error('invalid_order');
    if (seen.has(item.message_id)) throw new Error('duplicate_uuid');
    previous = item.seq;
    seen.add(item.message_id);
  }
  const after = after_message_id === null ? -1 : records.findIndex(x => x.message_id === after_message_id);
  if (after_message_id !== null && after < 0) throw new Error('invalid_cursor');
  const end = through_message_id === null ? records.length - 1 : records.findIndex(x => x.message_id === through_message_id);
  if (through_message_id !== null && end < 0) throw new Error('invalid_snapshot');
  if (after > end) throw new Error('reversed_snapshot');
  const messages = structuredClone(records.slice(after + 1, Math.min(end + 1, after + 1 + limit)));
  return {
    messages,
    next_after_message_id: messages.at(-1)?.message_id ?? after_message_id,
    through_message_id: records[end]?.message_id ?? null,
    has_more: after + messages.length < end,
  };
}
```

- [x] **Step 4：再次执行并确认全部通过。**

Run: `node --test tests/protocol/history.test.mjs`

Expected: 6 tests，0 failures。检查 first page → fixed snapshot → live increment 的链路，不仅检查单页条数。

- [x] **Step 5：提交这两个文件。**

```sh
git add packages/protocol/history.mjs tests/protocol/history.test.mjs
git commit -m "feat(protocol): define UUID cursor and history snapshot semantics"
```

## Task 2：共同确认与 thread 状态

**Create:** `packages/protocol/discussion.mjs`

**Test:** `tests/protocol/discussion.test.mjs`

协议输入 actor 必须由未来的认证适配器提供。proposal id 对应不可变文字和动作；修改内容要新建 proposal，已过期的提案不能继续执行。全局 revision 只用于本阶段纯模型；生产适配器按相关资源的版本作乐观锁，不能因为收到无关升级通知就让确认过期。

- [x] **Step 1：写入以下完整测试。**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDiscussion, applyDiscussion } from '../../packages/protocol/discussion.mjs';

const step = (s, actor, action) => applyDiscussion(s, actor, action);
function opened() {
  return step(initialDiscussion(['husband', 'wife']), 'husband', { type: 'create', id: 't1', title: '周末安排' });
}
function proposal(s, id, kind, extra = {}) {
  return step(s, 'husband', { type: 'propose', id, kind, thread_id: 't1', text: '我们认可这个具体版本', ...extra });
}
function both(s, id) {
  return step(step(s, 'husband', { type: 'approve', id }), 'wife', { type: 'approve', id });
}

test('first thread active, next pending; no pause state', () => {
  const s = step(opened(), 'wife', { type: 'create', id: 't2', title: '另一件事' });
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.threads.t2.status, 'pending');
  assert.throws(() => step(s, 'wife', { type: 'pause' }), /invalid_action/);
});

test('one person repeating agreement cannot settle; both approve exact proposal', () => {
  let s = proposal(opened(), 'p1', 'settle');
  s = step(s, 'husband', { type: 'approve', id: 'p1' });
  s = step(s, 'husband', { type: 'approve', id: 'p1' });
  assert.equal(s.threads.t1.status, 'active');
  s = step(s, 'wife', { type: 'approve', id: 'p1' });
  assert.equal(s.threads.t1.status, 'settled');
  assert.equal(s.agreements[0].text, '我们认可这个具体版本');
  assert.deepEqual(step(s, 'wife', { type: 'approve', id: 'p1' }), s);
});

test('confirming one shared understanding does not settle the thread', () => {
  const s = both(proposal(opened(), 'p1', 'consensus'), 'p1');
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.agreements.length, 1);
});

test('different versions cannot borrow approval, proposal text is immutable', () => {
  let s = proposal(opened(), 'old', 'consensus');
  s = step(s, 'husband', { type: 'approve', id: 'old' });
  s = proposal(s, 'new', 'consensus', { text: '修改后的另一版本' });
  s = step(s, 'wife', { type: 'approve', id: 'new' });
  assert.equal(s.agreements.length, 0);
  assert.throws(() => proposal(s, 'old', 'consensus', { text: '覆盖旧文' }), /duplicate_proposal/);
});

test('switch is bilateral and preserves old thread', () => {
  let s = step(opened(), 'wife', { type: 'create', id: 't2', title: '另一件事' });
  s = proposal(s, 'switch', 'switch', { target_id: 't2' });
  const one = step(s, 'husband', { type: 'approve', id: 'switch' });
  assert.equal(one.threads.t1.status, 'active');
  s = step(one, 'wife', { type: 'approve', id: 'switch' });
  assert.equal(s.threads.t1.status, 'pending');
  assert.equal(s.threads.t2.status, 'active');
  assert.equal(s.threads.t1.title, '周末安排');
});

test('reopen requires both, returns pending and keeps original conclusion', () => {
  let s = both(proposal(opened(), 'done', 'settle'), 'done');
  s = proposal(s, 'reopen', 'reopen', { text: '希望重新讨论的原因' });
  s = step(s, 'husband', { type: 'approve', id: 'reopen' });
  assert.equal(s.threads.t1.status, 'settled');
  s = step(s, 'wife', { type: 'approve', id: 'reopen' });
  assert.equal(s.threads.t1.status, 'pending');
  assert.equal(s.agreements.length, 1);
  s = proposal(s, 'resume', 'switch', { target_id: 't1' });
  s = both(s, 'resume');
  assert.equal(s.threads.t1.status, 'active');
});

test('stale proposal cannot act on newly changed discussion', () => {
  let s = proposal(opened(), 'old', 'settle');
  s = both(proposal(s, 'understanding', 'consensus'), 'understanding');
  assert.throws(() => step(s, 'wife', { type: 'approve', id: 'old' }), /stale_proposal/);
});

test('outsider, empty text and reopening a live thread are refused', () => {
  assert.throws(() => step(opened(), 'other', { type: 'approve', id: 'p1' }), /forbidden/);
  assert.throws(() => proposal(opened(), 'p1', 'consensus', { text: ' ' }), /empty_text/);
  assert.throws(() => proposal(opened(), 'p1', 'reopen'), /not_settled/);
});

test('input state is not mutated, and successful actions preserve single active', () => {
  const original = opened();
  const copy = structuredClone(original);
  const next = both(proposal(original, 'c', 'consensus'), 'c');
  assert.deepEqual(original, copy);
  assert.ok(Object.values(next.threads).filter(t => t.status === 'active').length <= 1);
});
```

- [x] **Step 2：执行失败测试。**

Run: `node --test tests/protocol/discussion.test.mjs`

Expected: FAIL，尚无 discussion.mjs。

- [x] **Step 3：写入完整状态规则实现。** 不从自然语言猜测 action；动作必须是用户在本地明确确认后生成的结构化请求。

```js
export function initialDiscussion(members) {
  if (members.length !== 2 || new Set(members).size !== 2) throw new Error('two_members_required');
  return { members: [...members], threads: {}, proposals: {}, agreements: [], revision: 0 };
}

function requireText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('empty_text');
}

function validateProposal(state, p) {
  const thread = state.threads[p.thread_id];
  if (!thread) throw new Error('unknown_thread');
  requireText(p.text);
  switch (p.kind) {
    case 'consensus':
    case 'settle':
      if (thread.status !== 'active') throw new Error('not_active');
      break;
    case 'reopen':
      if (thread.status !== 'settled') throw new Error('not_settled');
      break;
    case 'switch': {
      const target = state.threads[p.target_id];
      if (!target || target.status !== 'pending') throw new Error('target_not_pending');
      const active = Object.values(state.threads).find(t => t.status === 'active');
      if (active && active.id !== p.thread_id) throw new Error('wrong_active_thread');
      if (!active && p.thread_id !== p.target_id) throw new Error('wrong_target_thread');
      break;
    }
    default: throw new Error('invalid_proposal');
  }
}

export function applyDiscussion(state, actor, action) {
  if (!state.members.includes(actor)) throw new Error('forbidden');
  const next = structuredClone(state);
  switch (action.type) {
    case 'create': {
      if (Object.hasOwn(next.threads, action.id)) throw new Error('duplicate_thread');
      requireText(action.title);
      const active = Object.values(next.threads).some(t => t.status === 'active');
      Object.defineProperty(next.threads, action.id, {
        value: { id: action.id, title: action.title, status: active ? 'pending' : 'active' },
        enumerable: true, configurable: true, writable: true,
      });
      next.revision += 1;
      break;
    }
    case 'propose': {
      if (Object.hasOwn(next.proposals, action.id)) throw new Error('duplicate_proposal');
      const p = {
        id: action.id, kind: action.kind, thread_id: action.thread_id,
        target_id: action.target_id ?? null, text: action.text,
        revision: next.revision, approvals: [], applied: false,
      };
      validateProposal(next, p);
      Object.defineProperty(next.proposals, p.id, {
        value: p, enumerable: true, configurable: true, writable: true,
      });
      break;
    }
    case 'approve': {
      if (!Object.hasOwn(next.proposals, action.id)) throw new Error('unknown_proposal');
      const p = next.proposals[action.id];
      if (p.applied) return next;
      if (p.revision !== next.revision) throw new Error('stale_proposal');
      validateProposal(next, p);
      if (!p.approvals.includes(actor)) p.approvals.push(actor);
      if (!next.members.every(m => p.approvals.includes(m))) return next;
      switch (p.kind) {
        case 'consensus':
        case 'settle':
          next.agreements.push({ proposal_id: p.id, thread_id: p.thread_id, text: p.text });
          if (p.kind === 'settle') next.threads[p.thread_id].status = 'settled';
          break;
        case 'reopen':
          next.threads[p.thread_id].status = 'pending';
          break;
        case 'switch':
          for (const thread of Object.values(next.threads)) {
            if (thread.status === 'active') thread.status = 'pending';
          }
          next.threads[p.target_id].status = 'active';
          break;
      }
      p.applied = true;
      next.revision += 1;
      break;
    }
    default: throw new Error('invalid_action');
  }
  return next;
}
```

- [x] **Step 4：执行测试并核对 9 个真实场景。**

Run: `node --test tests/protocol/discussion.test.mjs`

Expected: 9 tests，0 failures。两条审批属于不同 proposal 时没有生效共识；必须看到这个反例通过。

- [x] **Step 5：提交两个文件。**

```sh
git add packages/protocol/discussion.mjs tests/protocol/discussion.test.mjs
git commit -m "feat(protocol): model bilateral thread and agreement transitions"
```

## Task 3：记录适配边界与本阶段交付证据

**Create:** `docs/operations/protocol.md`

- [x] **Step 1：写入以下完整文档内容。**

```markdown
# Protocol module boundary

The history module defines cursor behavior for an already authorized, ordered scope.
It does not authenticate requests or validate UUID syntax. Production adapters validate
UUIDs using the selected schema library, filter by membership and scope before cursor
resolution, and query durable storage with a server sequence and fixed snapshot bound.
Space and thread cursors are independent. No production endpoint should load all history
into memory to invoke the array reference implementation.

The discussion module is a deterministic contract for two authenticated members.
Proposal text and action are immutable under a proposal id. A new text version has a new
proposal id and no inherited approvals. Proposing is not approving. Consensus is not
thread closure. Reopening returns a settled thread to pending and retains its history.

Production transactions must enforce a unique message UUID, immutable payload receipt,
single active thread, version-checked approvals, and atomic append of events and jobs.
The pure model revision must be mapped to relevant discussion resources; unrelated
skill-release messages do not invalidate a proposal. Actor identity comes from verified
credentials, never a client body field. Model output cannot invoke approval as a member.

The tests do not prove durable recovery, identity security, task execution, consultation
quality, deployment, local scheduling, or skill upgrades. Those require their own phase
acceptance evidence. Local-only synthetic fixtures are not clinical or production data.
```

- [x] **Step 2：运行本阶段完整测试和差异检查。**

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs
git diff --check
```

Expected: 15 tests，0 failures；无空白差异错误。没有实现任何 API，不生成“API 已就绪”声明。

- [x] **Step 3：提交文档并汇报结果。**

```sh
git add docs/operations/protocol.md
git commit -m "docs: define production obligations for protocol adapters"
git status --short
git log -3 --oneline
```

Expected: 清洁工作区及上述三个功能提交。汇报实际测试输出；本文预计输出不能代替执行证据。

## 自检与后续

本计划完整覆盖阶段 A：历史分页/快照、单 active、双人同版本确认、settled 重开、确认与结案区分、纯输入不变性。正文代码是实施指令，当前未写入产品源码。

规划自检：已将本文四个 JavaScript 代码块提取到一次性临时目录，以本机 Node v24.10.0 执行上述两个测试文件，15 项全部通过，临时目录已自动清理。这验证计划代码与测试的内在一致性，不证明生产 API、数据库事务或整个产品完成。实际实施仍须按任务执行并保留各步验证证据。

下一阶段依赖为总览 B0 的真实平台与模型接入验证；然后编写云端执行、网页、客户端各自的完整代码计划。不能仅凭 15 个协议测试通过宣称整个产品完成。
