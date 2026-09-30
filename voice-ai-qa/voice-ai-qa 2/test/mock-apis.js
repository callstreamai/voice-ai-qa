// Local mock of Bland, Hume and Anthropic for end-to-end testing: node test/mock-apis.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const audio = fs.readFileSync(path.join(dir, 'fixture_stereo.mp3'));
const PATHWAYS = [{ id: 'pw-service', name: 'Service Scheduling' }, { id: 'pw-sales', name: 'Sales Appointments' }];
const base = Date.parse('2026-09-20T15:00:00Z');

function mkCall(i) {
  const start = base + i * 3600e3;
  const at = (s) => new Date(start + s * 1000).toISOString();
  const bad = i % 3 === 0;
  return {
    call_id: `call-${i}`, created_at: at(0), started_at: at(0), corrected_duration: 40, call_length: 0.67, completed: true,
    answered_by: 'human', from: '+15550001', to: '+15550002', inbound: true,
    pathway_id: i % 2 ? 'pw-service' : 'pw-sales', recording_url: null, summary: `Customer called about service (${i}).`,
    variables: {}, transcripts: [
      { id: 1, created_at: at(1), text: 'Thanks for calling Cherry Hill Nissan service, how can I help?', user: 'assistant' },
      { id: 2, created_at: at(6), text: 'Hi, I need an oil change for my Rogue and', user: 'user' },
      { id: 3, created_at: at(bad ? 6.5 : 9), text: 'Sure! What day works for you?', user: 'assistant' },
      { id: 4, created_at: at(14), text: bad ? 'I wasn\'t done, I also need a loaner.' : 'Tuesday morning please.', user: 'user' },
      { id: 5, created_at: at(bad ? 22 : 15), text: 'Sure! What day works for you?', user: 'assistant' },
      { id: 6, created_at: at(24), text: bad ? 'I already told you, Tuesday. Can I talk to a real person?' : 'Great thanks.', user: 'user' },
      { id: 7, created_at: at(30), text: 'You are booked for Tuesday at 9am.', user: 'assistant' },
    ],
  };
}
const CALLS = Array.from({ length: 60 }, (_, i) => mkCall(i));

