import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscript, transcriptChecks } from '../src/triage.js';

const t0 = Date.parse('2026-09-20T15:00:00Z');
const at = (s) => new Date(t0 + s * 1000).toISOString();

test('flags cut-off, slow reply, frustration and repeated question', () => {
  const turns = normalizeTranscript({
    started_at: at(0),
    transcripts: [
      { user: 'assistant', text: 'How can I help?', created_at: at(1) },
      { user: 'user', text: 'I need an oil change and', created_at: at(5) },
      { user: 'assistant', text: 'What day works for you?', created_at: at(5.4) },
      { user: 'user', text: 'Tuesday', created_at: at(8) },
      { user: 'assistant', text: 'What day works for you?', created_at: at(13) },
      { user: 'user', text: 'I already told you. Can I talk to a real person?', created_at: at(15) },
    ],
  });
  const r = transcriptChecks(turns, { slowReplySec: 3 });
  assert.equal(r.possibleCutoffs.length, 1);
  assert.equal(r.slowReplies.length, 1);
  assert.equal(r.frustration.length, 1);
  assert.equal(r.repeats.length, 1);
});

test('clean call has no flags', () => {
  const turns = normalizeTranscript({
    started_at: at(0),
    transcripts: [
      { user: 'assistant', text: 'How can I help?', created_at: at(1) },
      { user: 'user', text: 'I need an oil change on Tuesday.', created_at: at(5) },
      { user: 'assistant', text: 'Booked for Tuesday at 9.', created_at: at(6.5) },
      { user: 'user', text: 'Perfect, thanks.', created_at: at(9) },
    ],
  });
  assert.deepEqual(transcriptChecks(turns).flags, []);
});
