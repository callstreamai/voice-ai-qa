import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, allowedSampleSizes } from './config.js';
import { q, migrate } from './db.js';
import { listPathways, downloadRecording } from './bland.js';
import { testHumeKey, humeConfigured } from './hume.js';
import { claudeConfigured } from './claude.js';
import { testGeminiKey, geminiConfigured } from './gemini.js';
import { enqueueBatch, requestReviews, humeUsage, resumeOnBoot } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.send('ok'));

// Password gate: recordings contain customer PII, so the app never runs open.
app.use((req, res, next) => {
  if (!config.appPassword) return res.status(503).send('Set the APP_PASSWORD environment variable in Render to use this app.');
  const hdr = req.headers.authorization || '';
  const [, b64] = hdr.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(config.appPassword);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Call QA"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || String(e) });
});

app.get('/api/status', wrap(async (_req, res) => {
  res.json({
    accounts: config.blandAccounts.map((a) => ({ id: a.id, name: a.name })),
    hume: humeConfigured(),
    gemini: geminiConfigured(),
    geminiModel: config.geminiModel,
    claude: claudeConfigured(),
    claudeModel: config.anthropicModel,
    sampleSizes: allowedSampleSizes,
    usage: await humeUsage(),
  });
}));

app.get('/api/hume/test', wrap(async (_req, res) => res.json(await testHumeKey())));
app.get('/api/gemini/test', wrap(async (_req, res) => res.json(await testGeminiKey())));

app.get('/api/pathways', wrap(async (req, res) => {
  const which = req.query.account || 'all';
  const accts = which === 'all' ? config.blandAccounts : config.blandAccounts.filter((a) => a.id === which);
  const out = [];
  for (const a of accts) {
    for (const p of await listPathways(a).catch(() => [])) out.push({ ...p, accountId: a.id, accountName: a.name });
  }
  res.json(out);
}));

