import { config } from './config.js';
import { q } from './db.js';
import { sampleCalls, downloadRecording } from './bland.js';
import { analyzeAudio, audioMinutes, compactMp3 } from './audio.js';
import { geminiReview, geminiConfigured } from './gemini.js';
import { normalizeTranscript, transcriptChecks, scoreTriage } from './triage.js';
import * as hume from './hume.js';
import { claudeReview, claudeConfigured } from './claude.js';

const accountById = (id) => config.blandAccounts.find((a) => a.id === id);

async function setBatch(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q(`UPDATE batches SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]))]);
}

// ---------- simple concurrency-limited in-process queues ----------
function makeQueue(concurrency) {
  const items = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && items.length) {
      const fn = items.shift();
      running++;
      Promise.resolve().then(fn).catch((e) => console.error('job error', e)).finally(() => { running--; pump(); });
    }
  };
  return { push(fn) { items.push(fn); pump(); }, get size() { return items.length + running; } };
}
const batchQueue = makeQueue(1);
const triageQueue = makeQueue(4);
const reviewQueue = makeQueue(2);

// ---------- batch: sample + free triage ----------
export function enqueueBatch(batchId) {
  batchQueue.push(() => runBatch(batchId));
}

async function runBatch(batchId) {
  const [b] = await q('SELECT * FROM batches WHERE id = $1', [batchId]);
  if (!b) return;
  const accounts = b.account_ids.map(accountById).filter(Boolean);
  try {
    await setBatch(batchId, { status: 'sampling', progress: { stage: 'Starting' } });
    const { picked, poolSize, checked } = await sampleCalls(accounts, {
      n: b.sample_size,
      pathwayId: b.pathway_id,
      startDate: b.start_date || undefined,
      endDate: b.end_date || undefined,
      minSeconds: b.min_seconds,
      onProgress: (p) => setBatch(batchId, { progress: p }).catch(() => {}),
    });

    for (const c of picked) {
      await q(
        `INSERT INTO calls (batch_id, account_id, account_name, call_id, pathway_id, created_at, started_at, duration_sec, from_number, to_number, inbound, recording_url, summary, transcript, variables)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
        [batchId, c._account.id, c._account.name, c.call_id, c.pathway_id || null, c.created_at || null, c.started_at || null,
          Number(c.corrected_duration) || Number(c.call_length || 0) * 60 || null, c.from || null, c.to || null, c.inbound ?? null,
          c.recording_url || null, c.summary || null, JSON.stringify(c.transcripts || []), JSON.stringify(c.variables || {})]
      );
    }
    const note = picked.length < b.sample_size ? `Only ${picked.length} matching calls found (pool ${poolSize}, checked ${checked}).` : null;
    await setBatch(batchId, { status: 'triaging', progress: { stage: 'Triage', done: 0, total: picked.length, note } });
    await triageBatch(batchId);
  } catch (e) {
    console.error(e);
    await setBatch(batchId, { status: 'error', error: String(e.message || e) });
  }
}

async function triageBatch(batchId) {
  const [b] = await q('SELECT * FROM batches WHERE id = $1', [batchId]);
  const rows = await q(`SELECT id FROM calls WHERE batch_id = $1 AND triage_status = 'pending'`, [batchId]);
  const [{ total }] = await q('SELECT count(*)::int AS total FROM calls WHERE batch_id = $1', [batchId]);
  await Promise.all(rows.map((r) => new Promise((resolve) => triageQueue.push(async () => {
    await triageCall(r.id, b.audio_timing);
    const [{ done }] = await q(`SELECT count(*)::int AS done FROM calls WHERE batch_id = $1 AND triage_status <> 'pending'`, [batchId]);
    const prog = b.progress || {};
    await setBatch(batchId, { progress: { ...prog, stage: 'Triage', done, total } }).catch(() => {});
    resolve();
  }))));
  const [s] = await q(`SELECT count(*)::int AS n, avg(triage_score)::real AS avg_risk,
      count(*) FILTER (WHERE triage_score >= 5)::int AS high_risk FROM calls WHERE batch_id = $1`, [batchId]);
  const [cur] = await q('SELECT progress FROM batches WHERE id=$1', [batchId]);
  await setBatch(batchId, { status: 'ready', summary: s, progress: { ...(cur.progress || {}), stage: 'Done' } });
}

