// ============================================================
// ROUTES: API — Produtos, Busca, Ofertas, Cliques
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'
import { CacheManager } from '../lib/cache'
import { IngestEngine } from '../lib/ingest'

const api = new Hono<{ Bindings: Bindings }>()

// ── GET /api/products?q=&category=&brand=&page=&sort= ─────
api.get('/products', async (c) => {
  const { DB, CACHE } = c.env
  const q = c.req.query('q') || ''
  const category = c.req.query('category') || ''
  const brand = c.req.query('brand') || ''
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = Math.min(48, parseInt(c.req.query('per_page') || '24'))
  const sort = c.req.query('sort') || 'relevance'
  const offset = (page - 1) * perPage

  const cacheKey = `search:${q}:${category}:${brand}:${page}:${sort}`
  const cache = new CacheManager(CACHE)
  const cached = await cache.getSearch(cacheKey)
  if (cached) return c.json(cached)

  let whereClause = 'WHERE p.is_active = 1'
  const binds: any[] = []

  if (q) {
    whereClause += ' AND (p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)'
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (category) {
    whereClause += ' AND p.category = ?'
    binds.push(category)
  }
  if (brand) {
    whereClause += ' AND p.brand = ?'
    binds.push(brand)
  }

  const orderBy = {
    relevance: 'p.offer_count DESC, p.best_price ASC',
    price_asc: 'p.best_price ASC',
    price_desc: 'p.best_price DESC',
    newest: 'p.created_at DESC',
  }[sort] || 'p.offer_count DESC'

  const countQuery = `SELECT COUNT(*) as total FROM products p ${whereClause}`
  const dataQuery = `
    SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
    FROM products p
    LEFT JOIN stores s ON s.id = p.best_store_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `

  const [countResult, dataResult] = await Promise.all([
    DB.prepare(countQuery).bind(...binds).first<{ total: number }>(),
    DB.prepare(dataQuery).bind(...binds, perPage, offset).all()
  ])

  const result = {
    products: dataResult.results,
    total: countResult?.total || 0,
    page,
    per_page: perPage,
    query: q,
    category,
    brand,
  }

  await cache.setSearch(cacheKey, result)
  return c.json(result)
})

// ── GET /api/products/:slug ───────────────────────────────
api.get('/products/:slug', async (c) => {
  const { DB, CACHE } = c.env
  const slug = c.req.param('slug')
  const cache = new CacheManager(CACHE)

  const cached = await cache.getProduct(slug)
  if (cached) return c.json(cached)

  const product = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.slug = ? AND p.is_active = 1
    `)
    .bind(slug)
    .first()

  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

  // Busca ofertas com dados da loja
  const { results: offers } = await DB
    .prepare(`
      SELECT o.*, s.name as store_name, s.slug as store_slug, s.logo_url as store_logo,
             s.affiliate_network, s.affiliate_id
      FROM offers o
      JOIN stores s ON s.id = o.store_id
      WHERE o.product_id = ? AND o.is_active = 1 AND o.in_stock = 1
      ORDER BY o.price ASC
    `)
    .bind((product as any).id)
    .all()

  const result = { product, offers }
  await cache.setProduct(slug, result)
  return c.json(result)
})

// ── GET /api/categories ───────────────────────────────────
api.get('/categories', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)
  const cached = await cache.get('all_categories')
  if (cached) return c.json(cached)

  const { results } = await DB
    .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC')
    .all()

  await cache.set('all_categories', results, 3600)
  return c.json(results)
})

// ── GET /api/stores ───────────────────────────────────────
api.get('/stores', async (c) => {
  const { DB } = c.env
  const { results } = await DB
    .prepare('SELECT id, slug, name, logo_url, commission_rate FROM stores WHERE is_active = 1 ORDER BY name ASC')
    .all()
  return c.json(results)
})

// ── GET /api/offers/:productId ────────────────────────────
api.get('/offers/:productId', async (c) => {
  const { DB, CACHE } = c.env
  const productId = parseInt(c.req.param('productId'))
  const cache = new CacheManager(CACHE)

  const cached = await cache.getOffers(productId)
  if (cached) return c.json(cached)

  const { results } = await DB
    .prepare(`
      SELECT o.*, s.name as store_name, s.slug as store_slug, s.logo_url as store_logo
      FROM offers o
      JOIN stores s ON s.id = o.store_id
      WHERE o.product_id = ? AND o.is_active = 1
      ORDER BY o.price ASC
    `)
    .bind(productId)
    .all()

  await cache.setOffers(productId, results)
  return c.json(results)
})

// ── POST /api/click — Registra clique e prioriza update ───
api.post('/click', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({}))
  const { offer_id, product_id, store_id } = body

  if (!offer_id) return c.json({ error: 'offer_id obrigatório' }, 400)

  // Registra o clique
  const ipHash = await hashIP(c.req.header('CF-Connecting-IP') || '0.0.0.0')
  await DB
    .prepare(`
      INSERT INTO click_events (product_id, offer_id, store_id, ip_hash, user_agent, referrer)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      product_id || null,
      offer_id,
      store_id || null,
      ipHash,
      c.req.header('User-Agent') || '',
      c.req.header('Referer') || ''
    )
    .run()

  // Prioriza atualização de preço (prioridade 1 = urgente)
  const ingest = new IngestEngine(DB)
  await ingest.queuePriceUpdate(offer_id, 1)

  return c.json({ ok: true })
})

