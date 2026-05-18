# Integración con Guardian KV

El worker `r2-guardian` escribe dos flags en un KV compartido. Cada worker debe leerlos al inicio de cada request y cortar si están activos.

## Flags

| Flag | Se activa cuando | Lo deben leer |
|---|---|---|
| `workers_freno` | Requests de Workers superan el 90% del límite diario (100k) | Todos los workers HTTP |
| `r2_freno` | Storage u ops de R2 superan el 90% del límite mensual | Solo workers que accedan a R2 |

## 1. Agregar el binding en `wrangler.toml`

```toml
[[kv_namespaces]]
binding = "GUARDIAN_KV"
id      = "36c2ec8740c442b88e31ef8f42d728f6"
```

## 2. Declarar el binding en la interfaz (TypeScript)

```ts
export interface Env {
  GUARDIAN_KV: KVNamespace;
  // ... resto de tus bindings
}
```

## 3. Leer el flag al inicio del fetch

**Worker HTTP genérico** — leer `workers_freno`:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (await env.GUARDIAN_KV.get('workers_freno') === 'true') {
      return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ... lógica normal del worker
  }
};
```

**Worker que accede a R2** — leer `r2_freno`:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (await env.GUARDIAN_KV.get('r2_freno') === 'true') {
      return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ... lógica normal del worker
  }
};
```

**JavaScript plano** (sin TypeScript):

```js
export default {
  async fetch(request, env) {
    if (await env.GUARDIAN_KV.get('workers_freno') === 'true') {
      return new Response('Service temporarily unavailable', { status: 503 });
    }

    // ... lógica normal del worker
  }
};
```

## Reglas

- El chequeo va **antes de cualquier otra lógica** — no procesar nada si el freno está activo.
- No cachear el valor del KV en memoria — leerlo en cada request para que el freno sea instantáneo.
- El guardian reactiva los flags automáticamente cuando el uso baja del 50%. No hace falta lógica de recuperación en el worker.
