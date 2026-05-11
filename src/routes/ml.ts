// ============================================================
// ROUTES: Mercado Livre — OAuth2, Webhook, Bot de Importação
// APP ID: 3098423019766450
// Publisher ID (Afiliados): cfegdhabc31955
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'

type MLBindings = Bindings & {
  ML_APP_ID?: string
  ML_SECRET?: string
}

const ml = new Hono<{ Bindings: MLBindings }>()

const PUBLISHER_ID = 'cfegdhabc31955'
const ML_API       = 'https://api.mercadolibre.com'
const APP_ID       = '3098423019766450'

// Mapa de categorias ML → slug interno KainowRadar
const ML_CATEGORIES: Record<string, { mlId: string; slug: string; name: string }> = {
  smartphones:      { mlId: 'MLB1051', slug: 'smartphones',     name: 'Smartphones'      },
  notebooks:        { mlId: 'MLB1648', slug: 'notebooks',        name: 'Notebooks'         },
  tv:               { mlId: 'MLB1000', slug: 'tv',               name: 'TVs & Smart TVs'   },
  games:            { mlId: 'MLB1144', slug: 'games',            name: 'Games & Consoles'  },
  audio:            { mlId: 'MLB1003', slug: 'audio',            name: 'Áudio & Fones'     },
  cameras:          { mlId: 'MLB1008', slug: 'cameras',          name: 'Câmeras & Drones'  },
  eletrodomesticos: { mlId: 'MLB1574', slug: 'eletrodomesticos', name: 'Eletrodomésticos'  },
  tablets:          { mlId: 'MLB1009', slug: 'tablets',          name: 'Tablets & iPads'   },
  informatica:      { mlId: 'MLB1649', slug: 'informatica',      name: 'Informática'       },
  'moda-calcados':  { mlId: 'MLB1430', slug: 'moda-calcados',    name: 'Moda & Calçados'   },
}

// ── Helper: Gera slug ─────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 80)
}

// ── Helper: Pega token do KV (com auto-refresh) ───────────
async function getStoredToken(env: MLBindings): Promise<string | null> {
  if (!env.CACHE) return null
  try {
    const token = await env.CACHE.get('ml_access_token')
    if (token) return token

    // Tenta refresh se tiver refresh_token
    const refreshToken = await env.CACHE.get('ml_refresh_token')
    if (!refreshToken) return null

    const appId  = env.ML_APP_ID  || APP_ID
    const secret = env.ML_SECRET  || ''

    const res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     appId,
        client_secret: secret,
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    if (!data.access_token) return null

    // Salva novo token
    await env.CACHE.put('ml_access_token',  data.access_token,          { expirationTtl: data.expires_in || 21600 })
    await env.CACHE.put('ml_refresh_token', data.refresh_token || '',   { expirationTtl: 86400 * 30 })
    await env.CACHE.put('ml_user_id',       String(data.user_id || ''), { expirationTtl: 86400 * 30 })
    return data.access_token
  } catch {
    return null
  }
}

// ── Helper: Busca produtos por categoria ─────────────────
async function fetchMLProducts(categoryId: string, token: string, offset = 0, limit = 50): Promise<{ items: any[]; error?: string }> {
  try {
    const url = `${ML_API}/sites/MLB/search?category=${categoryId}&limit=${limit}&offset=${offset}&sort=relevance`
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'KainowRadar/1.0',
        'Accept':        'application/json',
      },
    })
    if (!res.ok) {
      const txt = await res.text()
      return { items: [], error: `API ${res.status}: ${txt.substring(0, 100)}` }
    }
    const data: any = await res.json()
    return { items: data.results || [] }
  } catch (e: any) {
    return { items: [], error: e.message }
  }
}