async function triageCall(rowId, withAudio) {
  const [c] = await q('SELECT * FROM calls WHERE id = $1', [rowId]);
  try {
    const call = { transcripts: c.transcript, started_at: c.started_at?.toISOString(), created_at: c.created_at?.toISOString() };
    const turns = normalizeTranscript(call);
    const tc = transcriptChecks(turns, { slowReplySec: config.slowReplySec });
    let audio = null, audioErr = null;
    if (withAudio) {
      try {
        const rec = await downloadRecording(accountById(c.account_id), { call_id: c.call_id, recording_url: c.recording_url });
        audio = await analyzeAudio(rec.buf, { deadAirSec: config.deadAirSec });
      } catch (e) { audioErr = e.message; }
    }
    const { triage, score } = scoreTriage(tc, audio, turns);
    if (audioErr) triage.audioError = audioErr;
    await q(`UPDATE calls SET triage = $2, triage_score = $3, triage_status = 'done' WHERE id = $1`, [rowId, JSON.stringify(triage), score]);
  } catch (e) {
    await q(`UPDATE calls SET triage_status = 'error', triage_error = $2 WHERE id = $1`, [rowId, e.message]);
  }
}

// ---------- on-demand deep review (Gemini listens to audio; Hume/Claude optional) ----------
export async function humeUsage() {
  const [r] = await q(`SELECT count(*)::int AS n, coalesce(sum(audio_minutes),0)::real AS minutes
    FROM reviews WHERE requested_at > now() - interval '24 hours'
      AND (coalesce(gemini_status,'skipped') <> 'skipped' OR coalesce(hume_status,'skipped') <> 'skipped')`);
  return { last24h: r.n, minutes24h: r.minutes, dailyCap: config.audioDailyCap, perRequest: config.audioMaxPerRequest, costPerMin: config.geminiCostPerMin, humeCostPerMin: config.humeCostPerMin };
}

