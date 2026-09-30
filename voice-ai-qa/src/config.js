// Central config, read from environment variables (set these in Render).
function num(name, def) {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

// Bland accounts: either BLAND_ACCOUNTS='[{"name":"Store A","key":"org_..."}, ...]'
// or a single BLAND_API_KEY.
function blandAccounts() {
  const raw = process.env.BLAND_ACCOUNTS;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .filter((a) => a && a.key)
          .map((a, i) => ({ id: String(i), name: a.name || `Account ${i + 1}`, key: a.key, encryptedKey: a.encrypted_key || null }));
      }
    } catch (e) {
      console.error('BLAND_ACCOUNTS is not valid JSON:', e.message);
    }
  }
  if (process.env.BLAND_API_KEY) {
    return [{ id: '0', name: process.env.BLAND_ACCOUNT_NAME || 'Main account', key: process.env.BLAND_API_KEY, encryptedKey: process.env.BLAND_ENCRYPTED_KEY || null }];
  }
  return [];
}

export const config = {
  port: num('PORT', 10000),
  databaseUrl: process.env.DATABASE_URL || '',
  appPassword: process.env.APP_PASSWORD || '',
  blandBase: process.env.BLAND_API_BASE || 'https://api.bland.ai/v1',
  blandAccounts: blandAccounts(),
  // Max calls pulled from Bland's list endpoint when building the random pool.
  blandPoolMax: num('BLAND_POOL_MAX', 10000),

  humeKey: process.env.HUME_API_KEY || '',
  humeBase: process.env.HUME_API_BASE || 'https://api.hume.ai/v0',
  humeMaxPerRequest: num('HUME_MAX_PER_REQUEST', 10),
  humeDailyCap: num('HUME_DAILY_CAP', 50),
  humeCostPerMin: num('HUME_COST_PER_MIN', 0.064),

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  anthropicBase: process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com',

  // Triage thresholds (seconds)
  deadAirSec: num('DEAD_AIR_SEC', 4),
  slowReplySec: num('SLOW_REPLY_SEC', 3),
};

export const allowedSampleSizes = [10, 50, 100, 250, 500];
