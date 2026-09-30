// Gemini listens to the actual call recording (not just the transcript) and
// writes the review: tone, talk-over, pauses, context, forgotten details.
import { config } from './config.js';
import { SCHEMA, MOMENT, fmtTranscript } from './claude.js';

export function geminiConfigured() {
  return !!config.geminiKey;
}

const EMOTION_POINT = {
  type: 'object',
  properties: {
    t: { type: 'number', description: 'seconds from call start' },
    speaker: { type: 'string', enum: ['customer', 'ai'] },
    emotion: { type: 'string', description: 'e.g. calm, pleased, neutral, confused, impatient, annoyed, angry, resigned' },
    intensity: { type: 'number', minimum: 0, maximum: 1 },
    note: { type: 'string' },
  },
  required: ['t', 'speaker', 'emotion', 'intensity'],
};

export const GEMINI_SCHEMA = {
  ...SCHEMA,
  properties: {
    ...SCHEMA.properties,
    customer_tone_start: { type: 'string', description: 'How the customer sounds in the first 30 seconds.' },
    customer_tone_end: { type: 'string', description: 'How the customer sounds at the end.' },
    emotion_timeline: { type: 'array', items: EMOTION_POINT, description: 'Customer (and notable AI) tone changes heard in the audio, in order.' },
    talk_over_events: { type: 'array', items: { ...MOMENT, properties: { ...MOMENT.properties, who_interrupted: { type: 'string', enum: ['ai', 'customer'] } } } },
    ai_voice_issues: { type: 'array', items: MOMENT, description: 'Robotic delivery, wrong pronunciation (names, streets, VINs), audio glitches, speaking too fast, awkward filler.' },
  },
  required: [...SCHEMA.required, 'emotion_timeline', 'talk_over_events'],
};

function h() {
  return { 'x-goog-api-key': config.geminiKey };
}

async function uploadFile(buf, mime) {
  const start = await fetch(`${config.geminiBase}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      ...h(),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'call-recording' } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!start.ok || !url) throw new Error(`Gemini upload start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const up = await fetch(url, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Length': String(buf.length) },
    body: buf,
  });
  const j = await up.json();
  if (!up.ok || !j?.file?.uri) throw new Error(`Gemini upload ${up.status}: ${JSON.stringify(j).slice(0, 300)}`);
  // wait until processed
  let file = j.file;
  for (let i = 0; i < 30 && file.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${config.geminiBase}/v1beta/${file.name}`, { headers: h() });
    if (r.ok) file = await r.json();
  }
  if (file.state === 'FAILED') throw new Error('Gemini could not process the audio file');
  return file.uri;
}

function buildPrompt({ turns, triage, callMeta, channels }) {
  return `You are listening to a recorded phone call between an automotive dealership's AI phone agent (Alpha Drive AI, running on a Bland pathway) and a customer. The agent books service appointments, sales appointments and test drives.

LISTEN to the audio. Judge it like a demanding BDC manager who hears everything: tone of voice, sighs, hesitation, impatience, people talking over each other, awkward silences, robotic or rushed delivery, mispronounced names. The transcript below is machine-generated and can be wrong; trust the audio when they disagree.
${channels === 2 ? 'The recording is stereo: each party is on its own channel.' : ''}

Answer these questions, citing the time (seconds from start) and a short quote for every finding:
1. Did the AI cut the customer off or talk over them? Who interrupted whom, and did the customer have to repeat themselves?
2. Did the AI understand the context and intent, or answer the wrong question?
3. Were there long pauses, dead air or slow replies the customer would notice? How long?
4. Did the AI forget or re-ask something the customer already gave earlier (name, vehicle, date, service, transportation, phone)?
5. Was the customer annoyed or frustrated with the AI? Describe how their tone changed over the call and what caused it.
6. What did the AI miss or mishandle, and what concrete pathway/prompt change would fix it?
Do not invent problems. If something was fine, say so. overall_score: 10 = a great dealership employee would be proud of the call.

CALL META
${JSON.stringify(callMeta)}

MEASURED TIMING FROM THE AUDIO AND TRANSCRIPT (use these to confirm what you hear)
${JSON.stringify({ flags: triage?.flags, deadAir: triage?.audio?.deadAir, aiTalkedOverCustomer: triage?.audio?.aiTalkedOverCustomer, slowReplies: triage?.slowReplies })}

TRANSCRIPT (approximate timestamps)
${fmtTranscript(turns)}

Respond with JSON only, matching the schema.`;
}

function parseJson(text) {
  const t = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t);
}

export async function testGeminiKey() {
  if (!config.geminiKey) return { ok: false, message: 'GEMINI_API_KEY is not set.' };
  try {
    const res = await fetch(`${config.geminiBase}/v1beta/models/${config.geminiModel}`, { headers: h() });
    const text = await res.text();
    if (res.ok) return { ok: true, message: `Gemini key works. Model ${config.geminiModel} is available.` };
    return { ok: false, message: `Gemini returned ${res.status} for model ${config.geminiModel}.`, detail: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, message: `Could not reach Gemini: ${e.message}` };
  }
}

export async function geminiReview({ audio, mime = 'audio/mp3', turns, triage, callMeta, channels }) {
  const audioPart = audio.length < 14 * 1024 * 1024
    ? { inlineData: { mimeType: mime, data: audio.toString('base64') } }
    : { fileData: { mimeType: mime, fileUri: await uploadFile(audio, mime) } };

  const body = (withSchema) => JSON.stringify({
    contents: [{ role: 'user', parts: [audioPart, { text: buildPrompt({ turns, triage, callMeta, channels }) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(withSchema ? { responseJsonSchema: GEMINI_SCHEMA } : {}),
      temperature: 0.2,
    },
  });

  const url = `${config.geminiBase}/v1beta/models/${config.geminiModel}:generateContent`;
  let res, text;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, { method: 'POST', headers: { ...h(), 'Content-Type': 'application/json' }, body: body(attempt < 2) });
    text = await res.text();
    if (res.ok) break;
    // Schema rejected: retry once without it (the prompt still describes the shape).
    if (res.status === 400 && /schema/i.test(text) && attempt < 2) { attempt = 1; continue; }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    break;
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!out) throw new Error(`Gemini returned no review (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`);
  const review = parseJson(out);
  review._usage = j.usageMetadata || null;
  review._model = config.geminiModel;
  return review;
}
