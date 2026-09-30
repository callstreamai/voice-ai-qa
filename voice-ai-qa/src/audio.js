import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 5e6) err = err.slice(-2e6); });
    p.on('error', reject);
    p.on('close', () => resolve(err));
  });
}

async function withTemp(buf, fn) {
  const file = path.join(os.tmpdir(), `rec-${crypto.randomUUID()}`);
  await fs.writeFile(file, buf);
  try { return await fn(file); } finally { fs.unlink(file).catch(() => {}); }
}

function parseDuration(stderr) {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function parseChannels(stderr) {
  const m = stderr.match(/Audio:[^\n]*?,\s*\d+\s*Hz,\s*([^,\n]+)/);
  if (!m) return 1;
  const s = m[1].trim();
  if (s === 'mono') return 1;
  if (s === 'stereo') return 2;
  const n = s.match(/(\d+)\s*channels/);
  return n ? Number(n[1]) : 1;
}

/** Returns speech segments [{start,end}] by inverting ffmpeg silencedetect output. */
function speechFromSilence(stderr, duration) {
  const silences = [];
  let cur = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { cur = { start: Math.max(0, Number(s[1])) }; continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && cur) { cur.end = Number(e[1]); silences.push(cur); cur = null; }
  }
  if (cur) { cur.end = duration; silences.push(cur); }
  const speech = [];
  let t = 0;
  for (const s of silences) {
    if (s.start > t + 0.05) speech.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (duration && duration > t + 0.05) speech.push({ start: t, end: duration });
  return { speech, silences };
}

async function detect(file, filterPrefix, duration) {
  const af = `${filterPrefix}silencedetect=n=-38dB:d=0.35`;
  const stderr = await run(['-hide_banner', '-nostats', '-i', file, '-af', af, '-f', 'null', '-']);
  return speechFromSilence(stderr, duration);
}

function overlaps(a, b, minLen = 0.4) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].start, b[j].start);
    const e = Math.min(a[i].end, b[j].end);
    if (e - s >= minLen) {
      // who was already talking? The one whose segment started first got talked over.
      const interrupter = a[i].start > b[j].start ? 'ch0' : 'ch1';
      out.push({ start: +s.toFixed(2), end: +e.toFixed(2), len: +(e - s).toFixed(2), interrupter });
    }
    if (a[i].end < b[j].end) i++; else j++;
  }
  return out;
}

/**
 * Free audio timing analysis.
 * - deadAir: gaps where nobody is speaking longer than deadAirSec
 * - if the recording is stereo (one party per channel), overlaps = talk-over events
 */
export async function analyzeAudio(buf, { deadAirSec = 4 } = {}) {
  return withTemp(buf, async (file) => {
    const probe = await run(['-hide_banner', '-i', file]);
    const duration = parseDuration(probe);
    const channels = parseChannels(probe);

    const mixed = await detect(file, channels > 1 ? 'pan=mono|c0=0.5*c0+0.5*c1,' : '', duration);
    const deadAir = mixed.silences
      .filter((s) => s.end - s.start >= deadAirSec && s.start > 1 && (!duration || s.end < duration - 1))
      .map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), len: +(s.end - s.start).toFixed(2) }));

    const result = { duration, channels, deadAir, talkOver: null, speechRatio: null };
    const talkTime = mixed.speech.reduce((t, s) => t + (s.end - s.start), 0);
    if (duration) result.speechRatio = +(talkTime / duration).toFixed(3);

    if (channels === 2) {
      const c0 = await detect(file, 'pan=mono|c0=c0,', duration);
      const c1 = await detect(file, 'pan=mono|c0=c1,', duration);
      result.talkOver = overlaps(c0.speech, c1.speech);
      result.channelTalk = {
        ch0: +c0.speech.reduce((t, s) => t + s.end - s.start, 0).toFixed(1),
        ch1: +c1.speech.reduce((t, s) => t + s.end - s.start, 0).toFixed(1),
      };
    }
    return result;
  });
}

export async function audioMinutes(buf) {
  return withTemp(buf, async (file) => {
    const d = parseDuration(await run(['-hide_banner', '-i', file]));
    return d ? d / 60 : null;
  });
}
