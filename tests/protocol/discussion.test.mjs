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
