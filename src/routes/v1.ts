// ============================================================
// ROUTES: API Pública v1 — autenticada por X-API-Key
// Base: /api/v1/
//
// Autenticação:
//   Header:  X-API-Key: kr_live_xxxxxxxxxxxxxxxx
//   Query:   ?api_key=kr_live_xxxxxxxxxxxxxxxx
//
// Endpoints:
//   GET /api/v1/status          — verifica autenticação e quota
//   GET /api/v1/products        — lista produtos com filtros
//   GET /api/v1/products/:id    — produto único com ofertas
//   GET /api/v1/search          — busca por nome/marca/EAN
//   GET /api/v1/categories      — lista categorias
//   GET /api/v1/deals           — melhores ofertas (maior desconto)
//   GET /api/v1/price/:ml_id    — preço atual de um item ML
// ============================================================

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bindings } from '../types'

type V1Bindings = Bindings & {
  CACHE?: KVNamespace
}

const v1 = new Hono<{ Bindings: V1Bindings }>()

const PUBLISHER_ID = 'cfegdhabc31955'
const MATT_TOOL    = '38524122'

// ── CORS aberto para API pública ────────────────────────
v1.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['X-API-Key', 'Content-Type', 'Authorization'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
}))

// ════════════════════════════════════════════════════════
// MIDDLEWARE: Autenticação + Rate Limit
// ════════════════════════════════════════════════════════
v1.use('*', async (c, next) => {
  // Extrai chave do header ou query param
  const rawKey =
    c.req.header('X-API-Key') ||
    c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ||
    c.req.query('api_key') ||
    ''

  if (!rawKey) {
    return c.json({
      error:   'API Key obrigatória',
      message: 'Passe a chave no header X-API-Key ou no query param ?api_key=',
      docs:    'https://kainowradar.com.br/api-docs',
    }, 401)
  }

  // Extrai prefixo para lookup rápido (primeiros 16 chars)
  const prefix = rawKey.substring(0, 16)

  // Hash SHA-256 do token para comparar com o banco
  const keyHash = await sha256(rawKey)

  const { DB, CACHE } = c.env

  // Busca no D1 pela hash
  const keyRow = await DB.prepare(`
    SELECT id, name, plan, scopes, rate_limit, is_active,
           expires_at, total_calls, owner_email
    FROM api_keys
    WHERE key_hash = ? AND key_prefix = ?
  `).bind(keyHash, prefix).first<{
    id: string
    name: string
    plan: string
    scopes: string
    rate_limit: number
    is_active: number
    expires_at: string | null
    total_calls: number
    owner_email: string | null
  }>()

  if (!keyRow) {
    return c.json({
      error:   'API Key inválida',
      message: 'Chave não encontrada. Verifique se a chave está correta.',
      docs:    'https://kainowradar.com.br/api-docs',
    }, 401)
  }

  if (!keyRow.is_active) {
    return c.json({ error: 'API Key desativada. Entre em contato com o suporte.' }, 403)
  }

  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return c.json({ error: 'API Key expirada.', expired_at: keyRow.expires_at }, 403)
  }

  // ── Rate Limit via KV ─────────────────────────────────
  const hourSlot  = Math.floor(Date.now() / 3_600_000) // slot de 1 hora
  const rlKey     = `rl:${keyRow.id}:${hourSlot}`
  const limitPerHour = keyRow.rate_limit || 100

  let currentCount = 0
  if (CACHE) {
    const raw = await CACHE.get(rlKey).catch(() => null)
    currentCount = raw ? parseInt(raw) : 0
  }

  const remaining = Math.max(0, limitPerHour - currentCount)
  const resetTs   = (hourSlot + 1) * 3_600_000

  // Seta headers de rate limit em todas as respostas
  c.header('X-RateLimit-Limit',     String(limitPerHour))
  c.header('X-RateLimit-Remaining', String(remaining))
  c.header('X-RateLimit-Reset',     String(Math.floor(resetTs / 1000)))
  c.header('X-API-Key-Plan',        keyRow.plan)

  if (currentCount >= limitPerHour) {
    return c.json({
      error:          'Rate limit excedido',
      limit_per_hour: limitPerHour,
      reset_at:       new Date(resetTs).toISOString(),
      plan:           keyRow.plan,
      upgrade_url:    'https://kainowradar.com.br/api-docs#planos',
    }, 429)
  }

  // Incrementa contador no KV (TTL de 2h para garantir limpeza)
  if (CACHE) {
    await CACHE.put(rlKey, String(currentCount + 1), { expirationTtl: 7200 }).catch(() => {})
  }

  // Atualiza last_used_at + total_calls (async, não bloqueia resposta)
  const callStart = Date.now()
  c.set('apiKeyId'   as never, keyRow.id)
  c.set('apiKeyName' as never, keyRow.name)
  c.set('apiKeyPlan' as never, keyRow.plan)
  c.set('apiKeyScopes'as never, keyRow.scopes)
  c.set('callStart'  as never, callStart)

  // Atualiza uso no D1 (fire & forget)
  DB.prepare(`
    UPDATE api_keys
    SET last_used_at = CURRENT_TIMESTAMP,
        total_calls  = total_calls + 1,
        updated_at   = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(keyRow.id).run().catch(() => {})

  await next()

  // Log assíncrono após resposta
  const dur = Date.now() - callStart
  const url = new URL(c.req.url)
  const ip  = c.req.header('CF-Connecting-IP') || ''
  const ipH = ip ? await sha256(ip).then(h => h.substring(0, 16)) : ''

  DB.prepare(`
    INSERT INTO api_usage_log
      (key_id, endpoint, method, status_code, ip_hash, user_agent, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    keyRow.id,
    url.pathname,
    c.req.method,
    c.res.status,
    ipH,
    (c.req.header('User-Agent') || '').substring(0, 200),
    dur,
  ).run().catch(() => {})
})