// ── Helper: Busca detalhes de item ────────────────────────
async function fetchMLItem(itemId: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${ML_API}/items/${itemId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'KainowRadar/1.0',
        'Accept':        'application/json',
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Helper: Salva produto no D1 ──────────────────────────
async function saveProductToDB(
  DB: D1Database,
  item: any,
  categorySlug: string,
): Promise<{ id: number | null; action: 'created' | 'updated' | 'skipped' }> {
  try {
    const mlId       = item.id
    const name       = (item.title || '').trim()
    if (!name || !mlId) return { id: null, action: 'skipped' }

    const brand      = item.attributes?.find((a: any) => a.id === 'BRAND')?.value_name || ''
    const ean        = item.attributes?.find((a: any) => a.id === 'GTIN')?.value_name  || ''
    const slug       = slugify(name)
    const price      = item.price || 0
    const image      = (item.thumbnail || '').replace('-I.jpg', '-O.jpg')
    const permalink  = item.permalink || ''
    const aff_url    = permalink ? `${permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow` : ''

    // Já existe pelo ml_item_id?
    const existing = await DB.prepare(
      'SELECT id FROM products WHERE ml_item_id = ?'
    ).bind(mlId).first<{ id: number }>()

    if (existing) {
      await DB.prepare(`
        UPDATE products
        SET best_price = ?, affiliate_url = ?,
            affiliate_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE ml_item_id = ?
      `).bind(price, aff_url, mlId).run()
      return { id: existing.id, action: 'updated' }
    }

    // Slug único?
    const slugExists = await DB.prepare(
      'SELECT id FROM products WHERE slug = ?'
    ).bind(slug).first<{ id: number }>()
    const finalSlug = slugExists ? `${slug}-${mlId.toLowerCase()}` : slug

    const result = await DB.prepare(`
      INSERT INTO products
        (ean, name, slug, brand, category, subcategory, description,
         image_url, best_price, offer_count, ml_item_id,
         affiliate_url, affiliate_updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, 1)
    `).bind(
      ean        || null,
      name,
      finalSlug,
      brand      || null,
      categorySlug,
      categorySlug,
      `${name}${brand ? ' — ' + brand : ''}. Encontrado no Mercado Livre.`,
      image      || null,
      price,
      mlId,
      aff_url,
    ).run()

    return { id: result.meta.last_row_id as number, action: 'created' }
  } catch (e: any) {
    console.error('saveProductToDB error:', e.message)
    return { id: null, action: 'skipped' }
  }
}

// ════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS (sem auth admin)
// ════════════════════════════════════════════════════════════

// ── Helpers PKCE ─────────────────────────────────────────
function base64urlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  // code_verifier: 64 bytes aleatórios → base64url (resultado ~86 chars, dentro do limite 43-128)
  const raw     = crypto.getRandomValues(new Uint8Array(64))
  const verifier = base64urlEncode(raw.buffer as ArrayBuffer)
  // code_challenge: SHA-256 do verifier → base64url
  const encoded  = new TextEncoder().encode(verifier)
  const digest   = await crypto.subtle.digest('SHA-256', encoded)
  const challenge = base64urlEncode(digest)
  return { verifier, challenge }
}

// ── GET /api/ml/auth — Inicia OAuth2 Authorization Code + PKCE ──
ml.get('/auth', async (c) => {
  const appId       = c.env.ML_APP_ID || APP_ID
  const redirectUri = 'https://kainowradar.com.br/api/ml-callback'

  // Gera PKCE
  const { verifier, challenge } = await generatePKCE()

  // Salva code_verifier no KV por 10 minutos (tempo máximo do code ML)
  if (c.env.CACHE) {
    await c.env.CACHE.put('ml_pkce_verifier', verifier, { expirationTtl: 600 })
  }

  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code` +
    `&client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`

  return c.redirect(url)
})

// ── GET /api/ml-callback (via ml.ts — não usado diretamente, ver index.tsx) ──
// Este handler existe como fallback; o handler principal está em index.tsx
ml.get('/callback', async (c) => {
  return c.html(`<h2>ℹ️ Use /api/ml-callback (sem /api/ml/)</h2>`)
})

// ── POST /api/ml-webhook — Notificações de preço/estoque ─
ml.post('/webhook', async (c) => {
  const body     = await c.req.json().catch(() => ({}))
  const { DB }   = c.env
  const topic    = (body as any).topic    || ''
  const resource = (body as any).resource || ''

  if (topic === 'items' && resource) {
    const itemId = resource.replace('/items/', '').split('?')[0]
    try {
      const token = await getStoredToken(c.env)
      if (token && itemId) {
        const item = await fetchMLItem(itemId, token)
        if (item) {
          const aff_url = `${item.permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow`
          await DB.prepare(`
            UPDATE products
            SET best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
            WHERE ml_item_id = ?
          `).bind(item.price, aff_url, itemId).run()
        }
      }
    } catch {}
  }

  return c.json({ ok: true })
})

// ════════════════════════════════════════════════════════════
// ROTAS ADMIN (passam pelo middleware de auth do admin.ts)
// ════════════════════════════════════════════════════════════

// ── GET /admin/api/ml/status ──────────────────────────────
ml.get('/status', async (c) => {
  const token  = await c.env.CACHE?.get('ml_access_token').catch(() => null)
  const userId = await c.env.CACHE?.get('ml_user_id').catch(() => null)
  const appId  = c.env.ML_APP_ID || APP_ID

  return c.json({
    connected:    !!token,
    user_id:      userId,
    app_id:       appId,
    publisher_id: PUBLISHER_ID,
    auth_url:     `https://kainowradar.com.br/api/ml/auth`,
    categories:   Object.keys(ML_CATEGORIES),
  })
})