export async function requestReviews(callRowIds, { useGemini = false, useHume = false, useClaude = false }) {
  if (!Array.isArray(callRowIds) || !callRowIds.length) throw httpErr(400, 'No calls selected.');
  if (useGemini && !geminiConfigured()) throw httpErr(400, 'GEMINI_API_KEY is not set.');
  if (useHume && !hume.humeConfigured()) throw httpErr(400, 'HUME_API_KEY is not set.');
  if (useClaude && !claudeConfigured()) throw httpErr(400, 'ANTHROPIC_API_KEY is not set.');
  if (!useGemini && !useHume && !useClaude) throw httpErr(400, 'Choose at least one reviewer.');
  if (useGemini || useHume) {
    if (callRowIds.length > config.audioMaxPerRequest) throw httpErr(400, `Audio reviews are limited to ${config.audioMaxPerRequest} calls per request.`);
    const u = await humeUsage();
    if (u.last24h + callRowIds.length > config.audioDailyCap) throw httpErr(429, `Daily audio-review cap reached: ${u.last24h}/${config.audioDailyCap} used in the last 24h.`);
  }
  const ids = [];
  for (const id of callRowIds) {
    const [r] = await q(`INSERT INTO reviews (call_row_id, status, hume_status, gemini_status) VALUES ($1, 'queued', $2, $3) RETURNING id`,
      [id, useHume ? 'queued' : 'skipped', useGemini ? 'queued' : 'skipped']);
    ids.push(r.id);
    reviewQueue.push(() => runReview(r.id, { useGemini, useHume, useClaude }));
  }
  return ids;
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function runReview(reviewId, { useGemini, useHume, useClaude }) {
  const [r] = await q('SELECT * FROM reviews WHERE id = $1', [reviewId]);
  const [c] = await q('SELECT * FROM calls WHERE id = $1', [r.call_row_id]);
  const acct = accountById(c.account_id);
  const turns = normalizeTranscript({ transcripts: c.transcript, started_at: c.started_at?.toISOString(), created_at: c.created_at?.toISOString() });
  const callMeta = { call_id: c.call_id, account: c.account_name, pathway_id: c.pathway_id, duration_sec: c.duration_sec, inbound: c.inbound, bland_summary: c.summary, variables: c.variables };
  await q(`UPDATE reviews SET status = 'running' WHERE id = $1`, [reviewId]);

  let rec = null;
  const getRec = async () => {
    if (!rec) {
      rec = await downloadRecording(acct, { call_id: c.call_id, recording_url: c.recording_url });
      const mins = await audioMinutes(rec.buf).catch(() => null);
      if (mins) await q(`UPDATE reviews SET audio_minutes = $2 WHERE id = $1`, [reviewId, mins]);
    }
    return rec;
  };

  if (useGemini) {
    try {
      await q(`UPDATE reviews SET gemini_status = 'listening' WHERE id = $1`, [reviewId]);
      const r0 = await getRec();
      const small = r0.buf.length < 14 * 1024 * 1024 && /mpeg|mp3|wav|ogg|flac|aac|m4a|webm/i.test(r0.type || '');
      const audio = small ? r0.buf : await compactMp3(r0.buf);
      const mime = small ? (/wav/i.test(r0.type) ? 'audio/wav' : /ogg/i.test(r0.type) ? 'audio/ogg' : 'audio/mp3') : 'audio/mp3';
      const review = await geminiReview({ audio, mime, turns, triage: c.triage, callMeta, channels: c.triage?.audio?.channels });
      await q(`UPDATE reviews SET gemini = $2, gemini_status = 'done', overall_score = $3 WHERE id = $1`, [reviewId, JSON.stringify(review), review.overall_score ?? null]);
    } catch (e) {
      await q(`UPDATE reviews SET gemini_status = 'error', gemini_error = $2 WHERE id = $1`, [reviewId, e.message]);
    }
  }

  let humeSummary = r.hume || null;
  if (useHume) {
    try {
      let jobId = r.hume_job_id;
      if (!jobId) {
        jobId = await hume.startJob(await getRec(), `${c.call_id}.mp3`);
        await q(`UPDATE reviews SET hume_job_id = $2, hume_status = 'submitted' WHERE id = $1`, [reviewId, jobId]);
      }
      await hume.waitForJob(jobId, { onStatus: (s) => q(`UPDATE reviews SET hume_status = $2 WHERE id = $1`, [reviewId, s]).catch(() => {}) });
      humeSummary = hume.summarizeHume(await hume.getPredictions(jobId), turns);
      await q(`UPDATE reviews SET hume = $2, hume_status = 'done' WHERE id = $1`, [reviewId, JSON.stringify(humeSummary)]);
    } catch (e) {
      await q(`UPDATE reviews SET hume_status = 'error', hume_error = $2 WHERE id = $1`, [reviewId, e.message]);
    }
  }

  if (useClaude) {
    try {
      const review = await claudeReview({ turns, triage: c.triage, hume: humeSummary, callMeta });
      await q(`UPDATE reviews SET claude = $2, overall_score = coalesce(overall_score, $3) WHERE id = $1`, [reviewId, JSON.stringify(review), review.overall_score ?? null]);
    } catch (e) {
      await q(`UPDATE reviews SET claude_error = $2 WHERE id = $1`, [reviewId, e.message]);
    }
  }
  await q(`UPDATE reviews SET status = 'done', finished_at = now() WHERE id = $1`, [reviewId]);
}

// ---------- resume after restart ----------
export async function resumeOnBoot() {
  await q(`UPDATE batches SET status = 'error', error = 'Interrupted by a server restart while sampling. Start a new batch.' WHERE status IN ('queued','sampling')`);
  for (const b of await q(`SELECT id FROM batches WHERE status = 'triaging'`)) batchQueue.push(() => triageBatch(b.id));
  const pending = (s) => s && !['skipped', 'done', 'error'].includes(s);
  for (const r of await q(`SELECT id, hume_status, gemini_status, claude FROM reviews WHERE status IN ('queued','running')`)) {
    reviewQueue.push(() => runReview(r.id, { useGemini: pending(r.gemini_status), useHume: pending(r.hume_status), useClaude: false }));
  }
}
