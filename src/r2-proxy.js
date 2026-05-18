export default {
  async fetch(request, env) {
    const bloqueado = await env.GUARDIAN_KV.get('r2_freno');
    if (bloqueado === 'true') {
      return new Response('Service temporarily unavailable', { status: 503 });
    }

    return new Response('Not implemented', { status: 501 });
  },
};