// ── POST /admin/api/ml/import — Importa por categoria ────
ml.post('/import', async (c) => {
  const { DB } = c.env
  const body   = await c.req.json().catch(() => ({}))
  const category: string = (body as any).category || 'smartphones'
  const limit: number    = Math.min(Number((body as any).limit)  || 50, 50)
  const offset: number   = Number((body as any).offset) || 0

  // Resolve token
  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({
      error: 'Token do Mercado Livre não encontrado. Clique em "Conectar ao ML" para autorizar.',
      auth_url: `/api/ml/auth`,
    }, 401)
  }

  const categoriesToImport = category === 'all'
    ? Object.values(ML_CATEGORIES)
    : ML_CATEGORIES[category]
      ? [ML_CATEGORIES[category]]
      : null

  if (!categoriesToImport) {
    return c.json({ error: `Categoria inválida: ${category}` }, 400)
  }

  let totalCreated = 0
  let totalUpdated = 0
  let totalSkipped = 0
  const errors: string[] = []

  for (const cat of categoriesToImport) {
    const { items, error: fetchErr } = await fetchMLProducts(cat.mlId, token, offset, limit)

    if (fetchErr) {
      errors.push(`${cat.slug}: ${fetchErr}`)
      continue
    }
    if (!items.length) {
      errors.push(`${cat.slug}: nenhum resultado`)
      continue
    }

    for (const item of items) {
      const { action } = await saveProductToDB(DB, item, cat.slug)
      if      (action === 'created') totalCreated++
      else if (action === 'updated') totalUpdated++
      else                           totalSkipped++

      await new Promise(r => setTimeout(r, 40))
    }
  }

  return c.json({
    ok:      true,
    created: totalCreated,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors:  errors.slice(0, 5),
    message: `${totalCreated} criados, ${totalUpdated} atualizados, ${totalSkipped} ignorados`,
  })
})

// ── POST /admin/api/ml/import-item — Item por ID ─────────
ml.post('/import-item', async (c) => {
  const { ml_id } = await c.req.json().catch(() => ({})) as any
  if (!ml_id) return c.json({ error: 'ml_id obrigatório' }, 400)

  const { DB } = c.env
  const token  = await getStoredToken(c.env)
  if (!token) {
    return c.json({ error: 'Token ML não encontrado. Autorize primeiro em "Conectar ao ML".', auth_url: `/api/ml/auth` }, 401)
  }

  const item = await fetchMLItem(ml_id, token)
  if (!item) return c.json({ error: `Item ${ml_id} não encontrado` }, 404)

  const catSlug = Object.entries(ML_CATEGORIES)
    .find(([, v]) => (item.category_id || '').startsWith(v.mlId.substring(0, 6)))?.[0] || 'outros'

  const { id, action } = await saveProductToDB(DB, item, catSlug)

  return c.json({
    ok:          true,
    action,
    product_id:  id,
    ml_id:       item.id,
    name:        item.title,
    price:       item.price,
    affiliate_url: `${item.permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow`,
  })
})

export default ml
export { ML_CATEGORIES }