const humeJobs = {};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    // Bland
    if (u.pathname === '/bland/v1/pathway') return json(PATHWAYS);
    if (u.pathname === '/bland/v1/calls') {
      const from = Number(u.searchParams.get('from') || 0), to = Number(u.searchParams.get('to') || 1000);
      const page = CALLS.slice(from, to).map(({ transcripts, pathway_id, ...m }) => m);
      return json({ total_count: CALLS.length, count: page.length, calls: page });
    }
    let m = u.pathname.match(/^\/bland\/v1\/calls\/([^/]+)\/recording$/);
    if (m) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(audio); }
    m = u.pathname.match(/^\/bland\/v1\/calls\/([^/]+)$/);
    if (m) return json(CALLS.find((c) => c.call_id === m[1]) || {}, 200);

    // Hume
    if (u.pathname === '/hume/v0/batch/jobs' && req.method === 'GET') return json([]);
    if (u.pathname === '/hume/v0/batch/jobs' && req.method === 'POST') {
      const id = `job-${Object.keys(humeJobs).length + 1}`; humeJobs[id] = Date.now(); return json({ job_id: id });
    }
    m = u.pathname.match(/^\/hume\/v0\/batch\/jobs\/([^/]+)(\/predictions)?$/);
    if (m) {
      if (!m[2]) return json({ state: { status: Date.now() - humeJobs[m[1]] > 2000 ? 'COMPLETED' : 'IN_PROGRESS' } });
      const e = (n, s) => ({ name: n, score: s });
      return json([{ results: { predictions: [{ models: {
        prosody: { grouped_predictions: [
          { id: 'spk_0', predictions: [{ text: 'Thanks for calling Cherry Hill Nissan service, how can I help?', time: { begin: 0.5, end: 4.8 }, emotions: [e('Calmness', 0.6), e('Interest', 0.4)] }] },
          { id: 'spk_1', predictions: [
            { text: 'Hi, I need an oil change for my Rogue and', time: { begin: 5.5, end: 10.9 }, emotions: [e('Calmness', 0.5), e('Annoyance', 0.05)] },
            { text: "I wasn't done, I also need a loaner.", time: { begin: 16, end: 20 }, emotions: [e('Annoyance', 0.45), e('Anger', 0.2)] },
            { text: 'I already told you, Tuesday. Can I talk to a real person?', time: { begin: 22, end: 24 }, emotions: [e('Annoyance', 0.7), e('Disappointment', 0.5)] },
          ] },
        ] },
        burst: { grouped_predictions: [{ id: 'unknown', predictions: [{ time: { begin: 21, end: 21.6 }, emotions: [e('Annoyance', 0.6)], descriptions: [{ name: 'Sigh', score: 0.8 }] }] }] },
      } }] } }]);
    }

    // Gemini
    if (/^\/gemini\/v1beta\/models\/[^/:]+$/.test(u.pathname) && req.method === 'GET') return json({ name: 'models/gemini-3.8-flash' });
    if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname)) {
      const b = JSON.parse(body);
      const part = b.contents[0].parts[0];
      if (!part.inlineData?.data || req.headers['x-goog-api-key'] !== 'g') return json({ error: { message: 'bad request' } }, 400);
      globalThis.lastGemini = { audioBytes: Buffer.from(part.inlineData.data, 'base64').length, schema: !!b.generationConfig.responseJsonSchema };
      console.log('gemini call', JSON.stringify(globalThis.lastGemini));
      const mo = (note, t, quote) => ({ note, t, quote });
      const review = {
        overall_score: 3, outcome: 'Booked Tuesday 9am', customer_goal: 'Oil change and a loaner', goal_achieved: 'partial',
        cut_off_customer: { verdict: 'significant', moments: [mo('AI started talking while the customer was mid-sentence', 6, 'I need an oil change for my Rogue and')] },
        context_understanding: { verdict: 'mixed', moments: [mo('Ignored the loaner request', 16)] },
        forgot_earlier_info: { verdict: 'yes', moments: [mo('Asked for the day again after hearing Tuesday', 22)] },
        pauses_and_latency: { verdict: 'noticeable', moments: [mo('About 6 seconds of silence before the confirmation', 24)] },
        customer_annoyed_with_ai: { verdict: 'clearly', cause: 'Being cut off, then asked the same question twice', moments: [mo('Audible sigh, then asks for a real person', 22)] },
        missed_or_mishandled: [mo('Loaner never offered', 16)], did_well: ['Warm greeting'],
        fix_suggestions: ['Wait for end of turn on the service-type node', 'Capture transportation before offering times'],
        one_line_summary: 'Booked, but the AI cut the customer off, re-asked the day and the customer ended audibly frustrated.',
        customer_tone_start: 'Relaxed, friendly', customer_tone_end: 'Clipped and irritated',
        emotion_timeline: [{ t: 5, speaker: 'customer', emotion: 'calm', intensity: 0.6 }, { t: 16, speaker: 'customer', emotion: 'impatient', intensity: 0.5, note: 'raises voice' }, { t: 22, speaker: 'customer', emotion: 'annoyed', intensity: 0.8, note: 'sighs' }],
        talk_over_events: [{ t: 16, who_interrupted: 'ai', note: 'AI spoke over the loaner request' }],
        ai_voice_issues: [{ t: 30, note: 'Read the time as "nine hundred"' }],
      };
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(review) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1500 } });
    }

    // Anthropic
    if (u.pathname === '/anthropic/v1/messages') {
      const mo = (note, t) => ({ note, t });
      return json({ content: [{ type: 'tool_use', name: 'record_review', input: {
        overall_score: 4, outcome: 'Appointment booked Tuesday 9am', customer_goal: 'Oil change + loaner', goal_achieved: 'partial',
        cut_off_customer: { verdict: 'significant', moments: [mo('AI replied 0.5s after customer trailed off on "and"', 6)] },
        context_understanding: { verdict: 'mixed', moments: [] },
        forgot_earlier_info: { verdict: 'yes', moments: [mo('Re-asked the day after customer said Tuesday', 22)] },
        pauses_and_latency: { verdict: 'noticeable', moments: [mo('6s dead air', 24)] },
        customer_annoyed_with_ai: { verdict: 'clearly', cause: 'Repeated question and ignored loaner request', moments: [mo('Asked for a real person', 24)] },
        missed_or_mishandled: [mo('Loaner request never addressed', 14)],
        did_well: ['Friendly greeting'], fix_suggestions: ['Raise interruption threshold on the service-type node', 'Capture transportation need before date'],
        one_line_summary: 'Booked, but cut the customer off, re-asked the day and ignored the loaner request.',
      } }] });
    }
    json({ error: 'not found ' + u.pathname }, 404);
  });
}).listen(4010, () => console.log('mock on 4010'));