// ── POST /api/ingest — Ingestão de dados (protegida) ──────
api.post('/ingest', async (c) => {
  const { DB } = c.env
  const authHeader = c.req.header('Authorization')

  // Proteção básica — em prod usar JWT ou Cloudflare Access
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const body = await c.req.json()
  const { items } = body

  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: 'items[] obrigatório' }, 400)
  }

  const ingest = new IngestEngine(DB)
  const stats = await ingest.ingestBatch(items)
  return c.json({ ok: true, stats })
})

// ── POST /api/cron/process-queue — Background job ─────────
api.post('/cron/process-queue', async (c) => {
  const { DB } = c.env
  const ingest = new IngestEngine(DB)
  const processed = await ingest.processQueue(10)
  return c.json({ ok: true, processed })
})

// ── GET /api/search/suggestions?q= ───────────────────────
api.get('/search/suggestions', async (c) => {
  const { DB } = c.env
  const q = c.req.query('q') || ''
  if (q.length < 2) return c.json([])

  const { results } = await DB
    .prepare(`
      SELECT DISTINCT name, slug, brand, category, image_url, best_price
      FROM products
      WHERE name LIKE ? AND is_active = 1
      ORDER BY offer_count DESC
      LIMIT 8
    `)
    .bind(`%${q}%`)
    .all()

  return c.json(results)
})

// ── GET /api/featured — Produtos em destaque ──────────────
api.get('/featured', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)
  const cached = await cache.get('featured_products')
  if (cached) return c.json(cached)

  const { results } = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.is_active = 1 AND p.offer_count > 0
      ORDER BY p.offer_count DESC, p.best_price ASC
      LIMIT 12
    `)
    .all()

  await cache.set('featured_products', results, 900)
  return c.json(results)
})

// ── GET /api/deals — Maiores descontos ────────────────────
api.get('/deals', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)
  const cached = await cache.get('top_deals')
  if (cached) return c.json(cached)

  const { results } = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug,
             o.discount_percent as top_discount, o.price as deal_price,
             o.original_price as deal_original_price
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      JOIN offers o ON o.product_id = p.id AND o.store_id = p.best_store_id
      WHERE p.is_active = 1 AND o.discount_percent > 5 AND o.is_active = 1
      ORDER BY o.discount_percent DESC
      LIMIT 12
    `)
    .all()

  await cache.set('top_deals', results, 600)
  return c.json(results)
})

// ── Helpers ───────────────────────────────────────────────
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(ip + 'salt_shopping')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
}

export default api
