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
function approve(s, actor, id, text = s.proposals[id]?.text) {
  return step(s, actor, { type: 'approve', id, text });
}
function both(s, id) {
  return approve(approve(s, 'husband', id), 'wife', id);
}

test('first thread active, next pending; no pause state', () => {
  const s = step(opened(), 'wife', { type: 'create', id: 't2', title: '另一件事' });
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.threads.t2.status, 'pending');
  assert.throws(() => step(s, 'wife', { type: 'pause' }), /invalid_action/);
});

test('one person repeating agreement cannot settle; both approve exact proposal', () => {
  let s = proposal(opened(), 'p1', 'settle');
  s = approve(s, 'husband', 'p1');
  s = approve(s, 'husband', 'p1');
  assert.equal(s.threads.t1.status, 'active');
  s = approve(s, 'wife', 'p1');
  assert.equal(s.threads.t1.status, 'settled');
  assert.equal(s.threads.t1.summary, '我们认可这个具体版本');
  assert.equal(s.agreements[0].text, '我们认可这个具体版本');
  assert.deepEqual(approve(s, 'wife', 'p1'), s);
});

test('confirming one shared understanding does not settle the thread', () => {
  const s = both(proposal(opened(), 'p1', 'consensus'), 'p1');
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.agreements.length, 1);
});

test('different versions cannot borrow approval, proposal text is immutable', () => {
  let s = proposal(opened(), 'old', 'consensus');
  s = approve(s, 'husband', 'old');
  s = proposal(s, 'new', 'consensus', { text: '修改后的另一版本' });
  s = approve(s, 'wife', 'new');
  assert.equal(s.agreements.length, 0);
  assert.throws(() => proposal(s, 'old', 'consensus', { text: '覆盖旧文' }), /duplicate_proposal/);
});

test('switch is bilateral and preserves old thread', () => {
  let s = step(opened(), 'wife', { type: 'create', id: 't2', title: '另一件事' });
  s = proposal(s, 'switch', 'switch', { target_id: 't2' });
  const one = approve(s, 'husband', 'switch');
  assert.equal(one.threads.t1.status, 'active');
  s = approve(one, 'wife', 'switch');
  assert.equal(s.threads.t1.status, 'pending');
  assert.equal(s.threads.t2.status, 'active');
  assert.equal(s.threads.t1.title, '周末安排');
});

test('reopen requires both, returns pending and keeps original conclusion', () => {
  let s = both(proposal(opened(), 'done', 'settle'), 'done');
  s = proposal(s, 'reopen', 'reopen', { text: '希望重新讨论的原因' });
  s = approve(s, 'husband', 'reopen');
  assert.equal(s.threads.t1.status, 'settled');
  s = approve(s, 'wife', 'reopen');
  assert.equal(s.threads.t1.status, 'pending');
  assert.equal(s.agreements.length, 1);
  assert.equal(s.threads.t1.summary, '我们认可这个具体版本');
  s = proposal(s, 'resume', 'switch', { target_id: 't1' });
  s = both(s, 'resume');
  assert.equal(s.threads.t1.status, 'active');
});

test('stale proposal cannot act after its source thread settles', () => {
  let s = proposal(opened(), 'old', 'settle');
  s = both(proposal(s, 'new-settle', 'settle', { text: '更新后的结论' }), 'new-settle');
  assert.throws(() => approve(s, 'wife', 'old'), /stale_proposal/);
});

test('a confirmed agreement advances the source semantic revision and stales older proposals', () => {
  let state = opened();
  state = step(state, 'husband', { type: 'propose', id: 'old', kind: 'consensus', thread_id: 't1', text: 'Earlier proposal' });
  state = step(state, 'wife', { type: 'propose', id: 'new', kind: 'consensus', thread_id: 't1', text: 'Confirmed understanding' });
  state = both(state, 'new');
  assert.equal(state.threads.t1.semantic_revision, 2);
  assert.equal(state.threads.t1.status, 'active');
  assert.throws(() => approve(state, 'husband', 'old'), /stale_proposal/);
});

