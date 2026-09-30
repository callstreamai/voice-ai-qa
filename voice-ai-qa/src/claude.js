// Claude reads the transcript alongside timing data and Hume's emotion timeline
// to judge the things a transcript alone can't show clearly.
import { config } from './config.js';

export function claudeConfigured() {
  return !!config.anthropicKey;
}

const MOMENT = { type: 'object', properties: { t: { type: 'number', description: 'seconds from call start, if known' }, quote: { type: 'string' }, note: { type: 'string' } }, required: ['note'] };

const SCHEMA = {
  type: 'object',
  properties: {
    overall_score: { type: 'integer', minimum: 1, maximum: 10, description: 'Overall AI agent quality on this call. 10 = a great dealership employee would be proud of it.' },
    outcome: { type: 'string', description: 'What happened: appointment booked / rescheduled / transferred / info given / abandoned, etc.' },
    customer_goal: { type: 'string' },
    goal_achieved: { type: 'string', enum: ['yes', 'partial', 'no', 'unclear'] },
    cut_off_customer: { type: 'object', properties: { verdict: { type: 'string', enum: ['none', 'minor', 'significant'] }, moments: { type: 'array', items: MOMENT } }, required: ['verdict', 'moments'] },
    context_understanding: { type: 'object', properties: { verdict: { type: 'string', enum: ['good', 'mixed', 'poor'] }, moments: { type: 'array', items: MOMENT } }, required: ['verdict', 'moments'] },
    forgot_earlier_info: { type: 'object', properties: { verdict: { type: 'string', enum: ['no', 'yes'] }, moments: { type: 'array', items: MOMENT } }, required: ['verdict', 'moments'] },
    pauses_and_latency: { type: 'object', properties: { verdict: { type: 'string', enum: ['fine', 'noticeable', 'bad'] }, moments: { type: 'array', items: MOMENT } }, required: ['verdict', 'moments'] },
    customer_annoyed_with_ai: { type: 'object', properties: { verdict: { type: 'string', enum: ['no', 'mildly', 'clearly'] }, cause: { type: 'string' }, moments: { type: 'array', items: MOMENT } }, required: ['verdict', 'moments'] },
    missed_or_mishandled: { type: 'array', items: MOMENT, description: 'Requests, questions or details the AI missed, answered wrong, or failed to act on (wrong date/time, ignored transportation need, unanswered question, etc.).' },
    did_well: { type: 'array', items: { type: 'string' } },
    fix_suggestions: { type: 'array', items: { type: 'string' }, description: 'Concrete pathway or prompt changes that would have prevented the problems.' },
    one_line_summary: { type: 'string' },
  },
  required: ['overall_score', 'outcome', 'goal_achieved', 'cut_off_customer', 'context_understanding', 'forgot_earlier_info', 'pauses_and_latency', 'customer_annoyed_with_ai', 'missed_or_mishandled', 'fix_suggestions', 'one_line_summary'],
};

function fmtTranscript(turns) {
  return turns.map((t) => `[${t.t != null ? t.t.toFixed(1) + 's' : '?'}] ${t.role === 'ai' ? 'AI' : 'CUSTOMER'}: ${t.text}`).join('\n');
}

export async function claudeReview({ turns, triage, hume, callMeta }) {
  const humeBlock = hume
    ? JSON.stringify({ customer: hume.customer, vocalBursts: hume.vocalBursts, utterances: hume.utterances.map((u) => ({ role: u.role, t: u.t, text: u.text?.slice(0, 120), neg: u.negative, conf: u.confused, pos: u.positive })) })
    : 'Not available for this call.';

  const prompt = `You are reviewing a recorded phone call between an automotive dealership's AI agent (Alpha Drive AI, built on a Bland pathway) and a customer. The agent schedules service appointments, sales appointments and test drives.

Judge the call like a demanding BDC manager listening to the recording. A transcript alone hides a lot, so use the timing data and the voice-emotion data below. Be specific: cite timestamps and short quotes. Do not invent problems; if something is fine, say so.

Check specifically:
1. Did the AI cut the customer off or talk over them? (Use talk-over events, trailing-off fragments, and customer complaints.)
2. Did the AI understand context and intent, or answer the wrong question?
3. Were there long pauses, dead air, or slow replies the customer would notice?
4. Did the AI forget or re-ask something the customer already gave earlier (name, vehicle, date, service, transportation)?
5. Was the customer annoyed with the AI? Use the voice-emotion scores (0-1; >0.3 negative is meaningful, rising trend is a warning) and wording. Name the cause.
6. Anything missed or mishandled, and what pathway/prompt change would fix it.

CALL META
${JSON.stringify(callMeta)}

TRANSCRIPT (seconds from call start; Bland timestamps are approximate)
${fmtTranscript(turns)}

FREE TIMING / RULE CHECKS
${JSON.stringify(triage)}

HUME VOICE-EMOTION ANALYSIS (audio)
${humeBlock}

Record your review with the record_review tool.`;

  const res = await fetch(`${config.anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 4000,
      tools: [{ name: 'record_review', description: 'Record the structured call review.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_review' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const tool = (j.content || []).find((c) => c.type === 'tool_use');
  if (!tool) throw new Error('Claude returned no review');
  return tool.input;
}
