const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (t) => (t == null ? '' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`);
const fmtDur = (s) => (s ? fmtT(s) : '');

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

let state = { status: null, size: 50, batchId: null, selected: new Set(), calls: [], poll: null };

// ---------- status ----------
async function loadStatus() {
  const s = await api('/api/status');
  state.status = s;
  const u = s.usage;
  $('#status').innerHTML = `
    <span class="chip ${s.accounts.length ? 'ok' : 'no'}">Bland: ${s.accounts.length} account${s.accounts.length === 1 ? '' : 's'}</span>
    <span class="chip ${s.gemini ? 'ok' : 'no'}" title="${esc(s.geminiModel)}">Gemini audio ${s.gemini ? 'on' : 'not set'}</span>
    <span class="chip ${s.claude ? 'ok' : ''}">Claude ${s.claude ? 'on' : 'off'}</span>
    ${s.hume ? '<span class="chip">Hume key set</span>' : ''}
    <span class="chip" title="Audio reviews requested in the last 24 hours">Audio reviews today: ${u.last24h}/${u.dailyCap} · ~$${(u.minutes24h * u.costPerMin).toFixed(2)}</span>
    <button id="testGemini" class="small">Test Gemini key</button>`;
  $('#testGemini').onclick = async () => {
    const b = $('#testGemini'); b.disabled = true; b.textContent = 'Testing…';
    try { const r = await api('/api/gemini/test'); alertBox(r.ok ? 'Gemini key works' : 'Gemini key problem', r.message + (r.detail ? `\n\n${r.detail}` : '')); }
    catch (e) { alertBox('Gemini test failed', e.message); }
    b.disabled = false; b.textContent = 'Test Gemini key';
  };

  const sel = $('#accountSel');
  sel.innerHTML = (s.accounts.length > 1 ? '<option value="all">All accounts</option>' : '') + s.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#sizeSeg').innerHTML = s.sampleSizes.map((n) => `<button type="button" data-n="${n}" class="${n === state.size ? 'on' : ''}">${n}</button>`).join('');
  $('#sizeSeg').onclick = (e) => { const n = e.target.dataset.n; if (!n) return; state.size = Number(n); [...$('#sizeSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.n === n)); };
  loadPathways();
}

async function loadPathways() {
  const acc = $('#accountSel').value || 'all';
  const sel = $('#pathwaySel');
  sel.innerHTML = '<option value="">Loading pathways…</option>';
  try {
    const ps = await api(`/api/pathways?account=${encodeURIComponent(acc)}`);
    const multi = new Set(ps.map((p) => p.accountId)).size > 1;
    sel.innerHTML = '<option value="">All pathways</option>' + ps.map((p) => `<option value="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}${multi ? ` · ${esc(p.accountName)}` : ''}</option>`).join('');
  } catch { sel.innerHTML = '<option value="">All pathways</option>'; }
}
$('#accountSel').addEventListener('change', loadPathways);

// ---------- new batch ----------
(function initDates() {
  const f = $('#sampleForm');
  const end = new Date(); const start = new Date(Date.now() - 7 * 864e5);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  f.endDate.value = ymd(end); f.startDate.value = ymd(start);
})();

$('#sampleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const manual = f.pathwayManual.value.trim();
  const opt = $('#pathwaySel').selectedOptions[0];
  const body = {
    accountId: f.accountId.value || 'all',
    pathwayId: manual || f.pathwayId.value || null,
    pathwayName: manual ? null : opt?.dataset.name || null,
    sampleSize: state.size,
    startDate: f.startDate.value || null,
    endDate: f.endDate.value || null,
    minSeconds: Number(f.minSeconds.value) || 0,
    audioTiming: f.audioTiming.checked,
    label: f.label.value.trim() || null,
  };
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  try { const r = await api('/api/batches', { method: 'POST', body }); await loadBatches(); openBatch(r.id); }
  catch (err) { alertBox('Could not start sample', err.message); }
  btn.disabled = false;
});

