import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnderstandingRecord, QUERY_ERROR_STATUS, QueryReadError } from '../../sites/family-therapist/src/server/queries.mjs';

test('typed read errors map membership, missing records, malformed content, and storage faults by code', () => {
  assert.equal(new QueryReadError('membership_required', 'membership').status, 403);
  assert.equal(new QueryReadError('thread_not_found', 'thread').status, 404);
  assert.equal(new QueryReadError('invalid_message_json', 'record').status, 500);
  assert.equal(new QueryReadError('invalid_result_set', 'database').status, 503);
  assert.equal(new QueryReadError('invalid_record', 'record').status, 500);
  assert.equal(QUERY_ERROR_STATUS.unsupported_query, 400);
});


test('corrupt shared-understanding records fail explicitly instead of becoming a normal empty summary', () => {
  assert.throws(() => parseUnderstandingRecord('{broken', 'event-1'), (error) => error instanceof QueryReadError && error.code === 'invalid_message_json' && error.status === 500);
  assert.throws(() => parseUnderstandingRecord('"not an object"', 'event-2'), (error) => error instanceof QueryReadError && error.code === 'invalid_record' && error.status === 500);
  assert.deepEqual(parseUnderstandingRecord('{"common_points":[]}', 'event-3'), { common_points: [] });
});
