# PageZone Gateway Worker

Worker de Cloudflare que maneja:
- Rate limiting (1000 requests/día por IP)
- CRUD de páginas (almacenado en R2)
- Upload de imágenes (R2)
- Stats y tracking de uso

## Setup

### 1. Secrets de GitHub Actions

Ir a **Settings → Secrets → Actions** y agregar:

| Secret | Descripción |
|--------|-------------|
| `CF_API_TOKEN` | API Token con permisos: Workers Edit, R2 Edit |
| `CF_ACCOUNT_ID` | `152595c1bd678c6eb1ccb2aa4b1e2643` |
| `R2_BUCKET_NAME` | Nombre del bucket R2 |

### 2. Deploy

```bash
# Local dev
npm run dev

# Deploy
npm run deploy
```

## API Endpoints

| Endpoint | Method | Descripción |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/stats` | GET | Stats de uso |
| `/api/pages` | POST | Guardar página |
| `/api/pages/:slug` | GET | Obtener página |
| `/api/images` | POST | Subir imagen |
| `/images/:filename` | GET | Ver imagen |

## Rate Limits

- **Daily**: 1000 requests por IP
- **Burst**: 50 requests por minuto por IP