// ---------- batches ----------
async function loadBatches() {
  const bs = await api('/api/batches');
  $('#batches').innerHTML = bs.length ? bs.map((b) => `
    <div class="item ${b.id === state.batchId ? 'on' : ''}" data-id="${b.id}">
      <div><b>#${b.id}</b> ${esc(b.label || b.pathway_name || (b.pathway_id ? 'Pathway ' + b.pathway_id.slice(0, 8) : 'All pathways'))}</div>
      <div class="meta">${b.sample_size} calls · ${esc(b.status)} · ${new Date(b.created_at).toLocaleDateString()}${b.reviews ? ` · ${b.reviews} reviewed` : ''}${b.avg_review_score ? ` · avg ${b.avg_review_score.toFixed(1)}/10` : ''}</div>
    </div>`).join('') : '<p class="muted small">No batches yet.</p>';
  $('#batches').onclick = (e) => { const it = e.target.closest('.item'); if (it) openBatch(Number(it.dataset.id)); };
}

async function openBatch(id) {
  if (state.batchId !== id) state.selected.clear();
  state.batchId = id;
  clearTimeout(state.poll);
  [...document.querySelectorAll('#batches .item')].forEach((el) => el.classList.toggle('on', Number(el.dataset.id) === id));
  const { batch, calls } = await api(`/api/batches/${id}`);
  state.calls = calls;
  renderBatch(batch, calls);
  const busy = ['queued', 'sampling', 'triaging'].includes(batch.status) || calls.some((c) => ['queued', 'running'].includes(c.review_status));
  if (busy) state.poll = setTimeout(() => { if (state.batchId === id) openBatch(id); loadStatus(); }, 4000);
  if (!busy && batch.status === 'ready') loadBatches();
}

function riskClass(s) { return s >= 5 ? 'h' : s >= 2 ? 'm' : 'l'; }
function verdictPill(v) {
  if (!v) return '';
  const bad = ['significant', 'poor', 'yes', 'bad', 'clearly', 'no-goal'];
  const warn = ['minor', 'mixed', 'noticeable', 'mildly', 'partial'];
  return `<span class="pill ${bad.includes(v) ? 'bad' : warn.includes(v) ? 'warn' : 'good'}">${esc(v)}</span>`;
}