app.post('/api/batches', wrap(async (req, res) => {
  const b = req.body || {};
  const size = Number(b.sampleSize);
  if (!allowedSampleSizes.includes(size)) return res.status(400).json({ error: `Sample size must be one of ${allowedSampleSizes.join(', ')}` });
  const ids = b.accountId === 'all' || !b.accountId ? config.blandAccounts.map((a) => a.id) : [String(b.accountId)];
  if (!ids.length || !ids.every((id) => config.blandAccounts.some((a) => a.id === id))) return res.status(400).json({ error: 'No Bland account configured (set BLAND_API_KEY or BLAND_ACCOUNTS).' });
  const [row] = await q(
    `INSERT INTO batches (label, account_ids, pathway_id, pathway_name, sample_size, start_date, end_date, min_seconds, audio_timing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.label || null, ids, b.pathwayId || null, b.pathwayName || null, size, b.startDate || null, b.endDate || null, Number(b.minSeconds) || 30, b.audioTiming !== false]
  );
  enqueueBatch(row.id);
  res.json({ id: row.id });
}));

app.get('/api/batches', wrap(async (_req, res) => {
  res.json(await q(`SELECT b.id, b.created_at, b.label, b.pathway_id, b.pathway_name, b.sample_size, b.status, b.progress, b.error, b.summary, b.account_ids, b.start_date, b.end_date,
    (SELECT count(*)::int FROM reviews r JOIN calls c ON c.id = r.call_row_id WHERE c.batch_id = b.id) AS reviews,
    (SELECT avg(r.overall_score)::real FROM reviews r JOIN calls c ON c.id = r.call_row_id WHERE c.batch_id = b.id) AS avg_review_score
    FROM batches b ORDER BY b.id DESC LIMIT 200`));
}));

app.get('/api/batches/:id', wrap(async (req, res) => {
  const [batch] = await q('SELECT * FROM batches WHERE id = $1', [req.params.id]);
  if (!batch) return res.status(404).json({ error: 'not found' });
  const calls = await q(`SELECT c.id, c.call_id, c.account_name, c.pathway_id, c.created_at, c.duration_sec, c.inbound, c.triage_score, c.triage_status, c.triage_error,
      c.triage->'flags' AS flags, c.summary,
      r.id AS review_id, r.status AS review_status, r.hume_status, r.gemini_status, r.overall_score,
      coalesce(r.gemini, r.claude)->>'one_line_summary' AS review_summary,
      coalesce(r.gemini, r.claude)->'customer_annoyed_with_ai'->>'verdict' AS annoyed, coalesce(r.gemini, r.claude)->'cut_off_customer'->>'verdict' AS cut_off,
      r.hume->'customer'->>'avgNegative' AS hume_neg
    FROM calls c LEFT JOIN LATERAL (SELECT * FROM reviews WHERE call_row_id = c.id ORDER BY id DESC LIMIT 1) r ON true
    WHERE c.batch_id = $1 ORDER BY c.triage_score DESC NULLS LAST, c.id`, [req.params.id]);
  res.json({ batch, calls });
}));

app.get('/api/calls/:id', wrap(async (req, res) => {
  const [call] = await q('SELECT * FROM calls WHERE id = $1', [req.params.id]);
  if (!call) return res.status(404).json({ error: 'not found' });
  const reviews = await q('SELECT * FROM reviews WHERE call_row_id = $1 ORDER BY id DESC', [req.params.id]);
  res.json({ call, reviews });
}));

app.get('/api/calls/:id/audio', wrap(async (req, res) => {
  const [c] = await q('SELECT account_id, call_id, recording_url FROM calls WHERE id = $1', [req.params.id]);
  if (!c) return res.status(404).end();
  const acct = config.blandAccounts.find((a) => a.id === c.account_id);
  const rec = await downloadRecording(acct, c);
  res.set('Content-Type', rec.type || 'audio/mpeg').set('Cache-Control', 'private, max-age=3600').send(rec.buf);
}));

app.post('/api/reviews', wrap(async (req, res) => {
  const { callRowIds, useGemini = false, useHume = false, useClaude = false } = req.body || {};
  const ids = await requestReviews((callRowIds || []).map(Number), { useGemini: !!useGemini, useHume: !!useHume, useClaude: !!useClaude });
  res.json({ reviewIds: ids, usage: await humeUsage() });
}));

app.get('/api/batches/:id/export.csv', wrap(async (req, res) => {
  const rows = await q(`SELECT c.call_id, c.account_name, c.pathway_id, c.created_at, round(c.duration_sec) AS duration_sec, c.triage_score,
      array_to_string(ARRAY(SELECT jsonb_array_elements_text(coalesce(c.triage->'flags','[]'::jsonb))), '; ') AS flags,
      r.overall_score, r.rv->>'goal_achieved' AS goal_achieved, r.rv->'cut_off_customer'->>'verdict' AS cut_off,
      r.rv->'context_understanding'->>'verdict' AS context, r.rv->'forgot_earlier_info'->>'verdict' AS forgot_info,
      r.rv->'pauses_and_latency'->>'verdict' AS pauses, r.rv->'customer_annoyed_with_ai'->>'verdict' AS annoyed,
      r.rv->>'customer_tone_start' AS tone_start, r.rv->>'customer_tone_end' AS tone_end,
      r.rv->>'one_line_summary' AS summary, CASE WHEN r.gemini IS NOT NULL THEN 'gemini (audio)' WHEN r.claude IS NOT NULL THEN 'claude (transcript)' END AS reviewed_by
    FROM calls c LEFT JOIN LATERAL (SELECT *, coalesce(gemini, claude) AS rv FROM reviews WHERE call_row_id = c.id ORDER BY id DESC LIMIT 1) r ON true
    WHERE c.batch_id = $1 ORDER BY c.triage_score DESC NULLS LAST`, [req.params.id]);
  const cols = rows.length ? Object.keys(rows[0]) : ['call_id'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k] instanceof Date ? r[k].toISOString() : r[k])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="batch-${req.params.id}.csv"`).send(csv);
}));

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  await migrate();
  await resumeOnBoot();
  app.listen(config.port, () => console.log(`Call QA listening on ${config.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
