import crypto from 'node:crypto';
import { config } from './config.js';

function headers(acct) {
  const h = { authorization: acct.key, accept: 'application/json' };
  if (acct.encryptedKey) h.encrypted_key = acct.encryptedKey;
  return h;
}

async function blandGet(acct, path, params = {}) {
  const url = new URL(config.blandBase + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: headers(acct) });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`Bland ${path} ${res.status}: ${body.slice(0, 300)}`);
    try { return JSON.parse(body); } catch { return body; }
  }
  throw new Error(`Bland ${path}: gave up after retries`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** List pathways for an account. Bland has exposed this at /pathway and /all_pathway. */
export async function listPathways(acct) {
  for (const path of ['/pathway', '/all_pathway']) {
    try {
      const data = await blandGet(acct, path);
      const arr = Array.isArray(data) ? data : data?.pathways || data?.data || [];
      if (Array.isArray(arr) && arr.length) {
        return arr
          .map((p) => ({ id: p.id || p.pathway_id, name: p.name || p.pathway_name || '(unnamed)', description: p.description || '' }))
          .filter((p) => p.id);
      }
    } catch (e) {
      // try next shape
    }
  }
  return [];
}

/** Pull call metadata (no transcripts) for a date window, up to config.blandPoolMax. */
export async function listCallPool(acct, { startDate, endDate, minSeconds }) {
  const pool = [];
  const pageSize = 1000;
  for (let from = 0; from < config.blandPoolMax; from += pageSize) {
    const data = await blandGet(acct, '/calls', {
      limit: pageSize,
      from,
      to: from + pageSize,
      start_date: startDate,
      end_date: endDate,
      completed: true,
    });
    const calls = data?.calls || [];
    for (const c of calls) {
      const secs = Number(c.corrected_duration) || Number(c.call_length || 0) * 60;
      if (secs < minSeconds) continue;
      if (c.answered_by && /voicemail|no-answer|machine/i.test(c.answered_by)) continue;
      pool.push({ ...c, _account: acct });
    }
    if (calls.length < pageSize) break;
  }
  return pool;
}

export async function getCall(acct, callId) {
  return blandGet(acct, `/calls/${encodeURIComponent(callId)}`);
}

/** Download the recording audio. Tries recording_url first, then the /recording endpoint. */
export async function downloadRecording(acct, call) {
  const tries = [];
  if (call.recording_url) tries.push({ url: call.recording_url, h: {} });
  tries.push({ url: `${config.blandBase}/calls/${encodeURIComponent(call.call_id)}/recording`, h: headers(acct) });
  let lastErr;
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: t.h, redirect: 'follow' });
      if (!res.ok) { lastErr = new Error(`recording ${res.status}`); continue; }
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        const j = await res.json();
        const u = j?.url || j?.recording_url || j?.data?.url;
        if (u) {
          const r2 = await fetch(u);
          if (r2.ok) return { buf: Buffer.from(await r2.arrayBuffer()), type: r2.headers.get('content-type') || 'audio/mpeg' };
        }
        lastErr = new Error('recording endpoint returned JSON without a URL');
        continue;
      }
      return { buf: Buffer.from(await res.arrayBuffer()), type: type || 'audio/mpeg' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no recording available');
}

/**
 * Randomly sample N calls. If pathwayId is set, calls are checked against it
 * (from list metadata when Bland includes it, else from call details) until N match.
 */
export async function sampleCalls(accounts, { n, pathwayId, startDate, endDate, minSeconds, onProgress }) {
  let pool = [];
  for (const acct of accounts) {
    onProgress?.({ stage: `Listing calls: ${acct.name}` });
    const p = await listCallPool(acct, { startDate, endDate, minSeconds });
    pool = pool.concat(p);
  }
  onProgress?.({ stage: 'Shuffling', pool: pool.length });
  pool = shuffle(pool);

  if (pathwayId && pool.some((c) => c.pathway_id)) {
    pool = pool.filter((c) => c.pathway_id === pathwayId);
  }

  const picked = [];
  const budget = pathwayId ? Math.min(pool.length, Math.max(n * 25, 200)) : Math.min(pool.length, n * 2);
  let checked = 0;
  let idx = 0;
  const conc = 6;

  async function worker() {
    while (picked.length < n && idx < budget) {
      const c = pool[idx++];
      try {
        const d = await getCall(c._account, c.call_id);
        checked++;
        if (pathwayId && d.pathway_id !== pathwayId) continue;
        if (!Array.isArray(d.transcripts) || d.transcripts.length < 2) continue;
        if (picked.length < n) picked.push({ ...d, _account: c._account });
      } catch (e) {
        checked++;
      }
      if (checked % 10 === 0) onProgress?.({ stage: 'Fetching call details', checked, picked: picked.length, pool: pool.length });
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  onProgress?.({ stage: 'Sampled', checked, picked: picked.length, pool: pool.length });
  return { picked, poolSize: pool.length, checked };
}