function renderBatch(b, calls) {
  const p = b.progress || {};
  const pct = p.total ? Math.round((100 * (p.done || 0)) / p.total) : b.status === 'ready' ? 100 : 5;
  const reviewed = calls.filter((c) => c.overall_score != null);
  const avg = reviewed.length ? (reviewed.reduce((s, c) => s + c.overall_score, 0) / reviewed.length).toFixed(1) : '–';
  const high = calls.filter((c) => c.triage_score >= 5).length;
  const flagged = calls.filter((c) => (c.flags || []).length).length;

  $('#content').innerHTML = `
    <div class="toolbar">
      <h2 class="grow">#${b.id} · ${esc(b.label || b.pathway_name || (b.pathway_id ? 'Pathway ' + b.pathway_id : 'All pathways'))} <span class="muted small">${esc(b.start_date || '')} → ${esc(b.end_date || '')}</span></h2>
      <a href="/api/batches/${b.id}/export.csv"><button>Export CSV</button></a>
    </div>
    ${b.status !== 'ready' ? `<div class="card"><b>${esc(b.status)}</b> · ${esc(p.stage || '')} ${p.checked ? `· checked ${p.checked}` : ''} ${p.pool ? `· pool ${p.pool}` : ''} ${p.total ? `· ${p.done || 0}/${p.total}` : ''}
      <div class="progress"><div style="width:${pct}%"></div></div>${b.error ? `<div class="err">${esc(b.error)}</div>` : ''}</div>` : ''}
    ${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}
    <div class="stats">
      <div class="stat"><div class="v">${calls.length}</div><div class="k">calls sampled</div></div>
      <div class="stat"><div class="v">${flagged}</div><div class="k">with any flag</div></div>
      <div class="stat"><div class="v">${high}</div><div class="k">high risk (≥5)</div></div>
      <div class="stat"><div class="v">${reviewed.length}</div><div class="k">deep reviewed</div></div>
      <div class="stat"><div class="v">${avg}</div><div class="k">avg review score /10</div></div>
    </div>
    <div class="toolbar">
      <button id="pickTop">Select top ${state.status?.usage.perRequest ?? 10} by risk</button>
      <button id="pickNone">Clear</button>
      <span class="grow muted" id="selInfo"></span>
      <button class="primary" id="reviewBtn">Deep review selected</button>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th></th><th>Risk</th><th>Flags (free checks)</th><th>Length</th><th>Account</th><th>Date</th><th>Review</th></tr></thead>
      <tbody>${calls.map((c) => `
        <tr class="clk" data-id="${c.id}">
          <td><input type="checkbox" data-sel="${c.id}" ${state.selected.has(c.id) ? 'checked' : ''} /></td>
          <td class="risk ${riskClass(c.triage_score || 0)}">${c.triage_status === 'pending' ? '…' : c.triage_score ?? '–'}</td>
          <td>${(c.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join('') || (c.triage_error ? `<span class="err small">${esc(c.triage_error)}</span>` : '<span class="muted small">none</span>')}</td>
          <td>${fmtDur(c.duration_sec)}</td>
          <td class="small">${esc(c.account_name)}</td>
          <td class="small">${c.created_at ? new Date(c.created_at).toLocaleString() : ''}</td>
          <td class="small">${c.review_status ? (c.review_status === 'done'
            ? `${c.overall_score != null ? `<b>${c.overall_score}/10</b> ` : ''}${verdictPill(c.annoyed ? (c.annoyed === 'no' ? '' : c.annoyed) : '')}${c.cut_off && c.cut_off !== 'none' ? ' ' + verdictPill(c.cut_off) : ''}<div class="muted">${esc((c.review_summary || '').slice(0, 90))}</div>`
            : `<span class="pill">${esc(c.review_status)}${c.gemini_status && c.gemini_status !== 'skipped' ? ' · gemini ' + esc(c.gemini_status) : ''}${c.hume_status && c.hume_status !== 'skipped' ? ' · hume ' + esc(c.hume_status) : ''}</span>`) : ''}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;

  const updateSel = () => { $('#selInfo').textContent = state.selected.size ? `${state.selected.size} selected` : ''; };
  updateSel();
  $('#content tbody').onclick = (e) => {
    const cb = e.target.closest('input[data-sel]');
    if (cb) { const id = Number(cb.dataset.sel); cb.checked ? state.selected.add(id) : state.selected.delete(id); updateSel(); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr) openCall(Number(tr.dataset.id));
  };
  $('#pickTop').onclick = () => { state.selected = new Set(calls.filter((c) => c.review_status !== 'done').slice(0, state.status?.usage.perRequest ?? 10).map((c) => c.id)); renderBatch(b, calls); };
  $('#pickNone').onclick = () => { state.selected.clear(); renderBatch(b, calls); };
  $('#reviewBtn').onclick = () => confirmReview();
}

// ---------- deep review ----------
function confirmReview() {
  const ids = [...state.selected];
  if (!ids.length) return alertBox('Nothing selected', 'Tick the calls you want reviewed, or use "Select top by risk".');
  const s = state.status;
  const mins = state.calls.filter((c) => state.selected.has(c.id)).reduce((m, c) => m + (c.duration_sec || 0) / 60, 0);
  const over = ids.length > s.usage.perRequest;
  const left = s.usage.dailyCap - s.usage.last24h;
  $('#confirmBody').innerHTML = `
    <p><b>${ids.length}</b> call${ids.length > 1 ? 's' : ''} · about <b>${mins.toFixed(1)} min</b> of audio.</p>
    <p>Estimated Gemini cost: <b>~$${(mins * s.usage.costPerMin).toFixed(2)}</b> <span class="muted small">(at ~$${s.usage.costPerMin}/min, set by GEMINI_COST_PER_MIN)</span></p>
    <p class="muted small">Limits: ${s.usage.perRequest} calls per request, ${left} of ${s.usage.dailyCap} left in the last 24h.</p>
    ${over ? `<p class="err">Audio reviews allow ${s.usage.perRequest} calls per request. Untick some.</p>` : ''}
    ${!s.gemini ? '<p class="err">GEMINI_API_KEY not set. Add it in Render to have AI listen to the audio.</p>' : ''}`;
  $('#useGemini').checked = s.gemini && !over; $('#useGemini').disabled = !s.gemini;
  $('#useClaude').checked = false; $('#useClaude').disabled = !s.claude;
  $('#humeRow').hidden = !s.hume; $('#useHume').checked = false;
  const dlg = $('#confirmDlg');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    try {
      await api('/api/reviews', { method: 'POST', body: { callRowIds: ids, useGemini: $('#useGemini').checked, useHume: $('#useHume').checked, useClaude: $('#useClaude').checked } });
      state.selected.clear();
      await loadStatus(); openBatch(state.batchId);
    } catch (e) { alertBox('Review not started', e.message); }
  };
}

