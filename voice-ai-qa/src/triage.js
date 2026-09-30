// Free, rule-based checks run on every sampled call. These rank calls so you
// only spend Hume credits on the ones worth a closer listen.

const FRUSTRATION = [
  /\b(let me finish|i wasn'?t (done|finished)|hold on|wait,? wait|stop talking|you'?re not listening|listen to me)\b/i,
  /\b(real person|human|representative|operator|speak (to|with) (someone|somebody|a person)|transfer me)\b/i,
  /\b(i already (said|told you)|i just (said|told you)|like i said|as i said)\b/i,
  /\b(this is (ridiculous|stupid|annoying)|frustrat|annoying|forget it|never ?mind|are you a (robot|bot|machine)|is this a (robot|bot|recording))\b/i,
  /\b(what\?|huh\?|excuse me\?|that'?s not what i (said|asked))/i,
];

const TRAILING_CONNECTOR = /\b(and|but|so|or|because|the|a|to|my|i|um|uh|like|if|then|with|for|about|it'?s|was|is)\s*[,.]?$/i;

function toSec(ts, t0) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? (t - t0) / 1000 : null;
}

function words(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Normalize Bland transcript entries into [{role, text, t}] with t = seconds from call start. */
export function normalizeTranscript(call) {
  const entries = (call.transcripts || []).filter((e) => e && e.text && (e.user === 'user' || e.user === 'assistant'));
  const t0 = Date.parse(call.started_at || call.created_at || entries[0]?.created_at) || Date.parse(entries[0]?.created_at);
  return entries.map((e) => ({ role: e.user === 'user' ? 'customer' : 'ai', text: String(e.text).trim(), t: toSec(e.created_at, t0) }));
}

export function transcriptChecks(turns, { slowReplySec = 3 } = {}) {
  const flags = [];
  const slowReplies = [];
  const possibleCutoffs = [];
  const frustration = [];
  const repeats = [];

  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i];
    const next = turns[i + 1];
    const prev = turns[i - 1];

    if (cur.role === 'customer') {
      for (const re of FRUSTRATION) {
        if (re.test(cur.text)) { frustration.push({ t: cur.t, text: cur.text }); break; }
      }
      // Customer utterance that trails off and AI immediately takes the floor.
      if (next && next.role === 'ai' && cur.t != null && next.t != null) {
        const gap = next.t - cur.t;
        if (TRAILING_CONNECTOR.test(cur.text) && gap < 1.5) possibleCutoffs.push({ t: cur.t, text: cur.text, gap: +gap.toFixed(2) });
        if (gap > slowReplySec) slowReplies.push({ t: cur.t, gap: +gap.toFixed(2), after: cur.text.slice(0, 80) });
      }
    }

    if (cur.role === 'ai' && cur.text.includes('?')) {
      for (let j = Math.max(0, i - 12); j < i; j++) {
        if (turns[j].role === 'ai' && turns[j].text.includes('?') && jaccard(turns[j].text, cur.text) > 0.6) {
          repeats.push({ t: cur.t, text: cur.text.slice(0, 140), firstAt: turns[j].t });
          break;
        }
      }
    }
  }

  // Did the customer hang up right after the AI spoke without resolution?
  const last = turns[turns.length - 1];
  const lastCustomer = [...turns].reverse().find((t) => t.role === 'customer');
  const abruptEnd = !!(last && last.role === 'ai' && lastCustomer && FRUSTRATION.some((re) => re.test(lastCustomer.text)));

  if (possibleCutoffs.length) flags.push(`${possibleCutoffs.length} possible cut-off(s)`);
  if (slowReplies.length) flags.push(`${slowReplies.length} slow AI repl${slowReplies.length > 1 ? 'ies' : 'y'}`);
  if (frustration.length) flags.push(`${frustration.length} frustration phrase(s)`);
  if (repeats.length) flags.push(`${repeats.length} repeated question(s)`);
  if (abruptEnd) flags.push('ended on a frustrated note');

  return { flags, slowReplies, possibleCutoffs, frustration, repeats, abruptEnd };
}

/** Guess which stereo channel is the AI by comparing talk share to transcript word share. */
export function mapChannels(turns, audio) {
  if (!audio?.channelTalk) return null;
  const aiWords = turns.filter((t) => t.role === 'ai').reduce((n, t) => n + words(t.text).length, 0);
  const allWords = turns.reduce((n, t) => n + words(t.text).length, 0) || 1;
  const aiShare = aiWords / allWords;
  const { ch0, ch1 } = audio.channelTalk;
  const ch0Share = ch0 / ((ch0 + ch1) || 1);
  return Math.abs(ch0Share - aiShare) <= Math.abs(1 - ch0Share - aiShare) ? { ai: 'ch0', customer: 'ch1' } : { ai: 'ch1', customer: 'ch0' };
}

export function scoreTriage(tc, audio, turns) {
  let risk = 0;
  risk += tc.possibleCutoffs.length * 2;
  risk += tc.slowReplies.length * 1;
  risk += tc.frustration.length * 3;
  risk += tc.repeats.length * 2;
  if (tc.abruptEnd) risk += 4;
  const out = { ...tc, audio: null };
  if (audio) {
    const map = mapChannels(turns, audio);
    const aiInterrupts = (audio.talkOver || []).filter((o) => map && o.interrupter === map.ai);
    const custInterrupts = (audio.talkOver || []).filter((o) => map && o.interrupter === map.customer);
    risk += (audio.deadAir?.length || 0) * 1.5;
    risk += aiInterrupts.length * 2.5;
    out.audio = {
      duration: audio.duration,
      channels: audio.channels,
      deadAir: audio.deadAir,
      aiTalkedOverCustomer: map ? aiInterrupts : null,
      customerTalkedOverAi: map ? custInterrupts : null,
      speechRatio: audio.speechRatio,
    };
    if (audio.deadAir?.length) out.flags.push(`${audio.deadAir.length} dead-air gap(s)`);
    if (aiInterrupts.length) out.flags.push(`AI talked over customer ${aiInterrupts.length}x`);
  }
  return { triage: out, score: +risk.toFixed(1) };
}