test('a bilaterally approved principle is global, anchored without a thread, and stales earlier principle proposals', () => {
  let state = opened();
  state = step(state, 'husband', { type: 'propose', id: 'old', kind: 'principle', thread_id: 't1', text: 'Earlier principle' });
  state = step(state, 'wife', { type: 'propose', id: 'new', kind: 'principle', thread_id: 't1', text: 'We pause before responding' });
  state = both(state, 'new');
  assert.deepEqual(state.agreements, [{ proposal_id: 'new', thread_id: null, text: 'We pause before responding' }]);
  assert.equal(state.threads.t1.status, 'active');
  assert.equal(state.principle_revision, 1);
  assert.throws(() => approve(state, 'husband', 'old'), /stale_proposal/);
});

test('creating an unrelated pending thread does not stale an active-thread consensus approval', () => {
  let s = proposal(opened(), 'consensus', 'consensus');
  s = approve(s, 'husband', 'consensus');
  s = step(s, 'wife', { type: 'create', id: 't2', title: '另一件事' });
  s = approve(s, 'wife', 'consensus');
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.threads.t2.status, 'pending');
  assert.equal(s.agreements.length, 1);
});

test('approval text must exactly match the immutable proposal including whitespace', () => {
  const s = proposal(opened(), 'exact', 'consensus', { text: '  complete text\n\nwith spacing  ' });
  assert.throws(() => approve(s, 'husband', 'exact', 'complete text\n\nwith spacing'), /approval_text_mismatch/);
  assert.equal(approve(s, 'husband', 'exact').proposals.exact.approvals[0], 'husband');
});

test('reopening a different settled thread does not stale the active discussion proposal', () => {
  let s = both(proposal(opened(), 'settle-old', 'settle'), 'settle-old');
  s = step(s, 'wife', { type: 'create', id: 't2', title: '当前话题' });
  s = step(s, 'husband', { type: 'propose', id: 'current-consensus', kind: 'consensus', thread_id: 't2', target_id: null, text: '当前理解' });
  s = approve(s, 'husband', 'current-consensus');
  s = step(s, 'wife', { type: 'propose', id: 'reopen-old', kind: 'reopen', thread_id: 't1', target_id: null, text: '希望重新讨论旧议题的原因' });
  s = approve(s, 'husband', 'reopen-old');
  s = approve(s, 'wife', 'reopen-old');
  s = approve(s, 'wife', 'current-consensus');
  assert.equal(s.threads.t1.status, 'pending');
  assert.equal(s.threads.t2.status, 'active');
  assert.equal(s.agreements.length, 2);
});

test('switch proposals become stale when their pinned source and target threads change away and back', () => {
  let s = step(opened(), 'wife', { type: 'create', id: 't2', title: '切换目标' });
  s = step(s, 'husband', { type: 'propose', id: 'old-switch', kind: 'switch', thread_id: 't1', target_id: 't2', text: '先讨论目标议题' });
  s = approve(s, 'husband', 'old-switch');
  s = both(step(s, 'wife', { type: 'propose', id: 'switch-to-t2', kind: 'switch', thread_id: 't1', target_id: 't2', text: '切换到目标议题' }), 'switch-to-t2');
  s = both(step(s, 'husband', { type: 'propose', id: 'switch-back', kind: 'switch', thread_id: 't2', target_id: 't1', text: '切回原议题' }), 'switch-back');
  assert.equal(s.threads.t1.status, 'active');
  assert.equal(s.threads.t2.status, 'pending');
  assert.throws(() => approve(s, 'wife', 'old-switch'), /stale_proposal/);
});

test('outsider, empty text and reopening a live thread are refused', () => {
  assert.throws(() => approve(opened(), 'other', 'p1'), /forbidden/);
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
