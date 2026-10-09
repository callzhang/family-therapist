export function initialDiscussion(members) {
  if (members.length !== 2 || new Set(members).size !== 2) throw new Error('two_members_required');
  return { members: [...members], threads: {}, proposals: {}, agreements: [], revision: 0, principle_revision: 0 };
}

function updateThread(thread, changes) {
  const changed = Object.entries(changes).some(([key, value]) => thread[key] !== value);
  if (!changed) return;
  Object.assign(thread, changes);
  thread.semantic_revision += 1;
}

function recordThreadAgreement(thread) {
  thread.semantic_revision += 1;
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
    case 'principle':
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
        value: { id: action.id, title: action.title, summary: '', status: active ? 'pending' : 'active', semantic_revision: 1 },
        enumerable: true, configurable: true, writable: true,
      });
      next.revision += 1;
      break;
    }
    case 'propose': {
      if (Object.hasOwn(next.proposals, action.id)) throw new Error('duplicate_proposal');
      const thread = next.threads[action.thread_id];
      const target = action.kind === 'switch' ? next.threads[action.target_id] : null;
      const p = {
        id: action.id, kind: action.kind, thread_id: action.thread_id,
        target_id: action.target_id ?? null, text: action.text,
        thread_revision: thread?.semantic_revision ?? null,
        target_revision: target?.semantic_revision ?? null,
        principle_revision: next.principle_revision,
        approvals: [], applied: false,
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
      if (action.text !== p.text) throw new Error('approval_text_mismatch');
      if (p.applied) return next;
      const source = next.threads[p.thread_id];
      if (!source || source.semantic_revision !== p.thread_revision || p.principle_revision !== next.principle_revision) throw new Error('stale_proposal');
      if (p.kind === 'switch') {
        const target = next.threads[p.target_id];
        if (!target || target.semantic_revision !== p.target_revision) throw new Error('stale_proposal');
      }
      validateProposal(next, p);
      if (!p.approvals.includes(actor)) p.approvals.push(actor);
      if (!next.members.every(m => p.approvals.includes(m))) return next;
      switch (p.kind) {
        case 'consensus':
        case 'settle':
          next.agreements.push({ proposal_id: p.id, thread_id: p.thread_id, text: p.text });
          if (p.kind === 'settle') updateThread(next.threads[p.thread_id], { status: 'settled', summary: p.text });
          else recordThreadAgreement(next.threads[p.thread_id]);
          break;
        case 'principle':
          next.agreements.push({ proposal_id: p.id, thread_id: null, text: p.text });
          next.principle_revision += 1;
          recordThreadAgreement(next.threads[p.thread_id]);
          break;
        case 'reopen':
          updateThread(next.threads[p.thread_id], { status: 'pending' });
          break;
        case 'switch':
          for (const thread of Object.values(next.threads)) {
            if (thread.status === 'active') updateThread(thread, { status: 'pending' });
          }
          updateThread(next.threads[p.target_id], { status: 'active' });
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
