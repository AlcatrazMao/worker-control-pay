/**
 * PAGEZONE GATEWAY WORKER
 * - Rate Limiting
 * - R2 Image Storage
 * - Stats & Usage Tracking
 * - API Routing
 */

export interface Env {
  ASSETS: R2Bucket;
  RATE_LIMIT: KVNamespace;
  STATS: KVNamespace;
}

const RATE_LIMIT_DAILY = 1000; // Max requests por IP por día
const RATE_LIMIT_BURST = 50;   // Max requests por IP por minuto

interface RequestLog {
  timestamp: number;
  ip: string;
  path: string;
  method: string;
  status: number;
}

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const now = Date.now();
  const minuteKey = `rl:${ip}:${Math.floor(now / 60000)}`;
  const dailyKey = `rl:${ip}:${new Date().toISOString().split('T')[0]}`;

  // Check burst limit (por minuto)
  const burstCount = await env.RATE_LIMIT.get(minuteKey);
  if (burstCount && parseInt(burstCount) >= RATE_LIMIT_BURST) {
    return false;
  }

  // Check daily limit
  const dailyCount = await env.RATE_LIMIT.get(dailyKey);
  if (dailyCount && parseInt(dailyCount) >= RATE_LIMIT_DAILY) {
    return false;
  }

  // Increment counts
  const minuteNew = (parseInt(burstCount || '0') + 1).toString();
  const dailyNew = (parseInt(dailyCount || '0') + 1).toString();

  await env.RATE_LIMIT.put(minuteKey, minuteNew, { expirationTtl: 120 }); // 2 min TTL
  await env.RATE_LIMIT.put(dailyKey, dailyNew, { expirationTtl: 86400 });  // 24h TTL

  return true;
}

async function logRequest(env: Env, log: RequestLog) {
  const key = `log:${log.ip}:${Date.now()}`;
  await env.STATS.put(key, JSON.stringify(log), { expirationTtl: 604800 }); // 7 días
}

async function incrementStat(env: Env, endpoint: string) {
  const today = new Date().toISOString().split('T')[0];
  const key = `stat:${endpoint}:${today}`;
  const current = await env.STATS.get(key);
  const count = current ? parseInt(current) + 1 : 1;
  await env.STATS.put(key, count.toString(), { expirationTtl: 604800 });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ============ API HANDLERS ============

// POST /api/pages - Guardar página
async function handleSavePage(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { slug, data } = body;

    if (!slug || !data) {
      return new Response(JSON.stringify({ error: 'Missing slug or data' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // Sanitize slug - solo allow alphanumeric y guiones
    const sanitizedSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Guardar en R2 como JSON
    await env.ASSETS.put(`pages/${sanitizedSlug}.json`, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' }
    });

    await incrementStat(env, 'pages:save');

    return new Response(JSON.stringify({ success: true, slug: sanitizedSlug }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// GET /api/pages/:slug - Obtener página
async function handleGetPage(slug: string, env: Env): Promise<Response> {
  const key = `pages/${slug.toLowerCase()}.json`;
  const obj = await env.ASSETS.get(key);

  if (!obj) {
    return new Response(JSON.stringify({ error: 'Page not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  await incrementStat(env, 'pages:get');
  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// POST /api/images - Subir imagen a R2
async function handleUploadImage(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || 'image/png';

  // Solo permitir imágenes
  if (!contentType.startsWith('image/')) {
    return new Response(JSON.stringify({ error: 'Only images allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const buffer = await request.arrayBuffer();
  const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  await env.ASSETS.put(`images/${filename}`, buffer, {
    httpMetadata: { contentType }
  });

  await incrementStat(env, 'images:upload');

  return new Response(JSON.stringify({
    url: `/images/${filename}`,
    filename
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// GET /images/:filename - Servir imagen desde R2
async function handleGetImage(filename: string, env: Env): Promise<Response> {
  const obj = await env.ASSETS.get(`images/${filename}`);

  if (!obj) {
    return new Response('Not found', { status: 404 });
  }

  await incrementStat(env, 'images:get');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000', // 1 año cache
    }
  });
}

// GET /api/stats - Ver stats de uso
async function handleGetStats(env: Env): Promise<Response> {
  const today = new Date().toISOString().split('T')[0];

  const pagesSave = await env.STATS.get(`stat:pages:save:${today}`);
  const pagesGet = await env.STATS.get(`stat:pages:get:${today}`);
  const imagesUpload = await env.STATS.get(`stat:images:upload:${today}`);
  const imagesGet = await env.STATS.get(`stat:images:get:${today}`);

  return new Response(JSON.stringify({
    date: today,
    pages: {
      saved: parseInt(pagesSave || '0'),
      viewed: parseInt(pagesGet || '0')
    },
    images: {
      uploaded: parseInt(imagesUpload || '0'),
      viewed: parseInt(imagesGet || '0')
    }
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// GET /api/health - Health check
function handleHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ============ MAIN HANDLER ============

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Rate limiting
    if (path !== '/api/health') {
      const allowed = await checkRateLimit(env, ip);
      if (!allowed) {
        return new Response(JSON.stringify({
          error: 'Rate limit exceeded',
          message: 'Has exceeded the daily request limit'
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    // Log request
    await logRequest(env, {
      timestamp: Date.now(),
      ip,
      path,
      method: request.method,
      status: 0 // se actualiza después
    });

    // Router
    try {
      let response: Response;

      if (path === '/api/health') {
        response = handleHealth();
      }
      else if (path === '/api/stats') {
        response = await handleGetStats(env);
      }
      else if (path === '/api/pages' && request.method === 'POST') {
        response = await handleSavePage(request, env);
      }
      else if (path.startsWith('/api/pages/') && request.method === 'GET') {
        const slug = path.replace('/api/pages/', '');
        response = await handleGetPage(slug, env);
      }
      else if (path === '/api/images' && request.method === 'POST') {
        response = await handleUploadImage(request, env);
      }
      else if (path.startsWith('/images/')) {
        const filename = path.replace('/images/', '');
        response = await handleGetImage(filename, env);
      }
      else {
        response = new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // Update log with status
      await logRequest(env, {
        timestamp: Date.now(),
        ip,
        path,
        method: request.method,
        status: response.status
      });

      return response;

    } catch (e) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
} satisfies ExportedHandler<Env>;