// ---------- call drawer ----------
async function openCall(id) {
  const { call, reviews } = await api(`/api/calls/${id}`);
  const t0 = Date.parse(call.started_at || call.created_at || call.transcript?.[0]?.created_at);
  const turns = (call.transcript || []).filter((e) => e.user === 'user' || e.user === 'assistant').map((e) => ({ role: e.user === 'user' ? 'customer' : 'ai', text: e.text, t: (Date.parse(e.created_at) - t0) / 1000 }));
  const tr = call.triage || {};
  const markTimes = new Set([...(tr.possibleCutoffs || []), ...(tr.frustration || []), ...(tr.repeats || [])].map((m) => Math.round(m.t)));
  const r = reviews[0];
  const ge = r?.gemini, cl = r?.claude, hu = r?.hume;

  const moments = (arr) => (arr || []).length ? `<ul class="moments">${arr.map((m) => `<li>${m.t != null ? `<span class="ts" data-t="${m.t}">${fmtT(m.t)}</span> ` : ''}${m.quote ? `“${esc(m.quote)}” — ` : ''}${esc(m.note || m.text || '')}</li>`).join('')}</ul>` : '<p class="muted small">Nothing noted.</p>';
  const v = (title, o) => `<div class="verdict"><div class="t">${title}</div>${verdictPill(o?.verdict)}${o?.cause ? `<div class="small">${esc(o.cause)}</div>` : ''}${moments(o?.moments)}</div>`;

  $('#drawerBody').innerHTML = `
    <h3>Call ${esc(call.call_id)}</h3>
    <div class="muted small">${esc(call.account_name)} · ${call.pathway_id ? 'pathway ' + esc(call.pathway_id) + ' · ' : ''}${fmtDur(call.duration_sec)} · ${call.created_at ? new Date(call.created_at).toLocaleString() : ''}</div>
    <audio id="player" controls preload="none" src="/api/calls/${call.id}/audio"></audio>
    ${call.summary ? `<p class="small"><b>Bland summary:</b> ${esc(call.summary)}</p>` : ''}

    ${ge ? reviewBlock(`Gemini listened to the call · ${ge.overall_score}/10`, ge, v, moments) + geminiExtras(ge, call.duration_sec, moments) : ''}
    ${r?.gemini_error ? `<p class="err small">Gemini: ${esc(r.gemini_error)}</p>` : ''}
    ${cl ? reviewBlock(`Claude transcript review · ${cl.overall_score}/10`, cl, v, moments) : ''}
    ${r?.claude_error ? `<p class="err small">Claude: ${esc(r.claude_error)}</p>` : ''}

    ${hu ? `<div class="section"><h4>Hume: customer voice emotion</h4>
      <div class="small">Avg negative ${hu.customer.avgNegative ?? '–'} · confused ${hu.customer.avgConfused ?? '–'} · positive ${hu.customer.avgPositive ?? '–'} · trend ${hu.customer.negativeTrend > 0 ? '▲ getting worse' : hu.customer.negativeTrend < 0 ? '▼ improving' : '–'}</div>
      ${spark(hu.utterances.filter((u) => u.role === 'customer'), call.duration_sec)}
      <h4>Most negative moments</h4>${moments(hu.customer.peakNegative.map((u) => ({ t: u.t, quote: u.text, note: u.top.map((e) => `${e.name} ${e.score}`).join(', ') })))}
      ${hu.vocalBursts?.length ? `<h4>Vocal bursts (sighs, groans…)</h4>${moments(hu.vocalBursts.map((b) => ({ t: b.begin, note: [...(b.descriptions || []), ...b.top.map((e) => e.name)].join(', ') })))}` : ''}
    </div>` : ''}
    ${r?.hume_error ? `<p class="err small">Hume: ${esc(r.hume_error)}</p>` : ''}
    ${r && r.status !== 'done' ? `<p><span class="pill">Review ${esc(r.status)}${r.gemini_status && r.gemini_status !== 'skipped' ? ' · Gemini ' + esc(r.gemini_status) : ''}</span></p>` : ''}

    <div class="section"><h4>Free checks</h4>
      <div class="grid2">
        <div class="verdict"><div class="t">Possible cut-offs</div>${moments(tr.possibleCutoffs?.map((m) => ({ t: m.t, quote: m.text, note: `AI replied ${m.gap}s later` })))}</div>
        <div class="verdict"><div class="t">Slow AI replies</div>${moments(tr.slowReplies?.map((m) => ({ t: m.t, note: `${m.gap}s after “${m.after}”` })))}</div>
        <div class="verdict"><div class="t">Frustration phrases</div>${moments(tr.frustration?.map((m) => ({ t: m.t, quote: m.text })))}</div>
        <div class="verdict"><div class="t">Repeated questions</div>${moments(tr.repeats?.map((m) => ({ t: m.t, quote: m.text, note: `first asked at ${fmtT(m.firstAt)}` })))}</div>
        <div class="verdict"><div class="t">Dead air (audio)</div>${tr.audio ? moments(tr.audio.deadAir?.map((m) => ({ t: m.start, note: `${m.len}s of silence` }))) : `<p class="muted small">${esc(tr.audioError || 'Audio checks off')}</p>`}</div>
        <div class="verdict"><div class="t">AI talked over customer (audio)</div>${tr.audio?.aiTalkedOverCustomer ? moments(tr.audio.aiTalkedOverCustomer.map((m) => ({ t: m.start, note: `${m.len}s overlap` }))) : `<p class="muted small">${tr.audio ? 'Mono recording, so overlap cannot be measured here. A Gemini review listens for it.' : ''}</p>`}</div>
      </div>
    </div>

    <div class="section"><h4>Transcript</h4><div class="transcript">
      ${turns.map((t) => `<div class="turn ${t.role} ${markTimes.has(Math.round(t.t)) ? 'mark' : ''}"><span class="ts" data-t="${t.t}">${fmtT(t.t)}</span><span class="who">${t.role === 'ai' ? 'AI' : 'Customer'}</span><span>${esc(t.text)}</span></div>`).join('')}
    </div></div>
    <p><button id="reviewOne" class="primary">Deep review this call</button></p>`;

  $('#drawer').classList.remove('hidden');
  $('#drawerBody').onclick = (e) => {
    const ts = e.target.closest('.ts[data-t]');
    if (ts) { const p = $('#player'); p.currentTime = Math.max(0, Number(ts.dataset.t) - 1.5); p.play(); }
  };
  $('#reviewOne').onclick = () => { state.selected = new Set([call.id]); closeDrawer(); confirmReview(); };
}

