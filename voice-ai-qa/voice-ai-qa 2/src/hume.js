// Hume adapter. Targets Hume's batch Expression Measurement API (v0 /batch/jobs).
// Hume retired the public version of this API in June 2026 and now offers
// "Tagger"/"Prosody" APIs by request. If your key is for the newer API, point
// HUME_API_BASE at it; the response parsing below is shape-tolerant.
import { config } from './config.js';

const NEG = ['Annoyance', 'Anger', 'Contempt', 'Disappointment', 'Distress', 'Disgust'];
const CONFUSED = ['Confusion', 'Doubt'];
const POS = ['Calmness', 'Satisfaction', 'Joy', 'Interest', 'Contentment', 'Relief', 'Amusement'];

function h(extra = {}) {
  return { 'X-Hume-Api-Key': config.humeKey, ...extra };
}

export function humeConfigured() {
  return !!config.humeKey;
}

export async function testHumeKey() {
  if (!config.humeKey) return { ok: false, message: 'HUME_API_KEY is not set.' };
  try {
    const res = await fetch(`${config.humeBase}/batch/jobs?limit=1`, { headers: h() });
    const text = await res.text();
    if (res.ok) return { ok: true, message: 'Key accepted by the Hume batch API.' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Hume rejected the key (${res.status}). It may be for EVI/TTS only, or batch expression measurement is not enabled on your account.`, detail: text.slice(0, 300) };
    if (res.status === 404 || res.status === 410) return { ok: false, message: `Hume batch endpoint not found (${res.status}). The public Expression Measurement API was retired in June 2026 — ask Hume for Tagger/Prosody API access and set HUME_API_BASE.`, detail: text.slice(0, 300) };
    return { ok: false, message: `Unexpected Hume response ${res.status}`, detail: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, message: `Could not reach Hume: ${e.message}` };
  }
}

export async function startJob(audio, filename = 'call.mp3') {
  const form = new FormData();
  form.append('json', JSON.stringify({
    models: {
      prosody: { granularity: 'utterance', identify_speakers: true },
      burst: {},
    },
    transcription: { language: 'en' },
  }));
  form.append('file', new Blob([audio.buf], { type: audio.type || 'audio/mpeg' }), filename);
  const res = await fetch(`${config.humeBase}/batch/jobs`, { method: 'POST', headers: h(), body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hume start ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  if (!j.job_id) throw new Error(`Hume start: no job_id in ${text.slice(0, 200)}`);
  return j.job_id;
}

export async function waitForJob(jobId, { timeoutMs = 15 * 60 * 1000, onStatus } = {}) {
  const t0 = Date.now();
  let delay = 3000;
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${config.humeBase}/batch/jobs/${jobId}`, { headers: h() });
    if (res.ok) {
      const j = await res.json();
      const status = j?.state?.status || j?.status;
      onStatus?.(status);
      if (status === 'COMPLETED') return;
      if (status === 'FAILED') throw new Error(`Hume job failed: ${j?.state?.message || 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 20000);
  }
  throw new Error('Hume job timed out');
}

export async function getPredictions(jobId) {
  const res = await fetch(`${config.humeBase}/batch/jobs/${jobId}/predictions`, { headers: h() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hume predictions ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function words(s) {
  return new Set((s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

function sum(emotions, names) {
  let best = 0;
  for (const e of emotions || []) if (names.includes(e.name)) best = Math.max(best, e.score);
  return best;
}

function topN(emotions, n = 3) {
  return [...(emotions || [])].sort((a, b) => b.score - a.score).slice(0, n).map((e) => ({ name: e.name, score: +e.score.toFixed(3) }));
}

/** Turn raw Hume predictions into a compact, reviewable summary. */
export function summarizeHume(raw, turns) {
  const preds = [];
  const bursts = [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const src of list) {
    for (const p of src?.results?.predictions || []) {
      for (const g of p?.models?.prosody?.grouped_predictions || []) {
        for (const u of g.predictions || []) preds.push({ speaker: g.id || u.speaker || 'unknown', text: u.text, begin: u.time?.begin, end: u.time?.end, emotions: u.emotions });
      }
      for (const g of p?.models?.burst?.grouped_predictions || []) {
        for (const u of g.predictions || []) bursts.push({ begin: u.time?.begin, end: u.time?.end, top: topN(u.emotions, 2), descriptions: (u.descriptions || []).slice(0, 2).map((d) => d.name) });
      }
    }
  }

  // Figure out which Hume speaker is the customer by matching words against the Bland transcript.
  const custWords = words(turns.filter((t) => t.role === 'customer').map((t) => t.text).join(' '));
  const aiWords = words(turns.filter((t) => t.role === 'ai').map((t) => t.text).join(' '));
  const bySpeaker = {};
  for (const p of preds) {
    const s = (bySpeaker[p.speaker] ||= { c: 0, a: 0 });
    for (const w of words(p.text)) { if (custWords.has(w)) s.c++; if (aiWords.has(w)) s.a++; }
  }
  const speakers = Object.keys(bySpeaker);
  let customerSpeaker = null;
  if (speakers.length > 1) customerSpeaker = speakers.sort((x, y) => (bySpeaker[y].c - bySpeaker[y].a) - (bySpeaker[x].c - bySpeaker[x].a))[0];

  const labelled = preds.map((p) => {
    let role = 'unknown';
    if (customerSpeaker) role = p.speaker === customerSpeaker ? 'customer' : 'ai';
    else {
      const w = words(p.text); let c = 0, a = 0;
      for (const x of w) { if (custWords.has(x)) c++; if (aiWords.has(x)) a++; }
      role = c > a ? 'customer' : a > c ? 'ai' : 'unknown';
    }
    return {
      role,
      t: p.begin != null ? +p.begin.toFixed(1) : null,
      end: p.end != null ? +p.end.toFixed(1) : null,
      text: p.text,
      negative: +sum(p.emotions, NEG).toFixed(3),
      confused: +sum(p.emotions, CONFUSED).toFixed(3),
      positive: +sum(p.emotions, POS).toFixed(3),
      top: topN(p.emotions),
    };
  });

  const cust = labelled.filter((u) => u.role === 'customer');
  const avg = (arr, k) => (arr.length ? +(arr.reduce((s, x) => s + x[k], 0) / arr.length).toFixed(3) : null);
  const third = Math.max(1, Math.floor(cust.length / 3));
  const early = cust.slice(0, third), late = cust.slice(-third);

  return {
    utterances: labelled,
    customer: {
      avgNegative: avg(cust, 'negative'),
      avgConfused: avg(cust, 'confused'),
      avgPositive: avg(cust, 'positive'),
      negativeTrend: early.length && late.length ? +(avg(late, 'negative') - avg(early, 'negative')).toFixed(3) : null,
      peakNegative: [...cust].sort((a, b) => b.negative - a.negative).slice(0, 5),
      peakConfused: [...cust].sort((a, b) => b.confused - a.confused).slice(0, 3),
    },
    vocalBursts: bursts.filter((b) => b.top?.[0] && ['Sigh', 'Groan', 'Annoyance', 'Disappointment', 'Frustration'].some((n) => JSON.stringify(b).includes(n))).slice(0, 10),
    speakerMapping: customerSpeaker ? 'by-speaker' : 'by-text',
  };
}
