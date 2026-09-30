import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(1082, (v) => v); // keep DATE as 'YYYY-MM-DD'

const ssl = config.databaseUrl && !/localhost|127\.0\.0\.1|\.internal|dpg-[a-z0-9]+-a(\/|:|$)/.test(config.databaseUrl)
  ? { rejectUnauthorized: false }
  : false;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 10 });

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS batches (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      label         TEXT,
      account_ids   TEXT[] NOT NULL,
      pathway_id    TEXT,
      pathway_name  TEXT,
      sample_size   INT NOT NULL,
      start_date    DATE,
      end_date      DATE,
      min_seconds   INT NOT NULL DEFAULT 30,
      audio_timing  BOOLEAN NOT NULL DEFAULT true,
      status        TEXT NOT NULL DEFAULT 'queued',
      progress      JSONB NOT NULL DEFAULT '{}'::jsonb,
      error         TEXT,
      summary       JSONB
    );

    CREATE TABLE IF NOT EXISTS calls (
      id              SERIAL PRIMARY KEY,
      batch_id        INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      account_id      TEXT NOT NULL,
      account_name    TEXT,
      call_id         TEXT NOT NULL,
      pathway_id      TEXT,
      created_at      TIMESTAMPTZ,
      started_at      TIMESTAMPTZ,
      duration_sec    REAL,
      from_number     TEXT,
      to_number       TEXT,
      inbound         BOOLEAN,
      recording_url   TEXT,
      summary         TEXT,
      transcript      JSONB,
      variables       JSONB,
      triage          JSONB,
      triage_score    REAL,
      triage_status   TEXT NOT NULL DEFAULT 'pending',
      triage_error    TEXT,
      UNIQUE (batch_id, account_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS calls_batch_idx ON calls(batch_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id            SERIAL PRIMARY KEY,
      call_row_id   INT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at   TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'queued',
      hume_job_id   TEXT,
      hume_status   TEXT,
      hume          JSONB,
      hume_error    TEXT,
      claude        JSONB,
      claude_error  TEXT,
      overall_score REAL,
      audio_minutes REAL
    );
    CREATE INDEX IF NOT EXISTS reviews_call_idx ON reviews(call_row_id);
    CREATE INDEX IF NOT EXISTS reviews_requested_idx ON reviews(requested_at);
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS gemini JSONB;
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS gemini_status TEXT;
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS gemini_error TEXT;
  `);
}
