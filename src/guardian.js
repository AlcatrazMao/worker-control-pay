const CF_API = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;

const FREE_WORKERS_DAILY    = 100_000;
const FREE_R2_STORAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const FREE_R2_OPS_MONTHLY   = 10_000_000;              // Class B ops

// ─── Retry con backoff exponencial ───────────────────────────────────────────

async function fetchRetry(url, init) {
  let lastErr = new Error('Max retries exceeded');

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }

  throw lastErr;
}

function cfHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ─── R2 storage y requests vía GraphQL Analytics ─────────────────────────────

async function getR2Metrics(env) {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const query = `
    query($accountTag: string, $startDate: DateTime!, $endDate: DateTime!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            filter: { datetime_geq: $startDate, datetime_leq: $endDate },
            limit: 1
          ) {
            sum {
              storageBytes
              requestCount
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchRetry(`${CF_API}/graphql`, {
      method: 'POST',
      headers: cfHeaders(env.CF_API_TOKEN),
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.ACCOUNT_ID,
          startDate: startDate.toISOString(),
          endDate: now.toISOString(),
        },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const groups = data?.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups;

    if (!groups || groups.length === 0) return { storageBytes: 0, requestCount: 0 };

    return {
      storageBytes: groups[0].sum.storageBytes ?? 0,
      requestCount: groups[0].sum.requestCount ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Worker invocations del día actual vía GraphQL ───────────────────────────

async function getWorkerRequests(env) {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const query = `
    query($accountTag: string, $since: DateTime!, $until: DateTime!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 10000
          ) {
            sum { requests }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchRetry(`${CF_API}/graphql`, {
      method: 'POST',
      headers: cfHeaders(env.CF_API_TOKEN),
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.ACCOUNT_ID,
          since: since.toISOString(),
          until: now.toISOString(),
        },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups;

    if (!groups || groups.length === 0) return 0;

    return groups.reduce((acc, g) => acc + (g.sum?.requests ?? 0), 0);
  } catch {
    return null;
  }
}

// ─── Notificaciones ───────────────────────────────────────────────────────────

async function notify(env, text, metrics) {
  if (!env.NOTIFICATION_WEBHOOK_URL) return;

  try {
    await fetch(env.NOTIFICATION_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: text,
        metrics,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // La falla de notificación nunca rompe la ejecución principal
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function calcPct(value, limit) {
  return Math.round((value / limit) * 10000) / 100;
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function checkAndGuard(env) {
  const umbral = parseInt(env.UMBRAL_FRENO ?? '90', 10);
  const umbralRecovery = 50;

  const [workerReqs, r2] = await Promise.all([getWorkerRequests(env), getR2Metrics(env)]);

  if (workerReqs === null && r2 === null) return;

  const reqCount     = workerReqs ?? 0;
  const storageBytes = r2?.storageBytes ?? 0;
  const opsCount     = r2?.requestCount ?? 0;

  const pctWorkers = calcPct(reqCount, FREE_WORKERS_DAILY);
  const pctStorage = calcPct(storageBytes, FREE_R2_STORAGE_BYTES);
  const pctOps     = calcPct(opsCount, FREE_R2_OPS_MONTHLY);

  const metrics = { pctWorkers, pctStorage, pctOps, reqCount, storageBytes, opsCount };

  // ── workers_freno: peticiones de Workers superan el límite diario ────────
  const frenoWorkers = (await env.GUARDIAN_KV.get('workers_freno')) === 'true';

  if (!frenoWorkers && pctWorkers > umbral) {
    await env.GUARDIAN_KV.put('workers_freno', 'true');
    await notify(env, `🚨 workers_freno ACTIVADO — Workers: ${pctWorkers}%`, metrics);
  } else if (frenoWorkers && pctWorkers < umbralRecovery) {
    await env.GUARDIAN_KV.delete('workers_freno');
    await notify(env, `✅ workers_freno desactivado — Workers: ${pctWorkers}%`, metrics);
  }

  // ── r2_freno: storage u ops de R2 superan el límite mensual ──────────────
  const frenoR2 = (await env.GUARDIAN_KV.get('r2_freno')) === 'true';
  const deberiaFrenarR2    = pctStorage > umbral || pctOps > umbral;
  const deberiaReactivarR2 = pctStorage < umbralRecovery && pctOps < umbralRecovery;

  if (!frenoR2 && deberiaFrenarR2) {
    await env.GUARDIAN_KV.put('r2_freno', 'true');
    await notify(env, `🚨 r2_freno ACTIVADO — Storage: ${pctStorage}%, Ops: ${pctOps}%`, metrics);
  } else if (frenoR2 && deberiaReactivarR2) {
    await env.GUARDIAN_KV.delete('r2_freno');
    await notify(env, `✅ r2_freno desactivado — Storage: ${pctStorage}%, Ops: ${pctOps}%`, metrics);
  }
}

async function forceReset(env) {
  await env.GUARDIAN_KV.delete('workers_freno');
  await env.GUARDIAN_KV.delete('r2_freno');
  const metrics = { pctWorkers: 0, pctStorage: 0, pctOps: 0, reqCount: 0, storageBytes: 0, opsCount: 0 };
  await notify(env, '🔄 Reset mensual: ambos frenos desactivados', metrics);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, _ctx) {
    if (event.cron === '0 0 1 * *') {
      await forceReset(env);
    } else {
      await checkAndGuard(env);
    }
  },
};