function reviewBlock(title, rv, v, moments) {
  return `<div class="section"><h4>${title} · goal ${verdictPill(rv.goal_achieved)}</h4>
    <p>${esc(rv.one_line_summary)}</p><p class="small"><b>Outcome:</b> ${esc(rv.outcome)}${rv.customer_goal ? ` · <b>Customer wanted:</b> ${esc(rv.customer_goal)}` : ''}</p>
    <div class="grid2">
      ${v('Cut off / talked over customer', rv.cut_off_customer)}
      ${v('Understood context', rv.context_understanding)}
      ${v('Forgot earlier info', rv.forgot_earlier_info)}
      ${v('Pauses & latency', rv.pauses_and_latency)}
      ${v('Customer annoyed with AI', rv.customer_annoyed_with_ai)}
    </div>
    <div class="section"><h4>Missed or mishandled</h4>${moments(rv.missed_or_mishandled)}</div>
    <div class="section"><h4>Suggested fixes</h4><ul>${(rv.fix_suggestions || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    ${(rv.did_well || []).length ? `<div class="section"><h4>Did well</h4><ul>${rv.did_well.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

const NEG_TONES = /confus|impatien|annoy|frustrat|angr|upset|resign|irritat|exasperat|disappoint|skeptic/i;
function geminiExtras(ge, dur, moments) {
  const pts = (ge.emotion_timeline || []).filter((p) => p.speaker === 'customer').map((p) => ({
    t: p.t, end: p.t, negative: NEG_TONES.test(p.emotion) ? p.intensity : 0, positive: NEG_TONES.test(p.emotion) ? 0 : (/pleas|happy|satisf|relie|warm|calm/i.test(p.emotion) ? p.intensity : 0),
  }));
  return `<div class="section"><h4>What the customer sounded like</h4>
    <p class="small"><b>Start:</b> ${esc(ge.customer_tone_start || '–')} · <b>End:</b> ${esc(ge.customer_tone_end || '–')}</p>
    ${pts.length > 1 ? spark(pts, dur) : ''}
    ${moments((ge.emotion_timeline || []).map((p) => ({ t: p.t, note: `${p.speaker === 'ai' ? 'AI' : 'Customer'}: ${p.emotion} (${Math.round((p.intensity || 0) * 100)}%)${p.note ? ' — ' + p.note : ''}` })))}
    ${(ge.talk_over_events || []).length ? `<h4>Talk-over heard</h4>${moments(ge.talk_over_events.map((m) => ({ ...m, note: `${m.who_interrupted === 'ai' ? 'AI interrupted customer' : 'Customer interrupted AI'}: ${m.note}` })))}` : ''}
    ${(ge.ai_voice_issues || []).length ? `<h4>AI voice / delivery issues</h4>${moments(ge.ai_voice_issues)}` : ''}
  </div>`;
}

function spark(utts, dur) {
  if (!utts.length) return '';
  const W = 600, H = 90, max = Math.max(dur || 0, ...utts.map((u) => u.end || u.t || 0)) || 1;
  const pts = (k) => utts.map((u) => `${((u.t || 0) / max * W).toFixed(1)},${(H - 6 - u[k] * (H - 12)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Customer negative (red) and positive (green) emotion over the call">
    <line x1="0" x2="${W}" y1="${H - 6 - 0.3 * (H - 12)}" y2="${H - 6 - 0.3 * (H - 12)}" stroke="currentColor" stroke-opacity=".15" stroke-dasharray="4 4"/>
    <polyline fill="none" stroke="var(--good)" stroke-width="2" points="${pts('positive')}"/>
    <polyline fill="none" stroke="var(--bad)" stroke-width="2.5" points="${pts('negative')}"/>
  </svg><div class="muted small">Red = negative (annoyance, anger, disappointment…), green = positive. Dashed line = 0.3.</div>`;
}

function closeDrawer() { $('#drawer').classList.add('hidden'); const p = $('#player'); if (p) p.pause(); }
$('#drawerClose').onclick = closeDrawer;
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

function alertBox(title, msg) { window.alert(`${title}\n\n${msg}`); }

loadStatus().then(loadBatches).catch((e) => { $('#content').innerHTML = `<div class="empty err">${esc(e.message)}</div>`; });