// ════════════════════════════════════════════════════════
// HELPER: SHA-256
// ════════════════════════════════════════════════════════
async function sha256(text: string): Promise<string> {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ════════════════════════════════════════════════════════
// GET /api/v1/status — Status da chave + quota
// ════════════════════════════════════════════════════════
v1.get('/status', async (c) => {
  const plan      = c.get('apiKeyPlan'  as never) as string
  const name      = c.get('apiKeyName'  as never) as string
  const scopes    = c.get('apiKeyScopes'as never) as string
  const remaining = parseInt(c.res.headers.get('X-RateLimit-Remaining') || '0')
  const limit     = parseInt(c.res.headers.get('X-RateLimit-Limit') || '100')

  return c.json({
    ok:       true,
    app_name: name,
    plan,
    scopes:   scopes.split(','),
    quota: {
      limit_per_hour: limit,
      remaining,
      used: limit - remaining,
    },
    endpoints: [
      'GET /api/v1/status',
      'GET /api/v1/products',
      'GET /api/v1/products/:id',
      'GET /api/v1/search?q=',
      'GET /api/v1/categories',
      'GET /api/v1/deals',
      'GET /api/v1/price/:ml_id',
    ],
    docs: 'https://kainowradar.com.br/api-docs',
    powered_by: 'KainowRadar API v1',
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/products — Lista produtos com filtros
// Params: category, brand, q, min_price, max_price, limit(≤50), page, sort
// ════════════════════════════════════════════════════════
v1.get('/products', async (c) => {
  const { DB } = c.env
  const q        = (c.req.query('q') || '').trim()
  const category = c.req.query('category') || ''
  const brand    = c.req.query('brand') || ''
  const minPrice = parseFloat(c.req.query('min_price') || '0')
  const maxPrice = parseFloat(c.req.query('max_price') || '0')
  const limit    = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const page     = Math.max(1, parseInt(c.req.query('page') || '1'))
  const offset   = (page - 1) * limit
  const sort     = c.req.query('sort') || 'relevance'

  let where = 'WHERE p.is_active = 1'
  const binds: any[] = []

  if (q)        { where += ' AND (p.name LIKE ? OR p.brand LIKE ? OR p.ean LIKE ?)'; binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  if (category) { where += ' AND p.category = ?'; binds.push(category) }
  if (brand)    { where += ' AND p.brand LIKE ?'; binds.push(`%${brand}%`) }
  if (minPrice) { where += ' AND p.best_price >= ?'; binds.push(minPrice) }
  if (maxPrice) { where += ' AND p.best_price <= ?'; binds.push(maxPrice) }

  const orderMap: Record<string, string> = {
    relevance:  'p.offer_count DESC, p.best_price ASC',
    price_asc:  'p.best_price ASC',
    price_desc: 'p.best_price DESC',
    newest:     'p.created_at DESC',
    name:       'p.name ASC',
  }
  const orderBy = orderMap[sort] || orderMap.relevance

  const [countRow, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM products p ${where}`)
      .bind(...binds).first<{ total: number }>(),
    DB.prepare(`
      SELECT
        p.id, p.name, p.slug, p.brand, p.category,
        p.image_url, p.best_price, p.offer_count,
        p.ml_item_id, p.affiliate_url,
        s.name  AS best_store,
        s.slug  AS best_store_slug,
        o.price AS store_price,
        o.discount_percent,
        o.free_shipping,
        p.created_at, p.updated_at
      FROM products p
      LEFT JOIN offers o  ON o.product_id = p.id
        AND o.price = (SELECT MIN(o2.price) FROM offers o2 WHERE o2.product_id = p.id AND o2.is_active = 1 AND o2.in_stock = 1)
        AND o.is_active = 1 AND o.in_stock = 1
      LEFT JOIN stores s ON s.id = o.store_id
      ${where}
      GROUP BY p.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).bind(...binds, limit, offset).all(),
  ])

  const total = countRow?.total || 0
  const totalPages = Math.ceil(total / limit)

  return c.json({
    data: (data.results || []).map(formatProduct),
    meta: {
      total,
      page,
      per_page: limit,
      total_pages: totalPages,
      has_next: page < totalPages,
    },
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/products/:id — Produto único com todas as ofertas
// ════════════════════════════════════════════════════════
v1.get('/products/:id', async (c) => {
  const { DB }  = c.env
  const idParam = c.req.param('id')

  // Aceita id numérico ou slug
  const isNumeric = /^\d+$/.test(idParam)
  const whereClause = isNumeric ? 'p.id = ?' : 'p.slug = ?'
  const bindVal = isNumeric ? parseInt(idParam) : idParam

  const product = await DB.prepare(`
    SELECT p.*, s.name AS best_store_name, s.slug AS best_store_slug
    FROM products p
    LEFT JOIN stores s ON s.id = p.best_store_id
    WHERE ${whereClause} AND p.is_active = 1
  `).bind(bindVal).first<any>()

  if (!product) {
    return c.json({ error: 'Produto não encontrado' }, 404)
  }

  // Busca todas as ofertas ativas
  const { results: offers } = await DB.prepare(`
    SELECT
      o.id, o.price, o.original_price, o.discount_percent,
      o.free_shipping, o.in_stock, o.affiliate_url,
      o.last_updated,
      s.name AS store_name, s.slug AS store_slug, s.logo_url AS store_logo
    FROM offers o
    JOIN stores s ON s.id = o.store_id AND s.is_active = 1
    WHERE o.product_id = ? AND o.is_active = 1
    ORDER BY o.price ASC
  `).bind(product.id).all<any>()

  return c.json({
    data: {
      ...formatProduct(product),
      offers: (offers || []).map((o: any) => ({
        store:            o.store_name,
        store_slug:       o.store_slug,
        store_logo:       o.store_logo,
        price:            o.price,
        original_price:   o.original_price,
        discount_percent: o.discount_percent,
        free_shipping:    !!o.free_shipping,
        in_stock:         !!o.in_stock,
        affiliate_url:    o.affiliate_url,
        updated_at:       o.last_updated,
      })),
    },
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/search?q= — Busca textual
// ════════════════════════════════════════════════════════
v1.get('/search', async (c) => {
  const { DB } = c.env
  const q      = (c.req.query('q') || '').trim()
  const limit  = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))

  if (!q || q.length < 2) {
    return c.json({ error: 'Parâmetro q obrigatório (mínimo 2 caracteres)' }, 400)
  }

  const { results } = await DB.prepare(`
    SELECT
      p.id, p.name, p.slug, p.brand, p.category,
      p.image_url, p.best_price, p.offer_count,
      p.ml_item_id, p.affiliate_url,
      s.name AS best_store, s.slug AS best_store_slug
    FROM products p
    LEFT JOIN stores s ON s.id = p.best_store_id
    WHERE p.is_active = 1
      AND (p.name LIKE ? OR p.brand LIKE ? OR p.ean LIKE ? OR p.description LIKE ?)
    ORDER BY p.offer_count DESC, p.best_price ASC
    LIMIT ?
  `).bind(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit).all<any>()

  return c.json({
    query: q,
    data:  (results || []).map(formatProduct),
    meta:  { count: results?.length || 0 },
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/categories — Lista categorias com contagem
// ════════════════════════════════════════════════════════
v1.get('/categories', async (c) => {
  const { DB } = c.env

  const { results } = await DB.prepare(`
    SELECT
      c.id, c.name, c.slug, c.icon,
      c.ml_category_id,
      COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category = c.slug AND p.is_active = 1
    WHERE c.is_active = 1
    GROUP BY c.id
    ORDER BY product_count DESC, c.name ASC
  `).all<any>()

  return c.json({
    data: (results || []).map((cat: any) => ({
      id:             cat.id,
      name:           cat.name,
      slug:           cat.slug,
      icon:           cat.icon,
      ml_category_id: cat.ml_category_id,
      product_count:  cat.product_count,
      url:            `https://kainowradar.com.br/categoria/${cat.slug}`,
    })),
    meta: { count: results?.length || 0 },
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/deals — Melhores ofertas (maior desconto)
// Params: category, limit(≤50), min_discount(%)
// ════════════════════════════════════════════════════════
v1.get('/deals', async (c) => {
  const { DB }  = c.env
  const limit   = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const category = c.req.query('category') || ''
  const minDisc  = parseInt(c.req.query('min_discount') || '5')

  let where = `WHERE p.is_active = 1 AND o.is_active = 1 AND o.in_stock = 1
               AND o.discount_percent >= ?`
  const binds: any[] = [minDisc]

  if (category) { where += ' AND p.category = ?'; binds.push(category) }

  const { results } = await DB.prepare(`
    SELECT
      p.id, p.name, p.slug, p.brand, p.category, p.image_url,
      p.ml_item_id, p.affiliate_url,
      MIN(o.price)        AS price,
      o.original_price,
      MAX(o.discount_percent) AS discount_percent,
      o.free_shipping,
      s.name  AS best_store,
      s.slug  AS best_store_slug
    FROM products p
    JOIN offers o ON o.product_id = p.id
      AND o.price = (SELECT MIN(o2.price) FROM offers o2 WHERE o2.product_id = p.id AND o2.is_active = 1 AND o2.in_stock = 1)
    JOIN stores s ON s.id = o.store_id AND s.is_active = 1
    ${where}
    GROUP BY p.id
    ORDER BY discount_percent DESC, price ASC
    LIMIT ?
  `).bind(...binds, limit).all<any>()

  return c.json({
    data: (results || []).map((p: any) => ({
      ...formatProduct(p),
      discount_percent: p.discount_percent,
      original_price:   p.original_price,
      savings:          p.original_price && p.price
        ? parseFloat((p.original_price - p.price).toFixed(2))
        : null,
    })),
    meta: { count: results?.length || 0, min_discount: minDisc },
  })
})

// ════════════════════════════════════════════════════════
// GET /api/v1/price/:ml_id — Preço atual de item ML
// Retorna dados do produto pelo ml_item_id (ex: MLB1234567890)
// ════════════════════════════════════════════════════════
v1.get('/price/:ml_id', async (c) => {
  const { DB }  = c.env
  const mlId    = c.req.param('ml_id').toUpperCase()

  if (!mlId.startsWith('MLB')) {
    return c.json({ error: 'ID deve começar com MLB (ex: MLB1234567890)' }, 400)
  }

  const product = await DB.prepare(`
    SELECT p.id, p.name, p.slug, p.brand, p.best_price,
           p.ml_item_id, p.affiliate_url, p.updated_at
    FROM products p
    WHERE p.ml_item_id = ? AND p.is_active = 1
  `).bind(mlId).first<any>()

  if (!product) {
    return c.json({ error: `Item ${mlId} não encontrado no catálogo` }, 404)
  }

  // Melhor oferta atual
  const bestOffer = await DB.prepare(`
    SELECT o.price, o.original_price, o.discount_percent, o.free_shipping,
           o.affiliate_url, o.last_updated,
           s.name AS store_name, s.slug AS store_slug
    FROM offers o
    JOIN stores s ON s.id = o.store_id AND s.is_active = 1
    WHERE o.product_id = ? AND o.is_active = 1 AND o.in_stock = 1
    ORDER BY o.price ASC
    LIMIT 1
  `).bind(product.id).first<any>()

  return c.json({
    ml_item_id:       mlId,
    name:             product.name,
    slug:             product.slug,
    brand:            product.brand,
    price:            bestOffer?.price ?? product.best_price,
    original_price:   bestOffer?.original_price ?? null,
    discount_percent: bestOffer?.discount_percent ?? null,
    free_shipping:    !!bestOffer?.free_shipping,
    store:            bestOffer?.store_name ?? null,
    affiliate_url:    bestOffer?.affiliate_url ?? product.affiliate_url,
    url:              `https://kainowradar.com.br/produto/${product.slug}`,
    updated_at:       bestOffer?.last_updated ?? product.updated_at,
  })
})

// ════════════════════════════════════════════════════════
// HELPER: Formata produto para resposta da API
// ════════════════════════════════════════════════════════
function formatProduct(p: any) {
  return {
    id:               p.id,
    name:             p.name,
    slug:             p.slug,
    brand:            p.brand     || null,
    category:         p.category  || null,
    image_url:        p.image_url || null,
    price:            p.best_price ?? p.store_price ?? null,
    discount_percent: p.discount_percent ?? null,
    free_shipping:    !!p.free_shipping,
    offer_count:      p.offer_count || 0,
    best_store:       p.best_store || p.best_store_name || null,
    ml_item_id:       p.ml_item_id || null,
    affiliate_url:    p.affiliate_url || null,
    url:              `https://kainowradar.com.br/produto/${p.slug}`,
    updated_at:       p.updated_at || null,
  }
}

export default v1
