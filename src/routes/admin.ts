// ============================================================
// ROUTES: Admin — Painel Administrativo Completo
// Protegido por Bearer token (ADMIN_SECRET via wrangler secret)
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'
import { CacheManager } from '../lib/cache'
import { detectCategoryWithFallback } from '../lib/categorize'
import ml from './ml'

type AdminBindings = Bindings & {
  ADMIN_SECRET?: string
  ML_APP_ID?: string
  ML_SECRET?: string
  GECKO_API_KEY?: string
  LOMADEE_API_KEY?: string
}

const admin = new Hono<{ Bindings: AdminBindings }>()

// ── Middleware de autenticação ────────────────────────────
// Rotas públicas (não precisam de token)
admin.post('/api/login', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({} as any))
  const secret = (c.env as any).ADMIN_SECRET || 'admin123'

  const ipHash    = await hashIP(c.req.header('CF-Connecting-IP') || '0')
  const userAgent = c.req.header('User-Agent') || ''
  const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString()

  // ── Modo 1: login com email + senha (admin_users) ──────────
  if (body.email && body.password) {
    const user = await DB.prepare(
      `SELECT * FROM admin_users WHERE email = ? AND status = 'active' LIMIT 1`
    ).bind(body.email.toLowerCase().trim()).first<any>()

    if (!user) return c.json({ error: 'Email ou senha incorretos' }, 401)

    // Verifica hash: formato "salt:hash"
    const parts = (user.password_hash || '').split(':')
    if (parts.length !== 2) return c.json({ error: 'Conta com configuração inválida' }, 401)
    const [salt, storedHash] = parts
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + body.password))
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')

    if (hash !== storedHash) return c.json({ error: 'Email ou senha incorretos' }, 401)

    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2,'0')).join('')

    await DB.prepare(`
      INSERT INTO admin_sessions (token, admin_user, ip_hash, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(token, user.email, ipHash, userAgent, expiresAt).run()

    // Atualiza last_login_at e login_count
    await DB.prepare(`
      UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?
    `).bind(user.id).run().catch(() => {})

    return c.json({
      ok: true, token, expires_at: expiresAt,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    })
  }

  // ── Modo 2: login legado com ADMIN_SECRET (senha única) ────
  const { password } = body
  if (!password || password !== secret) {
    return c.json({ error: 'Senha incorreta' }, 401)
  }

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  await DB.prepare(`
    INSERT INTO admin_sessions (token, admin_user, ip_hash, user_agent, expires_at)
    VALUES (?, 'admin', ?, ?, ?)
  `).bind(token, ipHash, userAgent, expiresAt).run()

  return c.json({ ok: true, token, expires_at: expiresAt })
})

// Página HTML pública (SPA)
admin.get('/', (c) => c.html(renderAdminSPA()))
admin.get('', (c) => c.html(renderAdminSPA()))

// Middleware protege tudo abaixo (exceto /api/login e GET /)
admin.use('/api/*', async (c, next) => {
  // /api/login já foi tratado acima — só chega aqui outras rotas
  const authHeader = c.req.header('Authorization') || ''
  const cookieHeader = c.req.header('Cookie') || ''
  const cookieToken = cookieHeader.match(/admin_token=([^;]+)/)?.[1] || ''
  const bearerToken = authHeader.replace('Bearer ', '').trim()
  const token = bearerToken || cookieToken

  if (!token) return c.json({ error: 'Não autorizado' }, 401)

  // 1. Tenta validar sessão no banco
  const session = await c.env.DB
    .prepare(`
      SELECT * FROM admin_sessions
      WHERE token = ? AND is_valid = 1 AND expires_at > CURRENT_TIMESTAMP
    `)
    .bind(token)
    .first<{ token: string; admin_user: string }>()

  if (session) { await next(); return }

  // 2. Fallback: aceita ADMIN_SECRET diretamente (dev local sem banco)
  const secret = (c.env as any).ADMIN_SECRET || 'admin123'
  if (token === secret) { await next(); return }

  return c.json({ error: 'Token inválido ou expirado' }, 401)
})

// ── POST /admin/api/logout ────────────────────────────────
admin.post('/api/logout', async (c) => {
  // Extrai token do Authorization header (Bearer) ou cookie
  const authHeader = c.req.header('Authorization') || ''
  const cookieHeader = c.req.header('Cookie') || ''
  const bearerToken = authHeader.replace('Bearer ', '').trim()
  const cookieToken = cookieHeader.match(/admin_token=([^;]+)/)?.[1] || ''
  const token = bearerToken || cookieToken
  if (token) {
    await c.env.DB.prepare("UPDATE admin_sessions SET is_valid = 0 WHERE token = ?")
      .bind(token).run().catch(() => {})
  }
  return c.json({ ok: true })
})

// ── GET /admin/api/dashboard — Métricas gerais ────────────
admin.get('/api/dashboard', async (c) => {
  const { DB } = c.env
  const [products, offers, stores, users, clicks, queue] = await Promise.all([
    DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN offer_count > 0 THEN 1 ELSE 0 END) as with_offers FROM products WHERE is_active = 1").first<any>(),
    DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN in_stock = 1 THEN 1 ELSE 0 END) as in_stock, MIN(price) as min_price, MAX(price) as max_price, AVG(price) as avg_price FROM offers WHERE is_active = 1").first<any>(),
    DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active FROM stores").first<any>(),
    DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM users").first<any>().catch(() => ({ total: 0, active: 0 })),
    DB.prepare("SELECT COUNT(*) as today FROM click_events WHERE clicked_at >= date('now')").first<any>(),
    DB.prepare("SELECT COUNT(*) as pending FROM price_update_queue WHERE status = 'pending'").first<any>(),
  ])

  // Top categorias por produto
  const { results: topCategories } = await DB.prepare(`
    SELECT category, COUNT(*) as count FROM products
    WHERE is_active = 1 AND category IS NOT NULL
    GROUP BY category ORDER BY count DESC LIMIT 5
  `).all()

  // Top lojas por ofertas
  const { results: topStores } = await DB.prepare(`
    SELECT s.name, s.slug, COUNT(o.id) as offer_count, MIN(o.price) as min_price
    FROM offers o JOIN stores s ON s.id = o.store_id
    WHERE o.is_active = 1 GROUP BY s.id ORDER BY offer_count DESC LIMIT 5
  `).all()

  // Cliques por dia (últimos 7 dias)
  const { results: clicksByDay } = await DB.prepare(`
    SELECT date(clicked_at) as day, COUNT(*) as clicks
    FROM click_events
    WHERE clicked_at >= date('now', '-7 days')
    GROUP BY day ORDER BY day ASC
  `).all()

  return c.json({
    products, offers, stores, users, clicks, queue,
    topCategories, topStores, clicksByDay,
    timestamp: new Date().toISOString()
  })
})

// ── GET /admin/api/top-deals — Query rápida usando best_price denormalizado ─
// Usa p.best_price + p.best_store_id (já calculados no produto) para evitar
// correlated subquery pesada que causava timeout no D1 com 200+ produtos.
admin.get('/api/top-deals', async (c) => {
  const { DB, CACHE } = c.env
  const limit = Math.min(50, parseInt(c.req.query('limit') || '20'))
  const category = c.req.query('category') || ''
  const cache = new CacheManager(CACHE)
  const cacheKey = `admin:top-deals:${category}:${limit}`
  const cached = await cache.get(cacheKey)
  if (cached) return c.json(cached)

  // Query rápida: usa best_price/best_store_id já denormalizados em products
  // + JOIN simples na offer da best_store para pegar affiliate_url/checkout_url/desconto
  // Sem correlated subquery — O(N) em vez de O(N²)
  const catFilter = category ? 'AND p.category = ?' : ''
  const binds: any[] = category ? [category, limit] : [limit]

  const { results } = await DB.prepare(`
    SELECT
      p.id,
      p.name,
      p.slug,
      p.brand,
      p.category,
      p.image_url,
      p.ean,
      p.offer_count,
      p.best_price                  AS lowest_price,
      o.original_price              AS original_price,
      o.discount_percent            AS discount_percent,
      o.free_shipping               AS free_shipping,
      o.checkout_url                AS checkout_url,
      o.affiliate_url               AS affiliate_url,
      s.name                        AS store_name,
      s.slug                        AS store_slug,
      CASE WHEN s.logo_url NOT LIKE 'data:%' THEN s.logo_url ELSE NULL END AS store_logo,
      o.last_updated                AS price_updated_at
    FROM products p
    LEFT JOIN offers o  ON o.product_id = p.id
                      AND o.store_id = p.best_store_id
                      AND o.is_active = 1
    LEFT JOIN stores s  ON s.id = p.best_store_id AND s.is_active = 1
    WHERE p.is_active = 1
      AND p.best_price IS NOT NULL
      AND p.best_price > 0
      AND p.image_url IS NOT NULL
      AND p.image_url != ''
    ${catFilter}
    ORDER BY p.best_price ASC
    LIMIT ?
  `).bind(...binds).all()

  await cache.set(cacheKey, results, 300) // cache 5 min
  return c.json(results)
})

// ── GET /admin/api/products — Lista produtos paginada ─────
admin.get('/api/products', async (c) => {
  const { DB } = c.env
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = Math.min(50, parseInt(c.req.query('per_page') || '20'))
  const q = c.req.query('q') || ''
  const category = c.req.query('category') || ''
  const offset = (page - 1) * perPage

  let where = 'WHERE 1=1'
  const binds: any[] = []
  if (q) { where += ' AND (p.name LIKE ? OR p.brand LIKE ? OR p.ean LIKE ?)'; binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  if (category) { where += ' AND p.category = ?'; binds.push(category) }

  const [count, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM products p ${where}`).bind(...binds).first<{ total: number }>(),
    DB.prepare(`
      SELECT p.*, s.name as best_store_name,
             (SELECT COUNT(*) FROM offers WHERE product_id = p.id AND is_active = 1) as live_offers
      FROM products p LEFT JOIN stores s ON s.id = p.best_store_id
      ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
    `).bind(...binds, perPage, offset).all()
  ])

  return c.json({ products: data.results, total: count?.total || 0, page, per_page: perPage })
})

// ── PATCH /admin/api/products/:id — Editar produto ────────
admin.patch('/api/products/:id', async (c) => {
  const { DB, CACHE } = c.env
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json()
  const { name, brand, category, description, image_url, is_active } = body

  await DB.prepare(`
    UPDATE products SET
      name = COALESCE(?, name),
      brand = COALESCE(?, brand),
      category = COALESCE(?, category),
      description = COALESCE(?, description),
      image_url = COALESCE(?, image_url),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(name ?? null, brand ?? null, category ?? null, description ?? null,
     image_url ?? null, is_active ?? null, id).run()

  // Invalida cache
  const prod = await DB.prepare('SELECT slug FROM products WHERE id = ?').bind(id).first<{ slug: string }>()
  if (prod) new CacheManager(CACHE).invalidateProduct(prod.slug)

  return c.json({ ok: true })
})

// ── DELETE /admin/api/products/:id — Excluir produto permanentemente ─
admin.delete('/api/products/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ ok: false, error: 'ID inválido' }, 400)
  // Remove ofertas associadas primeiro (FK), depois o produto
  await DB.prepare("DELETE FROM offers WHERE product_id = ?").bind(id).run()
  await DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
})

// ── DELETE /admin/api/offers/:id — Excluir oferta permanentemente ──
admin.delete('/api/offers/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ ok: false, error: 'ID inválido' }, 400)
  await DB.prepare("DELETE FROM offers WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
})

// ── PATCH /admin/api/offers/:id — Editar preço/dados de uma oferta ──
admin.patch('/api/offers/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ ok: false, error: 'ID inválido' }, 400)

  const body = await c.req.json().catch(() => ({})) as any
  const fields: string[] = []
  const values: any[] = []

  if (body.price !== undefined) {
    const p = parseFloat(body.price)
    if (!isNaN(p) && p > 0) { fields.push('price = ?'); values.push(p) }
  }
  if (body.original_price !== undefined) {
    const p = parseFloat(body.original_price)
    if (!isNaN(p) && p > 0) { fields.push('original_price = ?'); values.push(p) }
  }
  if (body.title !== undefined)       { fields.push('title = ?');       values.push(body.title) }
  if (body.image_url !== undefined)   { fields.push('image_url = ?');   values.push(body.image_url) }
  if (body.affiliate_url !== undefined){ fields.push('affiliate_url = ?'); values.push(body.affiliate_url) }
  if (body.in_stock !== undefined)    { fields.push('in_stock = ?');    values.push(body.in_stock ? 1 : 0) }

  if (fields.length === 0) return c.json({ ok: false, error: 'Nenhum campo para atualizar' }, 400)

  fields.push('last_updated = CURRENT_TIMESTAMP')
  values.push(id)

  await DB.prepare(`UPDATE offers SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()

  // Se preço foi atualizado, recalcular best_price do produto
  if (body.price !== undefined) {
    const offer = await DB.prepare('SELECT product_id FROM offers WHERE id = ?').bind(id).first<any>()
    if (offer?.product_id) {
      await DB.prepare(`
        UPDATE products SET
          best_price = (SELECT MIN(price) FROM offers WHERE product_id = ? AND is_active = 1 AND price > 0),
          best_store_id = (SELECT store_id FROM offers WHERE product_id = ? AND is_active = 1 AND price > 0 ORDER BY price ASC LIMIT 1),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(offer.product_id, offer.product_id, offer.product_id).run()
    }
  }

  return c.json({ ok: true })
})

// ── GET /admin/api/shopee-test/:shopId/:itemId — Diagnóstico API Shopee ──
admin.get('/api/shopee-test/:shopId/:itemId', async (c) => {
  const shopId = c.req.param('shopId')
  const itemId = c.req.param('itemId')
  const results: any = {}

  // Teste 1: API interna /api/v4/pdp/get_pc
  try {
    const r1 = await fetch(
      `https://shopee.com.br/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`,
      {
        headers: {
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':       'application/json',
          'Referer':      `https://shopee.com.br/product/${shopId}/${itemId}`,
          'X-API-SOURCE': 'pc',
        },
      }
    )
    const raw: any = await r1.json()
    const item = raw?.data?.item ?? raw?.item ?? {}
    const rawPrice = item.price_min ?? item.price ?? null
    results.api_v4 = {
      status: r1.status,
      error: raw.error ?? null,
      price_raw: rawPrice,
      price_brl: rawPrice ? Math.round(Number(rawPrice) / 100000 * 100) / 100 : null,
      name: item.name ?? null,
    }
  } catch (e: any) {
    results.api_v4 = { error: e.message }
  }

  // Teste 2: API v2 legada
  try {
    const r2 = await fetch(
      `https://shopee.com.br/api/v2/item/get?itemid=${itemId}&shopid=${shopId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://shopee.com.br/' } }
    )
    const raw2: any = await r2.json()
    const item2 = raw2?.item ?? {}
    results.api_v2 = {
      status: r2.status,
      error: raw2.error ?? null,
      price_raw: item2.price ?? item2.price_min ?? null,
    }
  } catch (e: any) {
    results.api_v2 = { error: e.message }
  }

  // Teste 3: HTML og:title + og:image (sem preço)
  try {
    const r3 = await fetch(`https://shopee.com.br/product/${shopId}/${itemId}`, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1', 'Accept': 'text/html' },
    })
    const html = await r3.text()
    const title = html.match(/og:title[^>]+content=["']([^"']+)["']/i)?.[1] ?? null
    const img   = html.match(/og:image[^>]+content=["']([^"']+)["']/i)?.[1] ?? null
    const frete = html.match(/R\$\s*([\d,\.]+)/)?.[1] ?? null
    results.html = { status: r3.status, title, img_url: img, primeiro_valor_rs: frete }
  } catch (e: any) {
    results.html = { error: e.message }
  }

  return c.json({ shopId, itemId, results })
})

// ── POST /admin/api/recalc-counts — Recalcula offer_count, best_price, best_store_id ──
admin.post('/api/recalc-counts', async (c) => {
  const { DB } = c.env
  try {
    // 1. Recalcula offer_count
    await DB.prepare(`
      UPDATE products
      SET offer_count = (
        SELECT COUNT(*) FROM offers
        WHERE product_id = products.id AND is_active = 1
      )
    `).run()

    // 2. Recalcula best_store_id (loja da oferta mais barata)
    await DB.prepare(`
      UPDATE products
      SET best_store_id = (
        SELECT store_id FROM offers
        WHERE product_id = products.id AND is_active = 1 AND price > 0
        ORDER BY price ASC LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM offers WHERE product_id = products.id AND is_active = 1 AND price > 0
      )
    `).run()

    // 3. Recalcula best_price (menor preço ativo > 0)
    await DB.prepare(`
      UPDATE products
      SET best_price = (
        SELECT MIN(price) FROM offers
        WHERE product_id = products.id AND is_active = 1 AND price > 0
      )
      WHERE EXISTS (
        SELECT 1 FROM offers WHERE product_id = products.id AND is_active = 1 AND price > 0
      )
    `).run()

    // 4. Zera best_store_id de produtos sem ofertas
    await DB.prepare(`
      UPDATE products
      SET best_store_id = NULL, best_price = NULL
      WHERE offer_count = 0
    `).run()

    // 5. Conta produtos corrigidos
    const result = await DB.prepare(`
      SELECT COUNT(*) as total FROM products WHERE offer_count > 0
    `).first<{ total: number }>()

    return c.json({ ok: true, products_with_offers: result?.total ?? 0 })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500)
  }
})

// ── GET /admin/api/offers — Lista ofertas ─────────────────
admin.get('/api/offers', async (c) => {
  const { DB } = c.env
  const productId = c.req.query('product_id')
  const storeSlug = c.req.query('store')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = 20
  const offset = (page - 1) * perPage

  let where = 'WHERE o.is_active = 1'
  const binds: any[] = []
  if (productId) { where += ' AND o.product_id = ?'; binds.push(productId) }
  if (storeSlug) { where += ' AND s.slug = ?'; binds.push(storeSlug) }

  const [count, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM offers o JOIN stores s ON s.id = o.store_id ${where}`).bind(...binds).first<{ total: number }>(),
    DB.prepare(`
      SELECT o.*, p.name as product_name, p.slug as product_slug,
             s.name as store_name, s.slug as store_slug
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN stores s ON s.id = o.store_id
      ${where}
      ORDER BY o.last_updated DESC LIMIT ? OFFSET ?
    `).bind(...binds, perPage, offset).all()
  ])

  return c.json({ offers: data.results, total: count?.total || 0, page, per_page: perPage })
})

// ── GET /admin/api/stores — Lista lojas ───────────────────
admin.get('/api/stores', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*)          FROM offers o WHERE o.store_id = s.id AND o.is_active = 1) as offer_count,
      (SELECT COUNT(DISTINCT p.id) FROM offers o JOIN products p ON p.id = o.product_id
       WHERE o.store_id = s.id AND o.is_active = 1 AND p.is_active = 1) as product_count,
      (SELECT MIN(o.price) FROM offers o WHERE o.store_id = s.id AND o.is_active = 1) as min_price,
      (SELECT MAX(o.price) FROM offers o WHERE o.store_id = s.id AND o.is_active = 1) as max_price
    FROM stores s ORDER BY product_count DESC, offer_count DESC, s.name ASC
  `).all()
  return c.json(results)
})

// ── PATCH /admin/api/stores/:id — Editar loja completa ────
admin.patch('/api/stores/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json()
  const { logo_url, affiliate_network, checkout_pattern, deeplink_base, commission_rate, is_active } = body

  await DB.prepare(`
    UPDATE stores SET
      logo_url          = CASE WHEN ? IS NOT NULL THEN ? ELSE logo_url END,
      affiliate_network = CASE WHEN ? IS NOT NULL THEN ? ELSE affiliate_network END,
      checkout_pattern  = CASE WHEN ? IS NOT NULL THEN ? ELSE checkout_pattern END,
      deeplink_base     = CASE WHEN ? IS NOT NULL THEN ? ELSE deeplink_base END,
      commission_rate   = CASE WHEN ? IS NOT NULL THEN ? ELSE commission_rate END,
      is_active         = CASE WHEN ? IS NOT NULL THEN ? ELSE is_active END
    WHERE id = ?
  `).bind(
    logo_url ?? null, logo_url ?? null,
    affiliate_network ?? null, affiliate_network ?? null,
    checkout_pattern ?? null, checkout_pattern ?? null,
    deeplink_base ?? null, deeplink_base ?? null,
    commission_rate ?? null, commission_rate ?? null,
    is_active ?? null, is_active ?? null,
    id
  ).run()

  return c.json({ ok: true })
})

// ── PATCH /admin/api/stores/:id/toggle — Ativa/desativa ───
admin.patch('/api/stores/:id/toggle', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  // Lê body com fallback — se não vier `active`, lê estado atual e inverte
  const body = await c.req.json().catch(() => ({}))
  let newActive: number
  if (typeof body.active !== 'undefined') {
    newActive = body.active ? 1 : 0
  } else {
    // Auto-toggle: busca estado atual e inverte
    const current = await DB.prepare("SELECT is_active FROM stores WHERE id = ?")
      .bind(id).first<{ is_active: number }>()
    newActive = current ? (current.is_active === 1 ? 0 : 1) : 0
  }
  await DB.prepare("UPDATE stores SET is_active = ? WHERE id = ?").bind(newActive, id).run()
  const updated = await DB.prepare("SELECT id, name, is_active FROM stores WHERE id = ?")
    .bind(id).first()
  return c.json({ ok: true, store: updated })
})

// ── GET /admin/api/api-configs — Lista configs de API ─────
admin.get('/api/api-configs', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT id, name, network, endpoint_url, feed_url, feed_type,
           rate_limit_per_min, commission_rate, is_active,
           last_sync_at, last_sync_status, last_sync_count,
           logo_url, description, docs_url, color, icon, auth_type,
           api_group, custom,
           -- Oculta segredos parcialmente
           CASE WHEN api_key IS NOT NULL THEN '••••' || substr(api_key, -4) ELSE NULL END as api_key_preview,
           CASE WHEN client_id IS NOT NULL THEN client_id ELSE NULL END as client_id
    FROM api_configs ORDER BY custom DESC, name ASC
  `).all()
  return c.json(results)
})

// ── POST /admin/api/api-configs/seed — Garante todas as redes no banco ─────
// Insere todas as redes do AFFILIATE_NETWORKS com INSERT OR IGNORE (idempotente)
admin.post('/api/api-configs/seed', async (c) => {
  const { DB } = c.env
  const networks = [
    { id: 'amazon',      name: 'Amazon Associados',        network: 'amazon-pa-api',      commission_rate: 5.0  },
    { id: 'mercadolivre',name: 'Mercado Livre Afiliados',  network: 'meli-api',           commission_rate: 8.0  },
    { id: 'magalu',      name: 'Magalu Parceiro',          network: 'magalu-api',         commission_rate: 7.0  },
    { id: 'shopee',      name: 'Shopee Afiliados',         network: 'shopee-api',         commission_rate: 6.0  },
    { id: 'shein',       name: 'Shein Afiliados',          network: 'shein-api',          commission_rate: 15.0 },
    { id: 'aliexpress',  name: 'AliExpress Portals',       network: 'aliexpress-portals', commission_rate: 6.0  },
    { id: 'dafiti',      name: 'Dafiti Afiliados',         network: 'dafiti-api',         commission_rate: 7.0  },
    { id: 'hotmart',     name: 'Hotmart',                  network: 'hotmart-api',        commission_rate: 40.0 },
    { id: 'eduzz',       name: 'Eduzz',                    network: 'eduzz-api',          commission_rate: 40.0 },
    { id: 'monetizze',   name: 'Monetizze',                network: 'monetizze-api',      commission_rate: 35.0 },
    { id: 'braip',       name: 'Braip',                    network: 'braip-api',          commission_rate: 30.0 },
    { id: 'socialsoul',  name: 'SocialSoul / Lomadee',     network: 'lomadee',            commission_rate: 8.0  },
    { id: 'rakuten',     name: 'Rakuten Advertising',      network: 'rakuten',            commission_rate: 5.0  },
    { id: 'hostinger',   name: 'Hostinger',                network: 'hostinger-api',      commission_rate: 50.0 },
    { id: 'shopify',     name: 'Shopify Partners',         network: 'shopify-partners',   commission_rate: 20.0 },
    { id: 'nuvemshop',   name: 'Nuvemshop / Tiendanube',  network: 'nuvemshop-api',      commission_rate: 25.0 },
    { id: 'nestle',      name: 'Nestlé',                   network: 'nestle-api',         commission_rate: 3.0  },
    // ── Social Commerce ──────────────────────────────────
    { id: 'tiktok-shop',    name: 'TikTok Shop Afiliados',    network: 'tiktok-shop',        commission_rate: 10.0 },
    { id: 'kwai-shop',      name: 'Kwai Shop Afiliados',      network: 'kwai-shop',          commission_rate: 8.0  },
    { id: 'instagram-shop', name: 'Instagram Shopping',       network: 'instagram-shop',     commission_rate: 5.0  },
    { id: 'youtube-shop',   name: 'YouTube Shopping',         network: 'youtube-shop',       commission_rate: 5.0  },
    { id: 'facebook-shop',  name: 'Facebook Shops / Meta',    network: 'facebook-shop',      commission_rate: 5.0  },
    // ── Plataformas de Parceria ───────────────────────────
    { id: 'ltk',            name: 'LTK (LikeToKnow.it)',      network: 'ltk-api',            commission_rate: 8.0  },
    { id: 'impact',         name: 'Impact.com',               network: 'impact-api',         commission_rate: 5.0  },
    // ── Live Commerce ─────────────────────────────────────
    { id: 'twitch',         name: 'Twitch + Amazon Assoc.',   network: 'twitch-api',         commission_rate: 5.0  },
    // ── Discovery Commerce ────────────────────────────────
    { id: 'pinterest',      name: 'Pinterest Shopping API',   network: 'pinterest-api',      commission_rate: 4.0  },
    // ── E-commerce Builder ────────────────────────────────
    { id: 'woocommerce',    name: 'WooCommerce Affiliates',   network: 'woocommerce-api',    commission_rate: 15.0 },
    { id: 'shopify-store',  name: 'Shopify Multi-vendor',     network: 'shopify-store-api',  commission_rate: 15.0 },
  ]
  let inserted = 0
  for (const n of networks) {
    const r = await DB.prepare(`
      INSERT OR IGNORE INTO api_configs (id, name, network, commission_rate, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(n.id, n.name, n.network, n.commission_rate).run()
    if (r.meta?.changes > 0) inserted++
  }
  return c.json({ ok: true, inserted, total: networks.length })
})

// ── PUT /admin/api/api-configs/by-network/:network — Upsert por network ─────
// Permite salvar config mesmo quando o id não está disponível no frontend
admin.put('/api/api-configs/by-network/:network', async (c) => {
  const { DB } = c.env
  const network = c.req.param('network')
  const body = await c.req.json()
  const { api_key, client_id, client_secret, partner_tag, is_active, rate_limit_per_min, commission_rate, logo_url } = body

  // Verifica se existe
  const existing = await DB.prepare('SELECT id FROM api_configs WHERE network = ?').bind(network).first<{ id: string }>()
  if (!existing) {
    return c.json({ error: 'Rede não encontrada — execute o seed primeiro' }, 404)
  }

  await DB.prepare(`
    UPDATE api_configs SET
      api_key        = CASE WHEN ? IS NOT NULL THEN ? ELSE api_key END,
      client_id      = CASE WHEN ? IS NOT NULL THEN ? ELSE client_id END,
      client_secret  = CASE WHEN ? IS NOT NULL THEN ? ELSE client_secret END,
      partner_tag    = CASE WHEN ? IS NOT NULL THEN ? ELSE partner_tag END,
      is_active      = CASE WHEN ? IS NOT NULL THEN ? ELSE is_active END,
      rate_limit_per_min = CASE WHEN ? IS NOT NULL THEN ? ELSE rate_limit_per_min END,
      commission_rate    = CASE WHEN ? IS NOT NULL THEN ? ELSE commission_rate END,
      logo_url       = CASE WHEN ? IS NOT NULL THEN ? ELSE logo_url END,
      updated_at     = CURRENT_TIMESTAMP
    WHERE network = ?
  `).bind(
    api_key ?? null, api_key ?? null,
    client_id ?? null, client_id ?? null,
    client_secret ?? null, client_secret ?? null,
    partner_tag ?? null, partner_tag ?? null,
    is_active ?? null, is_active ?? null,
    rate_limit_per_min ?? null, rate_limit_per_min ?? null,
    commission_rate ?? null, commission_rate ?? null,
    logo_url ?? null, logo_url ?? null,
    network
  ).run()

  return c.json({ ok: true })
})

// ── PUT /admin/api/api-configs/by-network/:network/toggle — Toggle por network ─
admin.put('/api/api-configs/by-network/:network/toggle', async (c) => {
  const { DB } = c.env
  const network = c.req.param('network')
  const body = await c.req.json().catch(() => ({}))

  const current = await DB.prepare('SELECT id, is_active FROM api_configs WHERE network = ?')
    .bind(network).first<{ id: string; is_active: number }>()
  if (!current) return c.json({ error: 'Rede não encontrada' }, 404)

  const newActive = typeof body.active !== 'undefined' ? (body.active ? 1 : 0) : (current.is_active === 1 ? 0 : 1)
  await DB.prepare('UPDATE api_configs SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE network = ?')
    .bind(newActive, network).run()

  return c.json({ ok: true, is_active: newActive })
})

// ── PATCH /admin/api/api-configs/:id — Atualiza config ───
admin.patch('/api/api-configs/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const body = await c.req.json()
  const { api_key, client_id, client_secret, partner_tag, is_active, rate_limit_per_min, commission_rate, logo_url } = body

  await DB.prepare(`
    UPDATE api_configs SET
      api_key = COALESCE(?, api_key),
      client_id = COALESCE(?, client_id),
      client_secret = COALESCE(?, client_secret),
      partner_tag = COALESCE(?, partner_tag),
      is_active = COALESCE(?, is_active),
      rate_limit_per_min = COALESCE(?, rate_limit_per_min),
      commission_rate = COALESCE(?, commission_rate),
      logo_url = COALESCE(?, logo_url),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(api_key ?? null, client_id ?? null, client_secret ?? null,
     partner_tag ?? null, is_active ?? null, rate_limit_per_min ?? null,
     commission_rate ?? null, logo_url ?? null, id).run()

  return c.json({ ok: true })
})

// ── PATCH /admin/api/api-configs/:id/toggle ───────────────
admin.patch('/api/api-configs/:id/toggle', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  // Lê body com fallback — se não vier `active`, auto-toggle
  const body = await c.req.json().catch(() => ({}))
  let newActive: number
  if (typeof body.active !== 'undefined') {
    newActive = body.active ? 1 : 0
  } else {
    const current = await DB.prepare("SELECT is_active FROM api_configs WHERE id = ?")
      .bind(id).first<{ is_active: number }>()
    newActive = current ? (current.is_active === 1 ? 0 : 1) : 0
  }
  await DB.prepare("UPDATE api_configs SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(newActive, id).run()
  const updated = await DB.prepare("SELECT id, name, is_active FROM api_configs WHERE id = ?")
    .bind(id).first()
  return c.json({ ok: true, config: updated })
})

// ── POST /admin/api/api-configs/new — Cria empresa customizada ───────────────
admin.post('/api/api-configs/new', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const { name, network, group, commission_rate, description, docs_url,
          api_key, client_id, client_secret, partner_tag,
          logo_url, color, icon, auth_type } = body

  if (!name || !network) return c.json({ error: 'name e network são obrigatórios' }, 400)

  // id = slug do network
  const id = network.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // Verifica duplicata
  const exists = await DB.prepare('SELECT id FROM api_configs WHERE id = ? OR network = ?').bind(id, network).first()
  if (exists) return c.json({ error: 'Empresa com esse network já existe' }, 409)

  await DB.prepare(`
    INSERT INTO api_configs
      (id, name, network, commission_rate, is_active,
       api_key, client_id, client_secret, partner_tag,
       logo_url, description, docs_url, color, icon, auth_type, custom, api_group,
       created_at, updated_at)
    VALUES (?,?,?,?,0, ?,?,?,?, ?,?,?,?,?,?,1,?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    id, name, network, commission_rate || 0,
    api_key || null, client_id || null, client_secret || null, partner_tag || null,
    logo_url || null, description || null, docs_url || null,
    color || '#6366F1', icon || '🔌', auth_type || 'API Key',
    group || 'Outros'
  ).run()

  return c.json({ ok: true, id })
})

// ── DELETE /admin/api/api-configs/:id — Remove empresa customizada ───────────
admin.delete('/api/api-configs/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')

  // Só permite deletar registros customizados (custom = 1)
  const row = await DB.prepare('SELECT id, custom FROM api_configs WHERE id = ?').bind(id).first<{ id: string; custom: number }>()
  if (!row) return c.json({ error: 'Não encontrado' }, 404)
  if (!row.custom) return c.json({ error: 'Redes padrão não podem ser removidas' }, 403)

  await DB.prepare('DELETE FROM api_configs WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ── GET /admin/api/users — Lista usuários ─────────────────
admin.get('/api/users', async (c) => {
  const { DB } = c.env
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = 20
  const offset = (page - 1) * perPage
  const q = c.req.query('q') || ''
  const status = c.req.query('status') || ''

  let where = 'WHERE 1=1'
  const binds: any[] = []
  if (q) { where += ' AND (email LIKE ? OR full_name LIKE ?)'; binds.push(`%${q}%`, `%${q}%`) }
  if (status) { where += ' AND status = ?'; binds.push(status) }

  const [count, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM users ${where}`).bind(...binds).first<{ total: number }>(),
    DB.prepare(`
      SELECT id, email, full_name, role, status, last_login_at, login_count, created_at
      FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(...binds, perPage, offset).all()
  ])

  return c.json({ users: data.results, total: count?.total || 0, page, per_page: perPage })
})

// ── PATCH /admin/api/users/:id/status — Bloquear/ativar ──
admin.patch('/api/users/:id/status', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { status } = await c.req.json()
  if (!['active', 'blocked'].includes(status)) return c.json({ error: 'Status inválido' }, 400)
  await DB.prepare("UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, id).run()
  return c.json({ ok: true })
})

// ── DELETE /admin/api/users/:id ───────────────────────────
admin.delete('/api/users/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  await DB.prepare("DELETE FROM users WHERE id = ? AND role != 'admin'").bind(id).run()
  return c.json({ ok: true })
})

// ── PATCH /admin/api/members/:id — Editar cliente (oauth_users) ──
admin.patch('/api/members/:id', async (c) => {
  const { DB } = c.env
  const id   = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as any
  const { full_name, status, notify_email, offers_email } = body
  await DB.prepare(`
    UPDATE oauth_users SET
      full_name    = COALESCE(?, full_name),
      notify_email = COALESCE(?, notify_email),
      offers_email = COALESCE(?, offers_email)
    WHERE id = ?
  `).bind(full_name ?? null, notify_email ?? null, offers_email ?? null, id).run()
  // bloquear sessão se status=blocked
  if (status === 'blocked') {
    await DB.prepare(`UPDATE oauth_users SET session_token = NULL, session_expires_at = NULL WHERE id = ?`).bind(id).run()
  }
  return c.json({ ok: true })
})

// ── GET /admin/api/members — Lista clientes oauth ─────────
admin.get('/api/members', async (c) => {
  const { DB } = c.env
  const page    = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = 25
  const offset  = (page - 1) * perPage
  const q       = c.req.query('q') || ''
  const filter  = c.req.query('filter') || ''

  let where = 'WHERE 1=1'
  const binds: any[] = []
  if (q) { where += ' AND (email LIKE ? OR full_name LIKE ?)'; binds.push(`%${q}%`, `%${q}%`) }
  if (filter === 'google')   { where += " AND auth_provider = 'google'"; }
  if (filter === 'email')    { where += " AND auth_provider = 'email'";  }
  if (filter === 'offers')   { where += ' AND offers_email = 1';         }
  if (filter === 'notified') { where += ' AND notify_email = 1';         }

  const [count, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM oauth_users ${where}`).bind(...binds).first<any>(),
    DB.prepare(`
      SELECT id, email, full_name, avatar_url, auth_provider, notify_email, offers_email,
             onboarding_done, last_login_at, login_count, created_at, session_expires_at
      FROM oauth_users ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(...binds, perPage, offset).all()
  ])
  return c.json({ members: data.results, total: count?.total || 0, page, per_page: perPage })
})

// ── GET /admin/api/admin-users — Lista admins ─────────────
admin.get('/api/admin-users', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT au.*, GROUP_CONCAT(ap.permission) as permissions
    FROM admin_users au
    LEFT JOIN admin_permissions ap ON ap.admin_id = au.id AND ap.granted = 1
    GROUP BY au.id
    ORDER BY au.created_at DESC
  `).all<any>()
  return c.json(results || [])
})

// ── POST /admin/api/admin-users — Criar admin ─────────────
admin.post('/api/admin-users', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const { name, email, password, role, permissions } = body

  if (!name || !email || !password) return c.json({ error: 'Nome, email e senha obrigatórios' }, 400)
  if (password.length < 6) return c.json({ error: 'Senha mínima de 6 caracteres' }, 400)

  const existing = await DB.prepare(`SELECT id FROM admin_users WHERE email = ?`).bind(email.toLowerCase()).first<any>()
  if (existing) return c.json({ error: 'Email já cadastrado' }, 409)

  const salt  = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')
  const buf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + password))
  const hash  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
  const id    = crypto.randomUUID()

  await DB.prepare(`
    INSERT INTO admin_users (id, name, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).bind(id, name.trim(), email.toLowerCase().trim(), `${salt}:${hash}`, role || 'moderator').run()

  // Salva permissões
  if (Array.isArray(permissions)) {
    for (const perm of permissions) {
      await DB.prepare(`INSERT OR REPLACE INTO admin_permissions (admin_id, permission, granted) VALUES (?,?,1)`)
        .bind(id, perm).run()
    }
  }
  return c.json({ ok: true, id })
})

// ── PATCH /admin/api/admin-users/:id — Editar admin ───────
admin.patch('/api/admin-users/:id', async (c) => {
  const { DB } = c.env
  const id   = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as any
  const { name, email, password, role, status, permissions } = body

  if (name || email || role || status) {
    let hash: string | null = null
    if (password && password.length >= 6) {
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')
      const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + password))
      hash = `${salt}:${Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')}`
    }
    await DB.prepare(`
      UPDATE admin_users SET
        name         = COALESCE(?, name),
        email        = COALESCE(?, email),
        password_hash= CASE WHEN ? IS NOT NULL THEN ? ELSE password_hash END,
        role         = COALESCE(?, role),
        status       = COALESCE(?, status),
        updated_at   = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(name ?? null, email?.toLowerCase() ?? null, hash, hash, role ?? null, status ?? null, id).run()
  }

  // Atualiza permissões — limpa e recria
  if (Array.isArray(permissions)) {
    await DB.prepare(`DELETE FROM admin_permissions WHERE admin_id = ?`).bind(id).run()
    for (const perm of permissions) {
      await DB.prepare(`INSERT OR REPLACE INTO admin_permissions (admin_id, permission, granted) VALUES (?,?,1)`)
        .bind(id, perm).run()
    }
  }
  return c.json({ ok: true })
})

// ── DELETE /admin/api/admin-users/:id — Remover admin ─────
admin.delete('/api/admin-users/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  await DB.prepare(`DELETE FROM admin_users WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// ── GET /admin/api/login-history — Histórico de logins ────
admin.get('/api/login-history', async (c) => {
  const { DB } = c.env
  const page    = Math.max(1, parseInt(c.req.query('page')  || '1'))
  const type    = c.req.query('type')  || ''   // 'admin' | 'member' | ''
  const search  = c.req.query('q')     || ''
  const perPage = 50

  const offset = (page - 1) * perPage

  // ── Admins: login sessions ───────────────────────────────
  // Junta admin_sessions com admin_users pelo email (campo admin_user)
  const adminRows = type === 'member' ? [] : (await DB.prepare(`
    SELECT
      's:' || s.token                    AS id,
      'admin'                            AS login_type,
      COALESCE(au.name, s.admin_user)    AS display_name,
      COALESCE(au.email, s.admin_user)   AS email,
      COALESCE(au.role, 'admin')         AS role,
      s.ip_hash,
      s.user_agent,
      s.created_at,
      s.expires_at,
      CASE WHEN s.is_valid = 1 AND s.expires_at > datetime('now') THEN 'active'
           WHEN s.is_valid = 0 THEN 'revogada'
           ELSE 'expirada' END           AS session_status
    FROM admin_sessions s
    LEFT JOIN admin_users au ON lower(au.email) = lower(s.admin_user)
    ${search ? `WHERE (au.name LIKE ? OR au.email LIKE ? OR s.admin_user LIKE ?)` : ''}
    ORDER BY s.created_at DESC
    LIMIT 500
  `).bind(...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [])).all<any>()).results || []

  // ── Members: últimos logins (oauth_users) ────────────────
  const memberRows = type === 'admin' ? [] : (await DB.prepare(`
    SELECT
      'm:' || u.id                       AS id,
      'member'                           AS login_type,
      COALESCE(u.full_name, u.email)     AS display_name,
      u.email,
      u.auth_provider                    AS role,
      NULL                               AS ip_hash,
      NULL                               AS user_agent,
      u.last_login_at                    AS created_at,
      u.session_expires_at               AS expires_at,
      CASE WHEN u.session_expires_at > datetime('now') THEN 'active'
           ELSE 'expirada' END           AS session_status
    FROM oauth_users u
    WHERE u.last_login_at IS NOT NULL
      ${search ? `AND (u.full_name LIKE ? OR u.email LIKE ?)` : ''}
    ORDER BY u.last_login_at DESC
    LIMIT 500
  `).bind(...(search ? [`%${search}%`, `%${search}%`] : [])).all<any>()).results || []

  // ── Merge, ordenar e paginar ──────────────────────────────
  const all = [...adminRows, ...memberRows].sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0
    const db = b.created_at ? new Date(b.created_at).getTime() : 0
    return db - da
  })

  const total = all.length
  const rows  = all.slice(offset, offset + perPage)

  // ── Contadores de sumário ─────────────────────────────────
  const totalAdmins  = adminRows.length
  const totalMembers = memberRows.length
  const totalActive  = all.filter(r => r.session_status === 'active').length

  return c.json({ rows, total, page, per_page: perPage, totalAdmins, totalMembers, totalActive })
})

// ── DELETE /admin/api/login-history/:token — Revogar sessão
admin.delete('/api/login-history/:token', async (c) => {
  const { DB } = c.env
  const raw = c.req.param('token')   // prefixo 's:' para sessões admin
  if (!raw.startsWith('s:')) return c.json({ error: 'Apenas sessões admin podem ser revogadas' }, 400)
  const token = raw.slice(2)
  await DB.prepare(`UPDATE admin_sessions SET is_valid = 0 WHERE token = ?`).bind(token).run()
  return c.json({ ok: true })
})

// ============================================================
// SOCIAL MEDIA — Helpers + CRUD Accounts + CRUD Posts + Cron
// ============================================================

// ── Helper: XOR encrypt/decrypt para tokens ───────────────
function xorCrypt(text: string, key: string): string {
  if (!text || !key) return text
  const keyBytes = new TextEncoder().encode(key)
  const textBytes = new TextEncoder().encode(text)
  const out = new Uint8Array(textBytes.length)
  for (let i = 0; i < textBytes.length; i++) {
    out[i] = textBytes[i] ^ keyBytes[i % keyBytes.length]
  }
  // Base64url encode
  return btoa(String.fromCharCode(...out))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function xorDecrypt(encoded: string, key: string): string {
  if (!encoded || !key) return encoded
  // Desfaz base64url
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - encoded.length % 4) % 4)
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const keyBytes = new TextEncoder().encode(key)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ keyBytes[i % keyBytes.length]
  }
  return new TextDecoder().decode(out)
}

function getXorKey(env: any): string {
  return (env as any).SOCIAL_XOR_KEY || 'kainow-radar-xor-default-2025'
}

// ── Helper: Gera ID curto para social_accounts ────────────
function genSocialId(): string {
  return 'sa_' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Integrações por plataforma ────────────────────────────

async function postToInstagram(account: any, text: string, imageUrl?: string): Promise<{ ok: boolean; post_id?: string; url?: string; error?: string }> {
  // Instagram Graph API — requer ig_user_id + access_token
  const igUserId = account.ig_user_id
  const token = account.access_token
  if (!igUserId || !token) return { ok: false, error: 'ig_user_id e access_token são obrigatórios para Instagram' }

  try {
    // Passo 1: Criar container de mídia (com ou sem imagem)
    const mediaParams: Record<string, string> = {
      caption: text,
      access_token: token,
    }
    if (imageUrl) {
      mediaParams.image_url = imageUrl
      mediaParams.media_type = 'IMAGE'
    } else {
      // Post de texto (feed normal sem mídia requer imagem — usar carousel ou reel seria necessário)
      // Para simplificar, usamos media_type IMAGE com imagem de placeholder ou retornamos erro
      return { ok: false, error: 'Instagram requer imagem para publicar no feed' }
    }

    const containerRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mediaParams),
    })
    const containerData = await containerRes.json() as any
    if (!containerRes.ok || !containerData.id) {
      return { ok: false, error: containerData?.error?.message || 'Erro ao criar container' }
    }

    // Passo 2: Publicar container
    const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerData.id, access_token: token }),
    })
    const publishData = await publishRes.json() as any
    if (!publishRes.ok || !publishData.id) {
      return { ok: false, error: publishData?.error?.message || 'Erro ao publicar no Instagram' }
    }

    return { ok: true, post_id: publishData.id, url: `https://www.instagram.com/p/${publishData.id}/` }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

async function postToFacebook(account: any, text: string, imageUrl?: string, linkUrl?: string): Promise<{ ok: boolean; post_id?: string; url?: string; error?: string }> {
  const pageId = account.page_id || account.account_id
  const token = account.access_token
  if (!pageId || !token) return { ok: false, error: 'page_id e access_token são obrigatórios para Facebook' }

  try {
    const body: Record<string, string> = { message: text, access_token: token }
    let endpoint = `https://graph.facebook.com/v19.0/${pageId}/feed`

    if (imageUrl) {
      endpoint = `https://graph.facebook.com/v19.0/${pageId}/photos`
      body.url = imageUrl
      body.caption = text
    } else if (linkUrl) {
      body.link = linkUrl
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as any
    if (!res.ok || !data.id) {
      return { ok: false, error: data?.error?.message || 'Erro ao publicar no Facebook' }
    }

    const [pid, eid] = (data.id as string).split('_')
    const postUrl = eid
      ? `https://www.facebook.com/permalink.php?story_fbid=${eid}&id=${pid}`
      : `https://www.facebook.com/${data.id}`

    return { ok: true, post_id: data.id, url: postUrl }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

async function postToX(account: any, text: string, _imageUrl?: string): Promise<{ ok: boolean; post_id?: string; url?: string; error?: string }> {
  const token = account.access_token        // OAuth 2.0 user access token
  const apiKey = account.token_secret       // reutilizamos token_secret para API Key / Bearer Token
  const bearerToken = apiKey || token
  if (!bearerToken) return { ok: false, error: 'Bearer Token ou Access Token obrigatórios para X/Twitter' }

  try {
    const res = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ text }),
    })
    const data = await res.json() as any
    if (!res.ok || !data?.data?.id) {
      return { ok: false, error: data?.detail || data?.errors?.[0]?.message || 'Erro ao publicar no X/Twitter' }
    }

    const tweetId = data.data.id
    const handle = account.account_name?.replace('@', '') || 'i'
    return { ok: true, post_id: tweetId, url: `https://x.com/${handle}/status/${tweetId}` }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

async function postToLinkedIn(account: any, text: string, imageUrl?: string): Promise<{ ok: boolean; post_id?: string; url?: string; error?: string }> {
  const token = account.access_token
  const personId = account.account_id     // urn:li:person:{id} ou urn:li:organization:{id}
  if (!token || !personId) return { ok: false, error: 'access_token e account_id (URN) obrigatórios para LinkedIn' }

  try {
    // URN do autor — se não começar com urn: tenta montar
    const author = personId.startsWith('urn:') ? personId : `urn:li:person:${personId}`

    const shareContent: any = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: imageUrl ? 'IMAGE' : 'NONE',
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    }

    // Imagem no LinkedIn requer upload prévio via Assets API — simplificado: apenas link
    if (imageUrl) {
      shareContent.specificContent['com.linkedin.ugc.ShareContent'].media = [{
        status: 'READY',
        originalUrl: imageUrl,
      }]
    }

    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(shareContent),
    })
    const data = await res.json() as any
    if (!res.ok) {
      return { ok: false, error: data?.message || data?.status?.toString() || 'Erro ao publicar no LinkedIn' }
    }

    const postId = res.headers.get('x-restli-id') || data?.id || ''
    return { ok: true, post_id: postId, url: `https://www.linkedin.com/feed/update/${postId}/` }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ── Dispatcher: publica um post em sua plataforma ─────────
async function dispatchPost(account: any, post: any): Promise<{ ok: boolean; post_id?: string; url?: string; error?: string }> {
  const platform = post.platform || account.platform
  const text = [post.content_text, post.hashtags].filter(Boolean).join('\n\n')

  switch (platform) {
    case 'instagram': return postToInstagram(account, text, post.image_url)
    case 'facebook':  return postToFacebook(account, text, post.image_url, post.link_url)
    case 'x':         return postToX(account, text, post.image_url)
    case 'linkedin':  return postToLinkedIn(account, text, post.image_url)
    default: return { ok: false, error: `Plataforma desconhecida: ${platform}` }
  }
}

// ── GET /admin/api/social-accounts ───────────────────────
admin.get('/api/social-accounts', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT id, platform, account_name, account_id, page_id, ig_user_id,
           token_expires_at, is_active, last_test_at, last_test_ok, last_test_msg,
           created_at, updated_at
    FROM social_accounts ORDER BY platform, account_name
  `).all()
  return c.json(results)
})

// ── POST /admin/api/social-accounts — Conectar conta ─────
admin.post('/api/social-accounts', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const { platform, account_name, account_id, access_token, token_secret,
          refresh_token, page_id, ig_user_id, token_expires_at } = body

  if (!platform || !account_name) return c.json({ error: 'platform e account_name obrigatórios' }, 400)

  const key = getXorKey(c.env)
  const id = genSocialId()

  await DB.prepare(`
    INSERT INTO social_accounts
      (id, platform, account_name, account_id, access_token, token_secret,
       refresh_token, page_id, ig_user_id, token_expires_at, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)
  `).bind(
    id, platform, account_name,
    account_id || null,
    access_token ? xorCrypt(access_token, key) : null,
    token_secret ? xorCrypt(token_secret, key) : null,
    refresh_token ? xorCrypt(refresh_token, key) : null,
    page_id || null,
    ig_user_id || null,
    token_expires_at || null
  ).run()

  return c.json({ ok: true, id })
})

// ── PATCH /admin/api/social-accounts/:id — Editar conta ──
admin.patch('/api/social-accounts/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as any
  const { account_name, account_id, access_token, token_secret,
          refresh_token, page_id, ig_user_id, token_expires_at, is_active } = body

  const key = getXorKey(c.env)

  await DB.prepare(`
    UPDATE social_accounts SET
      account_name     = COALESCE(?, account_name),
      account_id       = COALESCE(?, account_id),
      access_token     = CASE WHEN ? IS NOT NULL THEN ? ELSE access_token END,
      token_secret     = CASE WHEN ? IS NOT NULL THEN ? ELSE token_secret END,
      refresh_token    = CASE WHEN ? IS NOT NULL THEN ? ELSE refresh_token END,
      page_id          = COALESCE(?, page_id),
      ig_user_id       = COALESCE(?, ig_user_id),
      token_expires_at = COALESCE(?, token_expires_at),
      is_active        = COALESCE(?, is_active),
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    account_name ?? null,
    account_id ?? null,
    access_token ? 'y' : null, access_token ? xorCrypt(access_token, key) : null,
    token_secret ? 'y' : null, token_secret ? xorCrypt(token_secret, key) : null,
    refresh_token ? 'y' : null, refresh_token ? xorCrypt(refresh_token, key) : null,
    page_id ?? null,
    ig_user_id ?? null,
    token_expires_at ?? null,
    is_active ?? null,
    id
  ).run()

  return c.json({ ok: true })
})

// ── POST /admin/api/social-accounts/:id/test — Testar token
admin.post('/api/social-accounts/:id/test', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const key = getXorKey(c.env)

  const row = await DB.prepare(`SELECT * FROM social_accounts WHERE id = ?`).bind(id).first<any>()
  if (!row) return c.json({ error: 'Conta não encontrada' }, 404)

  const account = {
    ...row,
    access_token: row.access_token ? xorDecrypt(row.access_token, key) : null,
    token_secret: row.token_secret ? xorDecrypt(row.token_secret, key) : null,
    refresh_token: row.refresh_token ? xorDecrypt(row.refresh_token, key) : null,
  }

  let ok = false
  let msg = ''

  try {
    if (row.platform === 'instagram') {
      const igId = account.ig_user_id
      if (!igId || !account.access_token) throw new Error('ig_user_id e access_token obrigatórios')
      const res = await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=id,name,username&access_token=${account.access_token}`)
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.error?.message || 'Token inválido')
      ok = true; msg = `Conectado como @${data.username || data.name}`
    } else if (row.platform === 'facebook') {
      const pageId = account.page_id || account.account_id
      if (!pageId || !account.access_token) throw new Error('page_id e access_token obrigatórios')
      const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=id,name&access_token=${account.access_token}`)
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.error?.message || 'Token inválido')
      ok = true; msg = `Página: ${data.name}`
    } else if (row.platform === 'x') {
      const bearer = account.token_secret || account.access_token
      if (!bearer) throw new Error('Bearer Token obrigatório')
      const res = await fetch('https://api.twitter.com/2/users/me', {
        headers: { 'Authorization': `Bearer ${bearer}` }
      })
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.detail || 'Token inválido')
      ok = true; msg = `Conectado como @${data?.data?.username || '?'}`
    } else if (row.platform === 'linkedin') {
      if (!account.access_token) throw new Error('Access Token obrigatório')
      const res = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${account.access_token}` }
      })
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.message || 'Token inválido')
      ok = true; msg = `Conectado como ${data?.name || data?.sub || '?'}`
    } else {
      throw new Error(`Plataforma ${row.platform} não suportada para teste`)
    }
  } catch (e: any) {
    ok = false; msg = e.message
  }

  await DB.prepare(`
    UPDATE social_accounts SET last_test_at = CURRENT_TIMESTAMP, last_test_ok = ?, last_test_msg = ? WHERE id = ?
  `).bind(ok ? 1 : 0, msg, id).run()

  return c.json({ ok, message: msg })
})

// ── DELETE /admin/api/social-accounts/:id ────────────────
admin.delete('/api/social-accounts/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  await DB.prepare(`DELETE FROM social_accounts WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// ── GET /admin/api/social-posts — Lista posts ─────────────
admin.get('/api/social-posts', async (c) => {
  const { DB } = c.env
  const status  = c.req.query('status') || ''
  const platform = c.req.query('platform') || ''
  const page    = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = 20
  const offset  = (page - 1) * perPage

  let where = 'WHERE 1=1'
  const binds: any[] = []
  if (status)   { where += ' AND sp.status = ?';   binds.push(status) }
  if (platform) { where += ' AND sp.platform = ?'; binds.push(platform) }

  const [count, data] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total FROM social_posts sp ${where}`).bind(...binds).first<{ total: number }>(),
    DB.prepare(`
      SELECT sp.*, sa.account_name, sa.platform as acc_platform
      FROM social_posts sp
      LEFT JOIN social_accounts sa ON sa.id = sp.account_id
      ${where}
      ORDER BY COALESCE(sp.scheduled_at, sp.created_at) DESC
      LIMIT ? OFFSET ?
    `).bind(...binds, perPage, offset).all()
  ])

  return c.json({ posts: data.results, total: count?.total || 0, page, per_page: perPage })
})

// ── POST /admin/api/social-posts — Criar / Agendar post ──
admin.post('/api/social-posts', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const { account_id, platform, content_text, image_url, link_url,
          hashtags, ai_generated, ai_prompt, status, scheduled_at } = body

  if (!account_id || !content_text) return c.json({ error: 'account_id e content_text obrigatórios' }, 400)

  // Se publish_now — publica imediatamente
  if (status === 'publish_now') {
    const key = getXorKey(c.env)
    const row = await DB.prepare(`SELECT * FROM social_accounts WHERE id = ?`).bind(account_id).first<any>()
    if (!row) return c.json({ error: 'Conta não encontrada' }, 404)

    const account = {
      ...row,
      access_token: row.access_token ? xorDecrypt(row.access_token, key) : null,
      token_secret: row.token_secret ? xorDecrypt(row.token_secret, key) : null,
    }
    const postData = { platform: platform || row.platform, content_text, image_url, link_url, hashtags }
    const result = await dispatchPost(account, postData)

    const newStatus = result.ok ? 'published' : 'failed'
    const { meta } = await DB.prepare(`
      INSERT INTO social_posts
        (account_id, platform, content_text, image_url, link_url, hashtags,
         ai_generated, ai_prompt, status, published_at, error_message,
         platform_post_id, platform_post_url, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?)
    `).bind(
      account_id, platform || row.platform, content_text,
      image_url || null, link_url || null, hashtags || null,
      ai_generated ? 1 : 0, ai_prompt || null,
      newStatus,
      result.error || null, result.post_id || null, result.url || null,
      'admin'
    ).run()

    return c.json({ ok: result.ok, id: meta.last_row_id, post_id: result.post_id, url: result.url, error: result.error })
  }

  // Agendar ou rascunho
  const finalStatus = scheduled_at ? 'scheduled' : (status || 'draft')
  const { meta } = await DB.prepare(`
    INSERT INTO social_posts
      (account_id, platform, content_text, image_url, link_url, hashtags,
       ai_generated, ai_prompt, status, scheduled_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    account_id, platform, content_text,
    image_url || null, link_url || null, hashtags || null,
    ai_generated ? 1 : 0, ai_prompt || null,
    finalStatus, scheduled_at || null, 'admin'
  ).run()

  return c.json({ ok: true, id: meta.last_row_id })
})

// ── PATCH /admin/api/social-posts/:id — Editar post ──────
admin.patch('/api/social-posts/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any
  const { content_text, image_url, link_url, hashtags, status, scheduled_at } = body

  await DB.prepare(`
    UPDATE social_posts SET
      content_text = COALESCE(?, content_text),
      image_url    = COALESCE(?, image_url),
      link_url     = COALESCE(?, link_url),
      hashtags     = COALESCE(?, hashtags),
      status       = COALESCE(?, status),
      scheduled_at = COALESCE(?, scheduled_at),
      updated_at   = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    content_text ?? null, image_url ?? null, link_url ?? null,
    hashtags ?? null, status ?? null, scheduled_at ?? null, id
  ).run()

  return c.json({ ok: true })
})

// ── DELETE /admin/api/social-posts/:id ───────────────────
admin.delete('/api/social-posts/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  await DB.prepare(`DELETE FROM social_posts WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// ── POST /admin/api/social/cron — Dispatcher agendados ───
// Chamado pelo Cloudflare Cron Trigger OU manualmente via botão
admin.post('/api/social/cron', async (c) => {
  const { DB } = c.env
  const key = getXorKey(c.env)

  // Busca posts agendados que já passaram do horário
  const { results: due } = await DB.prepare(`
    SELECT sp.*, sa.access_token, sa.token_secret, sa.refresh_token,
           sa.page_id, sa.ig_user_id, sa.account_id as sa_account_id
    FROM social_posts sp
    JOIN social_accounts sa ON sa.id = sp.account_id
    WHERE sp.status = 'scheduled'
      AND sp.scheduled_at <= CURRENT_TIMESTAMP
      AND sa.is_active = 1
    ORDER BY sp.scheduled_at ASC
    LIMIT 10
  `).all<any>()

  if (!due.length) return c.json({ ok: true, published: 0, message: 'Nenhum post agendado para publicar agora' })

  let published = 0
  let failed = 0
  const results: any[] = []

  for (const post of due) {
    const account = {
      ...post,
      access_token: post.access_token ? xorDecrypt(post.access_token, key) : null,
      token_secret: post.token_secret ? xorDecrypt(post.token_secret, key) : null,
      refresh_token: post.refresh_token ? xorDecrypt(post.refresh_token, key) : null,
    }

    // Marca como "publishing" para evitar dupla execução
    await DB.prepare(`UPDATE social_posts SET status = 'publishing' WHERE id = ?`).bind(post.id).run()

    const result = await dispatchPost(account, post)

    if (result.ok) {
      await DB.prepare(`
        UPDATE social_posts SET
          status = 'published', published_at = CURRENT_TIMESTAMP,
          platform_post_id = ?, platform_post_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(result.post_id || null, result.url || null, post.id).run()
      published++
    } else {
      await DB.prepare(`
        UPDATE social_posts SET
          status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(result.error || 'Erro desconhecido', post.id).run()
      failed++
    }

    results.push({ id: post.id, platform: post.platform, ok: result.ok, error: result.error })
  }

  return c.json({ ok: true, published, failed, results })
})

// ── POST /admin/api/social/ai-generate — IA gera conteúdo ─
admin.post('/api/social/ai-generate', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const { platform, tone, include_price, include_hashtags, custom_prompt } = body

  // Busca top 5 produtos mais baratos com desconto
  const { results: topProducts } = await DB.prepare(`
    SELECT p.name, p.brand, p.category,
           MIN(o.price) as price, o2.original_price,
           o2.discount_percent, s.name as store_name
    FROM products p
    JOIN offers o ON o.product_id = p.id AND o.is_active = 1 AND o.in_stock = 1
    JOIN offers o2 ON o2.product_id = p.id
      AND o2.price = (SELECT MIN(o3.price) FROM offers o3 WHERE o3.product_id = p.id AND o3.is_active = 1 AND o3.in_stock = 1)
      AND o2.is_active = 1 AND o2.in_stock = 1
    JOIN stores s ON s.id = o2.store_id
    WHERE p.is_active = 1 AND o2.discount_percent >= 5
    GROUP BY p.id
    ORDER BY o2.discount_percent DESC
    LIMIT 5
  `).all<any>()

  if (!topProducts.length) {
    return c.json({ error: 'Nenhum produto com desconto encontrado para gerar conteúdo' }, 400)
  }

  // Formata lista de produtos para o contexto da IA
  const fBRL = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`
  const productList = topProducts.map((p, i) => {
    const parts = [`${i + 1}. ${p.name}${p.brand ? ` (${p.brand})` : ''}`]
    if (include_price !== false && p.price) parts.push(`por ${fBRL(p.price)}`)
    if (p.discount_percent) parts.push(`${Math.round(p.discount_percent)}% OFF`)
    if (p.store_name) parts.push(`na ${p.store_name}`)
    return parts.join(' ')
  }).join('\n')

  const platformGuide: Record<string, string> = {
    instagram: 'Tom visual e inspirador, use emojis, até 2.200 caracteres. Hashtags no final.',
    facebook: 'Tom conversacional e informativo, até 500 caracteres ideais. CTA claro.',
    x: 'Conciso e direto, máximo 280 caracteres. 1-2 hashtags no máximo.',
    linkedin: 'Tom profissional, foque em economia e valor. Sem muitos emojis.',
  }

  const toneMap: Record<string, string> = {
    urgente: 'urgente e com senso de escassez',
    animado: 'animado e empolgante com muitos emojis',
    profissional: 'profissional e informativo',
    descontraido: 'descontraído e amigável, como um amigo dando dica',
  }

  const platformHint = platformGuide[platform] || 'Tom equilibrado e atraente.'
  const toneHint = toneMap[tone] || 'natural e atraente'

  const aiKey = (c.env as any).OPENAI_API_KEY || ''

  if (!aiKey) {
    // Fallback: gera conteúdo template sem IA
    const emoji: Record<string, string> = { instagram: '📸', facebook: '🛍️', x: '🔥', linkedin: '💡' }
    const e = emoji[platform] || '🛒'
    const top = topProducts[0]
    let text = ''

    if (platform === 'x') {
      text = `${e} OFERTA: ${top.name} por ${fBRL(top.price)} (${Math.round(top.discount_percent)}% OFF) na ${top.store_name}! No KainowRadar você compara e economiza.`
      if (text.length > 280) text = text.slice(0, 277) + '...'
    } else {
      text = `${e} As melhores ofertas de hoje no KainowRadar!\n\n${productList}\n\nCompare preços e economize! [Busca] kainowradar.com`
    }

    const hashtags = include_hashtags !== false
      ? '#oferta #desconto #kainowradar #economize #promoção'
      : ''

    return c.json({
      ok: true,
      ai_generated: false,
      content_text: text,
      hashtags,
      prompt_used: 'template',
      products_used: topProducts.map(p => p.name),
    })
  }

  // Chama OpenAI para gerar conteúdo real
  const systemPrompt = `Você é um especialista em marketing digital para e-commerce brasileiro.
Crie posts para redes sociais divulgando ofertas de produtos.
Idioma: Português do Brasil.
Plataforma: ${platform?.toUpperCase() || 'GENÉRICA'} — ${platformHint}
Tom: ${toneHint}.
${include_hashtags !== false ? 'Inclua hashtags relevantes separadas por espaço no campo hashtags.' : 'Não inclua hashtags.'}`

  const userPrompt = custom_prompt
    ? `${custom_prompt}\n\nProdutos disponíveis:\n${productList}`
    : `Crie um post para ${platform} divulgando estas ofertas do KainowRadar:\n\n${productList}\n\nIncluir preços: ${include_price !== false ? 'sim' : 'não'}. Tom: ${toneHint}.`

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt + '\n\nResponda APENAS com JSON: {"content_text":"...","hashtags":"..."}' }
        ],
        temperature: 0.8,
        max_tokens: 600,
      }),
    })

    const aiData = await aiRes.json() as any
    const raw = aiData?.choices?.[0]?.message?.content || ''

    // Extrai JSON da resposta
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('IA não retornou JSON válido')
    const parsed = JSON.parse(jsonMatch[0])

    return c.json({
      ok: true,
      ai_generated: true,
      content_text: parsed.content_text || '',
      hashtags: parsed.hashtags || '',
      prompt_used: userPrompt,
      products_used: topProducts.map(p => p.name),
    })
  } catch (e: any) {
    return c.json({ error: `Erro na geração por IA: ${e.message}` }, 500)
  }
})

// ── GET /admin/api/price-history/:productId ───────────────
admin.get('/api/price-history/:productId', async (c) => {
  const { DB } = c.env
  const productId = parseInt(c.req.param('productId'))
  const days = parseInt(c.req.query('days') || '30')

  const { results } = await DB.prepare(`
    SELECT ph.price, ph.in_stock, ph.recorded_at,
           s.name as store_name, s.slug as store_slug
    FROM price_history ph
    JOIN stores s ON s.id = ph.store_id
    WHERE ph.product_id = ? AND ph.recorded_at >= date('now', ?)
    ORDER BY ph.recorded_at ASC
    LIMIT 500
  `).bind(productId, `-${days} days`).all()

  return c.json(results)
})

// ── GET /admin/api/queue — Fila de atualização ────────────
admin.get('/api/queue', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT pq.*, o.external_id, p.name as product_name, s.name as store_name
    FROM price_update_queue pq
    JOIN offers o ON o.id = pq.offer_id
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    ORDER BY pq.priority ASC, pq.scheduled_for ASC
    LIMIT 50
  `).all()
  return c.json(results)
})

// ── GET /admin/api/clicks — Analytics de cliques ─────────
admin.get('/api/clicks', async (c) => {
  const { DB } = c.env
  const days = parseInt(c.req.query('days') || '7')

  const [byDay, byStore, byProduct] = await Promise.all([
    DB.prepare(`
      SELECT date(clicked_at) as day, COUNT(*) as clicks
      FROM click_events WHERE clicked_at >= date('now', ?)
      GROUP BY day ORDER BY day ASC
    `).bind(`-${days} days`).all(),
    DB.prepare(`
      SELECT s.name as store, s.slug, COUNT(ce.id) as clicks
      FROM click_events ce
      JOIN stores s ON s.id = ce.store_id
      WHERE ce.clicked_at >= date('now', ?)
      GROUP BY s.id ORDER BY clicks DESC LIMIT 10
    `).bind(`-${days} days`).all(),
    DB.prepare(`
      SELECT p.name, p.slug, COUNT(ce.id) as clicks
      FROM click_events ce
      JOIN products p ON p.id = ce.product_id
      WHERE ce.clicked_at >= date('now', ?)
      GROUP BY p.id ORDER BY clicks DESC LIMIT 10
    `).bind(`-${days} days`).all(),
  ])

  return c.json({ byDay: byDay.results, byStore: byStore.results, byProduct: byProduct.results })
})

// ── GET /admin/api/footer-config ─────────────────────────
admin.get('/api/footer-config', async (c) => {
  const { DB } = c.env
  try {
    const { results } = await DB.prepare(
      `SELECT section, key, value, is_visible, sort_order FROM footer_config ORDER BY section, sort_order ASC`
    ).all<any>()
    return c.json({ ok: true, rows: results || [] })
  } catch {
    return c.json({ ok: false, rows: [], error: 'Tabela footer_config não encontrada. Execute a migration 0016.' }, 200)
  }
})

// ── PUT /admin/api/footer-config/:section/:key ────────────
admin.put('/api/footer-config/:section/:key', async (c) => {
  const { DB } = c.env
  const section = c.req.param('section')
  const key     = decodeURIComponent(c.req.param('key'))
  const body    = await c.req.json().catch(() => ({})) as any

  const value      = body.value      !== undefined ? String(body.value) : null
  const is_visible = body.is_visible !== undefined ? (body.is_visible ? 1 : 0) : 1
  const sort_order = body.sort_order !== undefined ? Number(body.sort_order) : 0

  await DB.prepare(`
    INSERT INTO footer_config (section, key, value, is_visible, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(section, key) DO UPDATE SET
      value      = excluded.value,
      is_visible = excluded.is_visible,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `).bind(section, key, value, is_visible, sort_order).run()

  return c.json({ ok: true, section, key })
})

// ── DELETE /admin/api/footer-config/:section/:key ─────────
admin.delete('/api/footer-config/:section/:key', async (c) => {
  const { DB } = c.env
  const section = c.req.param('section')
  const key     = decodeURIComponent(c.req.param('key'))
  await DB.prepare(`DELETE FROM footer_config WHERE section = ? AND key = ?`).bind(section, key).run()
  return c.json({ ok: true })
})

// ── POST /admin/api/footer-config/:section — adiciona item ─
admin.post('/api/footer-config/:section', async (c) => {
  const { DB } = c.env
  const section = c.req.param('section')
  const body    = await c.req.json().catch(() => ({})) as any

  const key        = String(body.key || '').trim()
  const value      = body.value !== undefined ? String(body.value) : null
  const is_visible = body.is_visible !== undefined ? (body.is_visible ? 1 : 0) : 1
  const sort_order = body.sort_order !== undefined ? Number(body.sort_order) : 99

  if (!key) return c.json({ error: 'key é obrigatório' }, 400)

  await DB.prepare(`
    INSERT INTO footer_config (section, key, value, is_visible, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(section, key) DO UPDATE SET
      value      = excluded.value,
      is_visible = excluded.is_visible,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `).bind(section, key, value, is_visible, sort_order).run()

  return c.json({ ok: true, section, key })
})

// ── GET /admin/api/affiliate-bot/status — Progresso ──────
admin.get('/api/affiliate-bot/status', async (c) => {
  const { DB } = c.env
  const [total, withAffiliate, withMlId] = await Promise.all([
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1").first<any>(),
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1 AND affiliate_url IS NOT NULL AND affiliate_url != ''").first<any>(),
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1 AND ml_item_id IS NOT NULL AND ml_item_id != ''").first<any>(),
  ])
  return c.json({
    total: total?.n || 0,
    with_affiliate: withAffiliate?.n || 0,
    with_ml_id: withMlId?.n || 0,
    pending: (total?.n || 0) - (withAffiliate?.n || 0),
  })
})

// ── GET /admin/api/affiliate-bot/products — Lista produtos ─
admin.get('/api/affiliate-bot/products', async (c) => {
  const { DB } = c.env
  const page = parseInt(c.req.query('page') || '1')
  const perPage = 20
  const offset = (page - 1) * perPage
  const filter = c.req.query('filter') || 'all' // all | missing | done

  let where = 'WHERE is_active = 1'
  if (filter === 'missing') where += " AND (affiliate_url IS NULL OR affiliate_url = '')"
  if (filter === 'done')    where += " AND affiliate_url IS NOT NULL AND affiliate_url != ''"

  const { results } = await DB.prepare(`
    SELECT id, name, slug, brand, category, best_price, ml_item_id, affiliate_url, affiliate_updated_at
    FROM products ${where}
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `).bind(perPage, offset).all<any>()

  const count = await DB.prepare(`SELECT COUNT(*) as n FROM products ${where}`).first<any>()

  return c.json({ results, total: count?.n || 0, page, per_page: perPage })
})

// ── POST /admin/api/affiliate-bot/search — Busca ML ───────
// Consulta a API pública do ML e retorna o melhor match
admin.post('/api/affiliate-bot/search', async (c) => {
  const { query, product_id } = await c.req.json()
  if (!query) return c.json({ error: 'Query obrigatória' }, 400)

  const PUBLISHER_ID = 'cfegdhabc31955'

  try {
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=5`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'KainowRadar/1.0' }
    })
    if (!res.ok) return c.json({ error: `ML API error: ${res.status}` }, 502)

    const data: any = await res.json()
    const items = (data.results || []).map((item: any) => ({
      ml_id: item.id,
      title: item.title,
      price: item.price,
      permalink: item.permalink,
      thumbnail: item.thumbnail,
      affiliate_url: `${item.permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow`,
    }))

    return c.json({ items, query })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── POST /admin/api/affiliate-bot/apply — Salva link ──────
admin.post('/api/affiliate-bot/apply', async (c) => {
  const { product_id, ml_item_id, affiliate_url } = await c.req.json()
  if (!product_id || !affiliate_url) return c.json({ error: 'product_id e affiliate_url obrigatórios' }, 400)

  const { DB } = c.env
  await DB.prepare(`
    UPDATE products
    SET ml_item_id = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(ml_item_id || null, affiliate_url, product_id).run()

  return c.json({ ok: true })
})

// ── POST /admin/api/stores/ml/import-affiliate-links ────────────
// Recebe bloco de texto ou CSV com links meli.la/... ou links ML longos
//
// LÓGICA:
//  - Links meli.la/... já SÃO links de afiliado gerados pelo programa ML
//    → salvar como affiliate_url diretamente (não precisam de resolução)
//  - Links longos do ML (mercadolivre.com.br/...) com MLB... na URL
//    → extrair MLB ID + injetar parâmetros matt_word/matt_tool
//  - Tenta vincular ao produto existente no banco via ml_item_id
//    → para links meli.la, tenta descobrir o MLB via API ML (GET /items)
admin.post('/api/stores/ml/import-affiliate-links', async (c) => {
  const { DB } = c.env
  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '61674414'

  const body = await c.req.json().catch(() => ({}))
  const raw: string = body.links || ''

  if (!raw.trim()) return c.json({ error: 'Nenhum link enviado' }, 400)

  // Extrai todas as URLs do bloco (suporta CSV, TXT, quebra de linha, espaços, tab)
  const urlRegex = /https?:\/\/[^\s,;"'<>\n\r\t]+/g
  const urls = Array.from(new Set(
    (raw.match(urlRegex) || []).map(u => u.replace(/[.,;)>\]]+$/, '').trim())
  )).filter(Boolean)

  if (urls.length === 0) return c.json({ error: 'Nenhuma URL válida encontrada' }, 400)
  if (urls.length > 500) return c.json({ error: 'Máximo 500 links por importação' }, 400)

  // ── Helpers ─────────────────────────────────────────────────

  // Detecta se é link curto de afiliado ML (meli.la gerado pelo programa)
  function isShortAffiliateLink(url: string): boolean {
    return /meli\.la\/|mlv\.cl\/|merc\.ad\//i.test(url)
  }

  // Detecta se é link longo do ML com MLB na URL
  function isLongMlLink(url: string): boolean {
    return /mercadolivre\.com\.br|mercadopago\.com\.br|produto\.mercadolivre/i.test(url)
  }

  // Extrai MLB... de uma URL longa do ML
  function extractMlbId(url: string): string | null {
    const patterns = [
      /\/(MLB-?\d{7,12})/i,
      /item[_-]id=(MLB-?\d{7,12})/i,
      /product[_-]id=(MLB-?\d{7,12})/i,
      /-(MLB-?\d{7,12})[_\-\.]/i,
      /\/(MLB-?\d{7,12})$/i,
    ]
    for (const p of patterns) {
      const m = url.match(p)
      if (m) return m[1].replace(/-/g, '').toUpperCase()
    }
    return null
  }

  // Injeta parâmetros de rastreamento num link longo do ML
  function buildTrackedUrl(longUrl: string): string {
    try {
      const u = new URL(longUrl)
      u.searchParams.set('matt_word', PUBLISHER_ID)
      u.searchParams.set('matt_tool', MATT_TOOL)
      u.searchParams.set('forceInApp', 'true')
      return u.toString()
    } catch {
      return `${longUrl}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // FLUXO PYTHON → Cloudflare Worker:
  //   meli.la/xxx  →  follow redirect  →  URL real com MLB  →  API ML
  //   Retorna: { mlbId, title, price, image, longUrl }
  // ─────────────────────────────────────────────────────────────────
  async function resolveAndFetchML(shortUrl: string): Promise<{
    mlbId: string | null
    title: string | null
    price: number | null
    image: string | null
    longUrl: string | null
  }> {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    let longUrl:  string | null = null
    let mlbId:    string | null = null
    let htmlBody: string | null = null

    // ── Helper: extrai meta tag de HTML ──────────────────────────────
    const getMeta = (html: string, prop: string): string => {
      const m = html.match(
        new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
      ) || html.match(
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
      )
      return m ? m[1].trim() : ''
    }

    // ── Helper: extrai preço de texto (R$ 1.234,56 ou 1234.56) ───────
    const parsePrice = (s: string): number | null => {
      const m = s.match(/R\$\s*([\d]+(?:[.,][\d]{1,2})?)\s*$/)
      if (!m) return null
      const v = parseFloat(m[1].replace('.', '').replace(',', '.'))
      return isNaN(v) || v <= 0 ? null : v
    }

    // ── Etapa 1: segue redirect ───────────────────────────────────────
    // meli.la/xxx → mercadolivre.com.br/social/cfeg...?ref=<token_opaco>
    // O redirect HTTP FINAL é a página /social/ — não contém MLB na URL!
    try {
      const r = await fetch(shortUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      })
      longUrl  = r.url || null
      htmlBody = await r.text()
    } catch { /* ignora */ }

    // ── Etapa 2: tenta extrair MLB diretamente da URL resolvida ──────
    if (longUrl) mlbId = extractMlbId(longUrl)

    // ── Etapa 3: tenta query params (fo, matt_topic) da URL /social/ ─
    // Alguns links ainda usam fo=<URL_PRODUTO_ENCODED> nos params
    if (!mlbId && longUrl) {
      try {
        const socialUrl = new URL(longUrl)
        for (const key of ['fo', 'matt_topic', 'redirectTo', 'next', 'url']) {
          const raw = socialUrl.searchParams.get(key)
          if (!raw) continue
          let decoded = raw
          try { decoded = decodeURIComponent(raw)     } catch { /* ignora */ }
          try { decoded = decodeURIComponent(decoded) } catch { /* ignora */ }
          mlbId = extractMlbId(decoded)
          if (mlbId) { longUrl = decoded; break }
        }
      } catch { /* ignora */ }
    }

    // ── Etapa 4: extrai MLB, título, preço e imagem do HTML da página /social/ ───
    // A página /social/ é uma SPA React que já embute dados do produto nos polycards.
    // Estrutura observada no JSON inline:
    //   "id":"MLB6761523270","product_id":"MLB69487076",
    //   "current_price":{"value":20.99,...},
    //   "pictures":[{"url":"https://http2.mlstatic.com/..."}]
    // og:title e og:image também estão disponíveis nas meta tags.
    let ogTitle:  string | null = null
    let ogImage:  string | null = null
    let ogPrice:  number | null = null

    if (htmlBody) {
      // og: meta tags — título e imagem canônicos do produto
      ogTitle = getMeta(htmlBody, 'og:title') || null
      ogImage = getMeta(htmlBody, 'og:image') || null
      if (ogTitle) ogPrice = parsePrice(ogTitle)

      // ── Extrai preço do JSON de polycards (current_price.value) ──
      // Padrão: "current_price":{"value":20.99,...}
      if (!ogPrice) {
        const priceM = htmlBody.match(/"current_price"\s*:\s*\{"value"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/)
        if (priceM) {
          const v = Number(priceM[1])
          if (v > 0 && v < 1_000_000) ogPrice = v
        }
      }

      // ── MLB: procura "id":"MLB..." no JSON de polycards ──────────
      if (!mlbId) {
        const polyM = htmlBody.match(/"id"\s*:\s*"(MLB\d{7,12})"/)
        if (polyM) {
          mlbId = polyM[1]
          // Tenta reconstruir URL canônica a partir do campo "url" no polycard
          const urlM = htmlBody.match(/"url"\s*:\s*"(www\.mercadolivre\.com\.br[^"]+)"/)
          longUrl = urlM
            ? `https://${urlM[1].replace(/\\u002F/g, '/')}`
            : `https://www.mercadolivre.com.br/p/${mlbId}`
        }
      }

      // Fallback: qualquer MLB com 9+ dígitos no HTML
      if (!mlbId) {
        const anyM = htmlBody.match(/\b(MLB\d{9,12})\b/)
        if (anyM) {
          mlbId   = anyM[1]
          longUrl = `https://www.mercadolivre.com.br/p/${mlbId}`
        }
      }
    }

    // ── Etapa 5: API pública ML → title, price, image (canônico) ─────
    if (mlbId) {
      try {
        const apiRes = await fetch(`https://api.mercadolibre.com/items/${mlbId}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'KainowRadar/1.0' },
        })
        if (apiRes.ok) {
          const d = await apiRes.json() as any
          return {
            mlbId,
            title:   d.title  || ogTitle || null,
            price:   d.price  ? Number(d.price) : ogPrice,
            image:   d.pictures?.[0]?.secure_url
                  || d.thumbnail?.replace('-I.jpg', '-O.jpg')
                  || ogImage
                  || null,
            longUrl: longUrl || `https://www.mercadolivre.com.br/p/${mlbId}`,
          }
        }
      } catch { /* ignora — usa dados do og: como fallback */ }

      // API falhou mas temos MLB e talvez og: dados
      if (ogTitle || ogImage) {
        return { mlbId, title: ogTitle, price: ogPrice, image: ogImage, longUrl }
      }
    }

    return { mlbId, title: ogTitle, price: ogPrice, image: ogImage, longUrl }
  }

  // ── resolveAndFetchShopee: resolve s.shopee.com.br e extrai dados ──
  // Fluxo:
  //   1. GET s.shopee.com.br/{hash} sem UA → HTML com <a href="shopee.com.br/{shopid}/{itemid}?...">
  //   2. Extrai shopid + itemid do href
  //   3. GET shopee.com.br/product/{shopid}/{itemid} com UA facebookexternalhit
  //      → retorna HTML com og:title, og:image e preço em R$ no HTML
  async function resolveAndFetchShopee(shortUrl: string): Promise<{
    itemId: string | null
    shopId: string | null
    title: string | null
    price: number | null
    image: string | null
    canonicalUrl: string | null
  }> {
    const SHOPEE_ID_RE = /shopee\.com\.br[^"']*?\/(\d{5,12})\/(\d{8,15})/i

    // Etapa 1: Resolver link curto → extrair shopid/itemid
    let shopId: string | null = null
    let itemId: string | null = null

    try {
      // UA mobile → s.shopee retorna HTML compacto (7KB) com URL do produto no script CONFIG
      // Sem UA correto, retorna SPA completa (150KB) sem dados úteis
      const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      const r1 = await fetch(shortUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': UA_MOBILE, 'Accept': 'text/html' },
      })
      const html1 = await r1.text()

      // O HTML do s.shopee com UA mobile tem os IDs embutidos no script (CONFIG ou deepLink)
      // Padrão: shopee.com.br/.../{shopid}/{itemid}? (URL pode ter \/ escapado)
      const html1clean = html1.replace(/\\\//g, '/').replace(/\\u002F/gi, '/')
      const m1 = html1clean.match(SHOPEE_ID_RE)
      if (m1) { shopId = m1[1]; itemId = m1[2] }

      // Fallback: tentar href no HTML (para o caso sem UA que retorna redirect simples)
      if (!shopId || !itemId) {
        const hrefM = html1.replace(/&amp;/g, '&').match(
          /href=["']([^"']*shopee\.com\.br[^"']*\/(\d{5,12})\/(\d{8,15})[^"']*)["']/
        )
        if (hrefM) { shopId = hrefM[2]; itemId = hrefM[3] }
      }

      // Fallback: URL final do fetch (se houve redirect HTTP)
      if (!shopId || !itemId) {
        const finalUrl = r1.url || ''
        const mf = finalUrl.match(SHOPEE_ID_RE)
        if (mf) { shopId = mf[1]; itemId = mf[2] }
      }
    } catch { /* ignora */ }

    if (!shopId || !itemId) {
      return { itemId: null, shopId: null, title: null, price: null, image: null, canonicalUrl: null }
    }

    // Etapa 2: Buscar dados do produto via Facebook UA (retorna og: tags com nome e imagem)
    const productUrl = `https://shopee.com.br/product/${shopId}/${itemId}`
    let title: string | null = null
    let image: string | null = null
    let price: number | null = null
    let canonicalUrl: string | null = productUrl

    try {
      const r2 = await fetch(productUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      })
      const html2 = await r2.text()

      // og:title → nome do produto
      const titleM = html2.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
               ?? html2.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
      if (titleM) {
        title = titleM[1].replace(/\s*\|\s*Shopee Brasil\s*$/i, '').trim()
      }

      // og:image → imagem principal
      const imgM = html2.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              ?? html2.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      if (imgM) image = imgM[1].trim()

      // og:url → URL canônica com slug (mais amigável)
      const urlM = html2.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
              ?? html2.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i)
      if (urlM) canonicalUrl = urlM[1].trim()

      // ── Preço: JSON-LD primeiro (mais confiável), fallback R$ no HTML ──
      // JSON-LD <script type="application/ld+json"> contém o preço real do produto
      // O padrão xTgkVC/KTJj8T no HTML é o valor do FRETE GRÁTIS, não o preço!
      const jsonldMatches = [...html2.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis)]
      for (const jm of jsonldMatches) {
        try {
          const jd = JSON.parse(jm[1])
          const off = Array.isArray(jd.offers) ? jd.offers[0] : jd.offers
          if (off?.price) {
            const v = parseFloat(String(off.price).replace(',','.'))
            if (v > 0 && v < 1_000_000) { price = v; break }
          }
        } catch { /* continua */ }
      }
      // Fallback: R$ XX,XX no HTML — mas ignora contexto de frete
      if (!price) {
        // Remove blocos de frete antes de buscar preço
        const html2noFrete = html2.replace(/Frete[^<]*<[^>]*>[^<]*R\$[^<]*</gi, '')
                                   .replace(/KTJj8T[^<]*<[^<]*<[^<]*R\$[^<]*/g, '')
        const priceM = html2noFrete.match(/R\$\s*([\d]+(?:[.,]\d{2})?)(?:\s|<|&|"|'|$)/i)
        if (priceM) {
          const raw = priceM[1]
          const norm = /^\d{1,3}\.\d{3},\d{2}$/.test(raw)
            ? raw.replace('.', '').replace(',', '.')
            : raw.replace(',', '.')
          const v = parseFloat(norm)
          if (v > 0 && v < 1_000_000) price = v
        }
      }
    } catch { /* ignora */ }

    return { itemId, shopId, title, price, image, canonicalUrl }
  }

  // ── refreshShopeePrice: atualiza preço/imagem de uma offer Shopee via URL canônica ──
  async function refreshShopeePrice(offer: {
    id: number; external_id: string; shopee_product_url: string | null
  }): Promise<{ price: number | null; image: string | null; title: string | null }> {
    const shopid = offer.external_id ? null : null  // não usado diretamente
    const productUrl = offer.shopee_product_url
    if (!productUrl) return { price: null, image: null, title: null }

    let price: number | null = null
    let image: string | null = null
    let title: string | null = null

    try {
      const r = await fetch(productUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      })
      const html = await r.text()

      // JSON-LD — fonte mais confiável de preço
      const jsonldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis)]
      for (const jm of jsonldMatches) {
        try {
          const jd = JSON.parse(jm[1])
          const off = Array.isArray(jd.offers) ? jd.offers[0] : jd.offers
          if (off?.price) {
            const v = parseFloat(String(off.price).replace(',','.'))
            if (v > 0 && v < 1_000_000) { price = v }
          }
          if (!title && jd.name) title = jd.name
          if (!image && jd.image) image = Array.isArray(jd.image) ? jd.image[0] : jd.image
        } catch { /* continua */ }
      }

      // og:title
      if (!title) {
        const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
               ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
        if (tm) title = tm[1].replace(/\s*\|\s*Shopee Brasil\s*$/i, '').trim()
      }

      // og:image
      if (!image) {
        const im = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
        if (im) image = im[1].trim()
      }
    } catch { /* ignora */ }

    return { price, image, title }
  }

  // ── Processamento ───────────────────────────────────────────

  const results: any[] = []
  let matched = 0, saved = 0, errors = 0, imported = 0, duplicates = 0

  for (const originalUrl of urls) {
    try {
      // ── DEDUPLICAÇÃO ─────────────────────────────────────────
      const alreadyImported = await DB.prepare(
        `SELECT id, affiliate_url, product_name FROM ml_affiliate_imports
         WHERE original_url = ? OR affiliate_url = ? LIMIT 1`
      ).bind(originalUrl, originalUrl).first<any>()

      if (alreadyImported) {
        duplicates++
        results.push({
          url:          originalUrl,
          status:       'duplicado',
          product_name: alreadyImported.product_name ?? null,
          message:      'Link já importado anteriormente — ignorado',
        })
        continue
      }

      const isShort = isShortAffiliateLink(originalUrl)
      const isLong  = isLongMlLink(originalUrl)

      // ── RESOLVE LINK + BUSCA DADOS NA API ML ─────────────────
      // Para meli.la: segue redirect → MLB → api.mercadolibre.com/items/{MLB}
      // Para links longos: extrai MLB direto → api.mercadolibre.com/items/{MLB}
      let affiliateUrl: string = originalUrl
      let mlbId:  string | null = null
      let title:  string | null = null
      let price:  number | null = null
      let image:  string | null = null
      let longUrl: string | null = null

      if (isShort) {
        // meli.la — segue redirect e busca tudo na API ML
        affiliateUrl = originalUrl   // link curto JÁ É o link de afiliado
        const resolved = await resolveAndFetchML(originalUrl)
        mlbId   = resolved.mlbId
        title   = resolved.title
        price   = resolved.price
        image   = resolved.image
        longUrl = resolved.longUrl
      } else if (isLong) {
        // Link longo → extrai MLB, injeta tracking, busca API ML
        mlbId        = extractMlbId(originalUrl)
        affiliateUrl = buildTrackedUrl(originalUrl)
        longUrl      = originalUrl
        if (mlbId) {
          // Busca dados na API ML
          try {
            const apiRes = await fetch(`https://api.mercadolibre.com/items/${mlbId}`, {
              headers: { 'Accept': 'application/json', 'User-Agent': 'KainowRadar/1.0' },
            })
            if (apiRes.ok) {
              const d = await apiRes.json() as any
              title = d.title     || null
              price = d.price     ? Number(d.price) : null
              image = d.pictures?.[0]?.secure_url
                   || d.thumbnail?.replace('-I.jpg', '-O.jpg')
                   || null
            }
          } catch { /* ignora */ }
        }
      } else {
        mlbId = extractMlbId(originalUrl)
      }

      imported++

      // ── VINCULA A PRODUTO EXISTENTE (pelo MLB ID) ─────────────
      let product: any = null
      if (mlbId) {
        product = await DB.prepare(
          'SELECT id, name FROM products WHERE ml_item_id = ? LIMIT 1'
        ).bind(mlbId).first<any>()
      }

      if (product) {
        matched++
        // Atualiza link de afiliado no produto existente
        await DB.prepare(`
          UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(affiliateUrl, product.id).run()
        saved++
      }

      // ── SALVA NA TABELA DE IMPORTS (com todos os dados) ───────
      await DB.prepare(`
        INSERT INTO ml_affiliate_imports
          (original_url, resolved_url, ml_item_id, affiliate_url,
           product_id, product_name, product_price, product_image, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        originalUrl,
        longUrl ?? originalUrl,
        mlbId ?? null,
        affiliateUrl,
        product?.id   ?? null,
        title ?? product?.name ?? null,
        price ?? null,
        image ?? null,
        product ? 'matched' : (mlbId ? 'resolved' : 'saved')
      ).run()

      results.push({
        url:          originalUrl,
        affiliate_url: affiliateUrl,
        ml_item_id:   mlbId  ?? null,
        title:        title  ?? product?.name ?? null,
        price:        price  ?? null,
        image:        image  ?? null,
        status:       product ? 'matched' : (mlbId ? 'resolved' : 'saved'),
        product_id:   product?.id ?? null,
        type:         isShort ? 'meli.la' : isLong ? 'long' : 'unknown',
      })

    } catch (e: any) {
      errors++
      await DB.prepare(
        "INSERT INTO ml_affiliate_imports (original_url, status, error_msg) VALUES (?, 'error', ?)"
      ).bind(originalUrl, e?.message || String(e)).run().catch(() => {})
      results.push({ url: originalUrl, status: 'error', error: e?.message || String(e) })
    }
  }

  return c.json({
    ok: true,
    total:      urls.length,
    imported,
    duplicates,
    matched,
    saved,
    errors,
    results,
    tip: imported > 0
      ? `${imported} link(s) processado(s) — nome, preço e imagem salvos automaticamente!`
      : duplicates > 0
        ? `Todos os ${duplicates} link(s) já foram importados — nenhum duplicado.`
        : 'Nenhum link novo processado.',
  })
})

// ── GET /admin/api/stores/ml/import-history ─────────────────────
// Retorna histórico dos últimos 100 links importados
admin.get('/api/stores/ml/import-history', async (c) => {
  const { DB } = c.env
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 200)
  const { results } = await DB.prepare(`
    SELECT id, original_url, resolved_url, ml_item_id, affiliate_url,
           product_id, product_name, product_price, product_image,
           status, error_msg, imported_at
    FROM ml_affiliate_imports
    ORDER BY imported_at DESC
    LIMIT ?
  `).bind(limit).all<any>()
  return c.json({ imports: results, results })
})

// ── GET /admin/api/stores/:id/import-history ─────────────────────
// Retorna histórico das últimas 100 importações de uma loja específica
// (busca na tabela offers JOIN products filtrado por store_id)
admin.get('/api/stores/:id/import-history', async (c) => {
  const { DB } = c.env
  const storeId = parseInt(c.req.param('id'))
  if (!storeId) return c.json({ results: [] })

  const { results } = await DB.prepare(`
    SELECT
      o.id,
      p.name,
      p.category,
      p.slug,
      o.affiliate_url,
      o.price        AS best_price,
      o.image_url,
      o.created_at,
      CASE
        WHEN o.created_at IS NOT NULL THEN 'importado'
        ELSE 'erro'
      END AS status
    FROM offers o
    JOIN products p ON p.id = o.product_id
    WHERE o.store_id = ?
      AND o.source = 'manual'
    ORDER BY o.created_at DESC
    LIMIT 100
  `).bind(storeId).all<any>()

  return c.json({ results })
})

// ── GET /admin/api/proxy-img ─────────────────────────────────────
// Proxy de imagem para contornar hotlink protection do mlstatic.com
// Busca a imagem no servidor com Referer correto e re-serve ao browser
admin.get('/api/proxy-img', async (c) => {
  const url = c.req.query('url') || ''
  if (!url.startsWith('http')) return c.json({ error: 'URL inválida' }, 400)

  // Só permite domínios de imagem conhecidos (segurança)
  const allowed = ['mlstatic.com', 'mla-s2-p.mlstatic.com', 'http2.mlstatic.com',
                   'mla-s1-p.mlstatic.com', 'a-static.mlcdn.com.br', 'http2.mlstatic.com']
  const isAllowed = allowed.some(d => url.includes(d))
  if (!isAllowed) return c.json({ error: 'Domínio não permitido' }, 400)

  try {
    const res = await fetch(url, {
      headers: {
        'Referer':    'https://www.mercadolivre.com.br/',
        'Origin':     'https://www.mercadolivre.com.br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'image/webp,image/avif,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return c.json({ error: `Imagem retornou ${res.status}` }, 502)

    const contentType = res.headers.get('Content-Type') || 'image/webp'
    const body = await res.arrayBuffer()

    return new Response(body, {
      headers: {
        'Content-Type':                contentType,
        'Cache-Control':               'public, max-age=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Source':              'shopping-compare',
      },
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Erro ao buscar imagem' }, 502)
  }
})

// ── Helper: obtém Bearer token do ML via client_credentials ──────
async function getMlBearerToken(env: AdminBindings): Promise<string | null> {
  const CACHE = (env as any).CACHE as KVNamespace | undefined
  const appId  = env.ML_APP_ID
  const secret = env.ML_SECRET
  if (!appId || !secret) return null

  // Tenta cache KV primeiro (token válido por ~6h)
  if (CACHE) {
    try {
      const cached = await CACHE.get('ml_app_token')
      if (cached) return cached
    } catch { /* ignora */ }
  }

  // Solicita novo token via client_credentials
  try {
    const res = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}`,
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    const token: string = data?.access_token
    if (!token) return null

    // Guarda no KV por 5h50min (tokens duram 6h)
    if (CACHE) {
      await CACHE.put('ml_app_token', token, { expirationTtl: 21000 }).catch(() => {})
    }
    return token
  } catch {
    return null
  }
}

// ── GET /admin/api/resolve-url ───────────────────────────────────
// Resolve qualquer link (meli.la, /social/, mercadolivre.com.br, etc.)
//
// ESTRATÉGIA DUPLA para links ML:
//
// PASSO 1 — resolve URL e extrai mlbId
//   • UA mobile → segue redirect do link /social/ ou meli.la
//   • Extrai MLB ID da URL final ou do HTML
//
// PASSO 2 — busca HTML completo com Googlebot UA
//   • URL: produto.mercadolivre.com.br/MLB-XXXXXXXXX
//   • O ML serve HTML completo (SSR) para bots — inclui preço, og:title, og:image
//   • Confirmado: retorna ~450KB com "price":119.9 e og:image válido
//   • MUITO mais confiável que scraping de página de usuário (SPA)
//
// A API ML /items/{id} retorna 403 de qualquer servidor — não usar no backend.
admin.get('/api/resolve-url', async (c) => {
  const url  = c.req.query('url')  || ''
  const url2 = c.req.query('url2') || ''   // opcional: link afiliado /social/ ou vice-versa
  if (!url.startsWith('http')) return c.json({ error: 'URL inválida' }, 400)

  // ── Helper: extrai conteúdo de meta tag de HTML ──────────────────
  const extractMeta = (html: string, prop: string): string => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
           || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'))
    return m ? m[1].trim() : ''
  }

  // ── Helper: extrai MLB ID de URL ou string HTML ──────────────────
  const extractMlbId = (s: string): string | null => {
    const m = s.match(/\b(MLB\d{7,12})\b/i)
    return m ? m[1].toUpperCase() : null
  }

  // ── Helper: extrai preço de HTML do ML ──────────────────────────
  const extractPrice = (html: string): number | null => {
    const patterns = [
      // /social/ forceInApp=true: "current_price":{"value":14.54} — PRIORIDADE MÁXIMA
      /"current_price"\s*:\s*\{"value"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
      // produto.mercadolivre.com.br / páginas de produto: "price":14.54
      /"price"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
      // itemprop=price
      /content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/i,
      /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i,
      // "amount":14.54
      /"amount"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
    ]
    for (const pat of patterns) {
      const m = html.match(pat)
      if (m) {
        const raw = m[1].replace(/\.(?=\d{3})/g, '').replace(',', '.')
        const val = parseFloat(raw)
        if (!isNaN(val) && val > 0 && val < 9_000_000) return val
      }
    }
    return null
  }

  // ── Helper: normaliza URL de imagem mlstatic ─────────────────────
  const fixImgUrl = (img: string): string => {
    if (!img || img.startsWith('data:')) return ''
    // Decodifica \u002F → /
    img = img.replace(/\\u002F/g, '/').replace(/\\/g, '')
    if (img.startsWith('//')) img = 'https:' + img
    // Garante resolução máxima: sufixo _O (original)
    img = img.replace(/_[A-Z](-\d+)?(\.(webp|jpg|png))(\?.*)?$/, '_O$2')
    return img
  }

  // ── Helper: extrai preço do og:title do ML ───────────────────────
  // O ML coloca o preço no og:title: "Nome do Produto - R$ 35,79"
  // Funciona para qualquer produto — Product IDs e Item IDs
  const extractPriceFromTitle = (title: string): number | null => {
    const m = title.match(/R\$\s*([\d]+(?:[.,][\d]{1,2})?)\s*$/i)
    if (!m) return null
    const val = parseFloat(m[1].replace(',', '.'))
    return (!isNaN(val) && val > 0 && val < 9_000_000) ? val : null
  }

  // ── Helper: limpa nome do produto ────────────────────────────────
  // Remove " - R$ 35,79" do final (ML inclui no og:title)
  const cleanName = (n: string): string =>
    n.replace(/\s*-\s*R\$\s*[\d]+(?:[.,][\d]{1,2})?\s*$/i, '')
     .replace(/\s*[|–\-]\s*(Mercado Livr[eo].*|Perfil Social.*|ML.*|Amazon.*|Americanas.*)$/i, '')
     .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
     .trim()

  try {
    const isMlLink     = /mercadolivre\.com\.br|mercadolibre\.com|meli\.la|produto\.mercadolivre/i.test(url)
    const isSocialLink = /\/social\/[a-z0-9]+/i.test(url)

    // url2 pode ser: link /social/ afiliado (quando url é produto) ou vice-versa
    const url2IsSocial  = url2 ? /\/social\/[a-z0-9]+/i.test(url2) : false
    const url2IsProduct = url2 ? /mercadolivre\.com\.br|meli\.la/i.test(url2) && !url2IsSocial : false

    // URL /social/ definitiva — pode vir de url ou url2
    const socialUrl  = isSocialLink ? url : (url2IsSocial  ? url2 : '')
    // URL do produto definitiva — pode vir de url ou url2
    const productUrl = !isSocialLink ? url : (url2IsProduct ? url2 : '')

    const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const botUA    = 'Googlebot/2.1 (+http://www.google.com/bot.html)'

    // ── PRÉ-PASSO: extrai wid= do fragment # da URL do produto ────────
    // URL tipo: ...mercadolivre.com.br/.../up/MLBU...#...&wid=MLB5385902202&...
    // O fragment NÃO é enviado ao servidor; mas o usuário cola a URL completa
    // aqui no backend, então podemos ler o fragment diretamente da string.
    let mlbIdFromFragment: string | null = null
    const checkForFragment = (u: string) => {
      const hashIdx = u.indexOf('#')
      if (hashIdx === -1) return
      const fragment = u.slice(hashIdx + 1)
      // wid=MLB5385902202
      const widM = fragment.match(/(?:^|[&])wid=(MLB\d{7,12})/i)
      if (widM && !mlbIdFromFragment) mlbIdFromFragment = widM[1].toUpperCase()
    }
    checkForFragment(url)
    if (!mlbIdFromFragment && url2) checkForFragment(url2)

    // ── PRÉ-PASSO: extrai matt_d2id de qualquer uma das URLs ─────────
    // Presente em links diretos de produto: ?matt_d2id=UUID ou &matt_d2id=UUID
    let mlCookie = ''
    {
      const checkD2id = (u: string) => {
        if (mlCookie) return
        const m = u.match(/[?&]matt_d2id=([a-f0-9\-]{30,40})/i)
        if (m) mlCookie = `_d2id=${m[1]}-n`
      }
      checkD2id(url)
      if (url2) checkD2id(url2)
    }

    // ════════════════════════════════════════════════════════════════
    // PASSO 1-SOCIAL: busca o link /social/ com forceInApp=true
    //   → SSR com item_id + og:title + og:image + matt_d2id no HTML
    //   Funciona para url OU url2 sendo o link /social/
    // ════════════════════════════════════════════════════════════════
    let name  = ''
    let image = ''
    let price: number | null = null
    let finalUrl = url
    let mlbId: string | null = mlbIdFromFragment  // prioridade: wid= do fragment

    let htmlSocial = ''
    if (socialUrl) {
      let fetchSocial = socialUrl
      if (!socialUrl.includes('forceInApp=true')) {
        try {
          const u = new URL(socialUrl)
          u.searchParams.set('forceInApp', 'true')
          fetchSocial = u.toString()
        } catch { /* mantém */ }
      }
      try {
        const rS = await fetch(fetchSocial, {
          redirect: 'follow',
          headers: {
            'User-Agent':      mobileUA,
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9',
          },
          signal: AbortSignal.timeout(10000),
        })
        htmlSocial = await rS.text()
        if (isSocialLink) finalUrl = rS.url || socialUrl

        // mlbId do item_id no JSON inline
        if (!mlbId) {
          const itemIdM = htmlSocial.match(/"item_id"\s*:\s*"(MLB\d{7,12})"/i)
          if (itemIdM) mlbId = itemIdM[1].toUpperCase()
        }

        // matt_d2id do HTML do /social/ (se ainda não temos cookie)
        if (!mlCookie) {
          const d2m = htmlSocial.match(/matt_d2id=([a-f0-9\-]{30,40})/i)
                   || htmlSocial.match(/"matt_d2id"\s*:\s*"([a-f0-9\-]{30,40})"/i)
          if (d2m) mlCookie = `_d2id=${d2m[1]}-n`
        }

        // Metadados do /social/ — JSON embutido: {"type":"og:title","content":"..."}  
        const titleM = htmlSocial.match(/"type"\s*:\s*"og:title"\s*,\s*"content"\s*:\s*"([^"]+)"/)
                    || htmlSocial.match(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"og:title"/)
        if (titleM) {
          if (!price) price = extractPriceFromTitle(titleM[1])
          name = cleanName(titleM[1])
        }
        // Preço via "current_price":{"value":14.54} — presente no JSON inline do /social/
        // O og:title nem sempre contém o preço (ML omite em alguns produtos)
        if (!price) price = extractPrice(htmlSocial)

        const imgM = htmlSocial.match(/"type"\s*:\s*"og:image"\s*,\s*"content"\s*:\s*"([^"]+)"/)
                  || htmlSocial.match(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"og:image"/)
        if (imgM) image = fixImgUrl(imgM[1])
      } catch { /* segue sem dados do /social/ */ }
    }

    // ════════════════════════════════════════════════════════════════
    // PASSO 1-PRODUCT: busca a URL do produto (não-social) se necessário
    //   Só executa se não temos os dados completos do /social/
    //   OU se a URL principal é o produto (não temos url2 social)
    // ════════════════════════════════════════════════════════════════
    let html1 = ''
    const needsProductFetch = productUrl && (!price || !image || !mlbId)
    if (needsProductFetch) {
      try {
        const isDirectMlProduct = /mercadolivre\.com\.br|meli\.la/i.test(productUrl)
        const prodHeaders: Record<string, string> = {
          'User-Agent':      isDirectMlProduct ? botUA : mobileUA,
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        }
        if (isDirectMlProduct && mlCookie) prodHeaders['Cookie'] = mlCookie

        const rP = await fetch(productUrl, {
          redirect: 'follow',
          headers: prodHeaders,
          signal: AbortSignal.timeout(10000),
        })
        html1 = await rP.text()
        if (!isSocialLink) finalUrl = rP.url || productUrl

        if (!mlbId) {
          const isLoginPage = (rP.url || '').includes('/gz/account-verification') || (rP.url || '').includes('/login')
          if (!isLoginPage) mlbId = extractMlbId(rP.url || '') || extractMlbId(html1) || extractMlbId(productUrl)
        }

        // Metadados do produto (só preenche o que ainda está vazio)
        const rawT = (extractMeta(html1, 'og:title') || extractMeta(html1, 'twitter:title') || '').trim()
        if (rawT && !name) {
          if (!price) price = extractPriceFromTitle(rawT)
          name = cleanName(rawT)
        }
        if (!image) {
          const img1 = extractMeta(html1, 'og:image') || extractMeta(html1, 'twitter:image')
          if (img1) image = fixImgUrl(img1)
        }
        if (!price) price = extractPrice(html1)
      } catch { /* segue */ }
    }

    // fallback: tenta extrair mlbId da URL do produto
    if (!mlbId && productUrl) mlbId = extractMlbId(productUrl)

    // ════════════════════════════════════════════════════════════════
    // PASSO 2: busca preço/nome/imagem via API ML (autenticada) ou Googlebot SSR
    //
    // ESTRATÉGIA POR TIPO DE ID:
    //
    //   Product IDs (MLB + ≤10 dígitos, ex: MLB59837260):
    //     ✅ API ML /products/{id}          → nome + imagem (sem bloqueio de IP)
    //     ✅ API ML /products/{id}/items    → item ID filho (ex: MLB5385902202)
    //     ✅ API ML /items/{itemId}         → preço real
    //     (HTML via Googlebot falha: IPs CF bloqueados pelo ML)
    //
    //   Item IDs (MLB + ≥11 dígitos, ex: MLB5385902202):
    //     ✅ API ML /items/{id}             → preço + título + imagem (primário, sem bloqueio de IP)
    //     ✅ produto.mercadolivre.com.br     → fallback SSR (funciona fora de CF; bloqueado em datacenter)
    // ════════════════════════════════════════════════════════════════
    if (mlbId && isMlLink) {
      const mlbDigits   = mlbId.replace(/^MLB/i, '')
      const isProductId = mlbDigits.length <= 10

      if (isProductId) {
        // ── Product ID: usa API ML autenticada ────────────────────
        try {
          const token = await getMlBearerToken(c.env)
          if (token) {
            const authHdr = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }

            // 2a. /products/{id} → nome + imagem
            const rProd = await fetch(
              `https://api.mercadolibre.com/products/${mlbId}?attributes=id,name,pictures`,
              { headers: authHdr, signal: AbortSignal.timeout(6000) }
            )
            if (rProd.ok) {
              const dp = await rProd.json() as any
              if (dp.name && (!name || name.length < 5)) name = cleanName(dp.name)
              // Imagem: melhor resolução disponível
              const pics: any[] = dp.pictures || []
              const bestPic = pics.find((p: any) => p.url?.includes('mlstatic'))
                           || pics[0]
              if (bestPic?.url && !image) {
                image = fixImgUrl(bestPic.url)
              }
            }

            // 2b. /products/{id}/items → item ID filho para buscar preço
            if (!price) {
              const rItems = await fetch(
                `https://api.mercadolibre.com/products/${mlbId}/items?limit=1`,
                { headers: authHdr, signal: AbortSignal.timeout(5000) }
              )
              if (rItems.ok) {
                const di = await rItems.json() as any
                // /products/{id}/items retorna array em .results com campos inline
                // Cada item já tem: item_id, price, etc. (sem precisar buscar /items/{id})
                const arr2 = Array.isArray(di) ? di
                           : Array.isArray(di.results) ? di.results
                           : Array.isArray(di.items)   ? di.items
                           : []
                const firstItem = arr2[0] ?? null
                // Tenta pegar preço diretamente do item da listagem
                if (firstItem?.price && firstItem.price > 0) {
                  price = firstItem.price
                }
                // Se não tiver preço inline, busca via /items/{item_id}
                const firstItemId = firstItem?.item_id ?? firstItem?.id ?? null
                if (!price && firstItemId) {
                  const rItem = await fetch(
                    `https://api.mercadolibre.com/items/${firstItemId}?attributes=id,title,price,thumbnail`,
                    { headers: authHdr, signal: AbortSignal.timeout(5000) }
                  )
                  if (rItem.ok) {
                    const dItem = await rItem.json() as any
                    if (dItem.price && dItem.price > 0) price = dItem.price
                    if (dItem.title && (!name || name.length < 5)) name = cleanName(dItem.title)
                    if (dItem.thumbnail && !image) image = fixImgUrl(dItem.thumbnail)
                  }
                }
              }
            }
          }
        } catch { /* usa dados do passo 1 */ }

      } else {
        // ── Item ID (≥11 dígitos): usa API ML /items/{id} como primário ──
        // IPs de datacenter CF são bloqueados pelo produto.mercadolivre.com.br,
        // mas a API ML autenticada não tem esse bloqueio.
        let itemApiOk = false
        try {
          const token = await getMlBearerToken(c.env)
          if (token) {
            const rItem = await fetch(
              `https://api.mercadolibre.com/items/${mlbId}?attributes=id,title,price,thumbnail,pictures`,
              {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(7000),
              }
            )
            if (rItem.ok) {
              const dItem = await rItem.json() as any
              if (dItem.price && dItem.price > 0 && !price) price = dItem.price
              if (dItem.title && (!name || name.length < 5))  name  = cleanName(dItem.title)
              if (!image) {
                // Prefere pictures[] (maior resolução) → fallback para thumbnail
                const pics: any[] = dItem.pictures || []
                const bestPic = pics.find((p: any) => p.url?.includes('mlstatic')) || pics[0]
                const rawImg  = bestPic?.url || dItem.thumbnail || ''
                if (rawImg) image = fixImgUrl(rawImg)
              }
              itemApiOk = true
            }
          }
        } catch { /* segue para fallback */ }

        // ── Fallback: produto.mercadolivre.com.br (SSR, só funciona fora de CF) ──
        // Tenta apenas se a API ML não retornou dados suficientes.
        if (!itemApiOk || !price || !name) {
          const botUrl = `https://produto.mercadolivre.com.br/${mlbId.replace(/^MLB/i, 'MLB-')}`
          try {
            const step2 = await fetch(botUrl, {
              redirect: 'follow',
              headers: {
                'User-Agent':      botUA,
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9',
                'Accept-Encoding': 'identity',
              },
              signal: AbortSignal.timeout(9000),
            })
            if (step2.ok && !step2.url.includes('/gz/account-verification')) {
              const html2 = await step2.text()
              if (!price) {
                const p2 = extractPrice(html2)
                if (p2 && p2 > 0) price = p2
              }
              if (!name || name.length < 5) {
                const rawT2 = (extractMeta(html2, 'og:title') || extractMeta(html2, 'twitter:title') || '').trim()
                if (rawT2 && rawT2.length > 3) {
                  if (!price) price = extractPriceFromTitle(rawT2)
                  name = cleanName(rawT2)
                }
              }
              if (!image) {
                const img2fixed = fixImgUrl(extractMeta(html2, 'og:image') || extractMeta(html2, 'twitter:image'))
                if (img2fixed && img2fixed.includes('mlstatic')) image = img2fixed
              }
            }
          } catch { /* usa dados do passo 1 */ }
        }
      }
    }

    // ── Monta link afiliado automaticamente ────────────────────────
    // Se temos mlbId (do wid= fragment ou item_id do /social/),
    // monta o link afiliado: permalink?matt_word=PUBLISHER_ID&matt_tool=MATT_TOOL
    // Isso permite importar só com a URL do produto — sem precisar do link /social/
    const PUBLISHER_ID = 'cfegdhabc31955'
    const MATT_TOOL    = '61674414'
    let affiliateUrl: string | null = null
    if (mlbId) {
      // Permalink canônico: produto.mercadolivre.com.br/MLB-XXXXX
      const mlbDash = mlbId.replace(/^MLB/i, 'MLB-')
      affiliateUrl = `https://produto.mercadolivre.com.br/${mlbDash}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
    }

    return c.json({ ok: true, finalUrl, affiliateUrl, mlbId, name: name || null, image: image || null, price, hasSocial: !!socialUrl, hasFragment: !!mlbIdFromFragment })
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || 'Falha ao resolver URL' })
  }
})

// ── SHOPEE AFILIADOS — Token, Fetch Links, Status ────────────────

// GET /admin/shopee-script/:storeId — Página com script de console para a Shopee
admin.get('/shopee-script/:storeId', async (c) => {
  const storeId = parseInt(c.req.param('storeId')) || 0
  const { DB } = c.env
  const store = storeId ? await DB.prepare(`SELECT id, name FROM stores WHERE id = ?`).bind(storeId).first<any>().catch(() => null) : null
  const storeName = store?.name || `Loja #${storeId}`

  // Lê o script e injeta o storeId
  const scriptRaw = `
// ╔══════════════════════════════════════════════════════════════════╗
// ║  KainowRadar — Shopee Afiliados Console Script                  ║
// ║  Cole este script no Console do Chrome na página:               ║
// ║  https://affiliate.shopee.com.br/offer/product_offer            ║
// ╚══════════════════════════════════════════════════════════════════╝
;(async function KainowShopeeSync() {
  const CONFIG = {
    storeId:   ${storeId},
    kainowUrl: 'https://kainowradar.com.br',
    maxPages:  0,
    pageSize:  100,
    delayMs:   600,
    chunkSize: 50,
  }
  // [o resto do script é carregado dinamicamente]
  const s = document.createElement('script')
  s.src = 'https://kainowradar.com.br/static/shopee-console-script.js?store=${storeId}&t=' + Date.now()
  document.head.appendChild(s)
})()`.trim()

  return c.html(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KainowRadar — Script Shopee: ${storeName}</title>
  <link href="/static/tailwind.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
  <style>
    body { background:#0f172a; color:#f1f5f9; font-family:system-ui,sans-serif; }
    .code-block { background:#020617; border:1px solid #1e293b; border-radius:12px; padding:16px; font-family:'Fira Code',Consolas,monospace; font-size:12px; color:#e2e8f0; white-space:pre-wrap; word-break:break-all; max-height:340px; overflow-y:auto; position:relative; }
    .step { display:flex; gap:12px; align-items:flex-start; padding:12px 0; border-bottom:1px solid #1e293b; }
    .step:last-child { border-bottom:none; }
    .step-num { width:28px; height:28px; border-radius:50%; background:#EE4D2D; color:#fff; font-weight:700; font-size:13px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px; }
    .badge { display:inline-block; background:#EE4D2D22; color:#EE4D2D; border:1px solid #EE4D2D44; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:600; }
  </style>
</head>
<body class="min-h-screen">
  <div class="max-w-2xl mx-auto px-4 py-8">

    <!-- Header -->
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#EE4D2D,#FF7337)">
        <i class="fab fa-shopify text-white text-lg"></i>
      </div>
      <div>
        <h1 class="text-lg font-bold text-white">Script de Coleta — Shopee Afiliados</h1>
        <p class="text-sm text-slate-400">${storeName} · Store ID: ${storeId}</p>
      </div>
      <a href="/admin" class="ml-auto text-xs text-slate-500 hover:text-slate-300">← Voltar ao Admin</a>
    </div>

    <!-- Aviso importante -->
    <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-6 flex gap-3">
      <i class="fas fa-bolt text-amber-400 mt-0.5 flex-shrink-0"></i>
      <div class="text-sm text-amber-200">
        <strong>Sem extensão, sem login extra.</strong> Este script roda diretamente no console do Chrome
        enquanto você já está logado na Shopee Afiliados. Ele usa sua sessão ativa.
      </div>
    </div>

    <!-- Passos -->
    <div class="bg-slate-800/50 border border-slate-700 rounded-2xl p-5 mb-6">
      <h2 class="text-sm font-bold text-white mb-3 flex items-center gap-2">
        <i class="fas fa-list-ol text-orange-400"></i> Como usar
      </h2>
      <div class="step">
        <div class="step-num">1</div>
        <div>
          <div class="text-sm font-semibold text-white mb-0.5">Abra a Shopee Afiliados e faça login</div>
          <a href="https://affiliate.shopee.com.br/offer/product_offer" target="_blank"
             class="text-xs text-orange-400 hover:underline">
            affiliate.shopee.com.br/offer/product_offer <i class="fas fa-external-link-alt text-[10px]"></i>
          </a>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div>
          <div class="text-sm font-semibold text-white mb-0.5">Abra o Console do Chrome</div>
          <div class="text-xs text-slate-400">Pressione <kbd class="bg-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">F12</kbd> → aba <strong class="text-slate-300">Console</strong></div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div>
          <div class="text-sm font-semibold text-white mb-0.5">Copie o script abaixo e cole no console</div>
          <div class="text-xs text-slate-400">Clique no botão <span class="badge">Copiar Script</span> e cole com <kbd class="bg-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">Ctrl+V</kbd> → Enter</div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div>
          <div class="text-sm font-semibold text-white mb-0.5">Aguarde — ele coleta tudo sozinho!</div>
          <div class="text-xs text-slate-400">Um overlay aparece na página com progresso em tempo real. Pode minimizar a janela.</div>
        </div>
      </div>
    </div>

    <!-- Script -->
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-bold text-white flex items-center gap-2">
          <i class="fas fa-code text-orange-400"></i> Script — cole no Console
        </span>
        <button id="btn-copy" onclick="copyScript()"
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white transition-all hover:opacity-90"
          style="background:linear-gradient(135deg,#EE4D2D,#FF7337)">
          <i class="fas fa-copy"></i> Copiar Script
        </button>
      </div>
      <div class="code-block" id="script-code">${buildScript(storeId)}</div>
    </div>

    <!-- Para parar -->
    <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-4 mb-6">
      <div class="text-xs font-semibold text-slate-400 mb-2">⏹ Para parar a coleta antes de terminar:</div>
      <div class="code-block" style="max-height:none;padding:10px 14px;font-size:12px">window.__krStop = true</div>
    </div>

    <!-- Info -->
    <div class="grid grid-cols-3 gap-3 text-center">
      <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-3">
        <div class="text-lg font-black text-orange-400">100</div>
        <div class="text-[11px] text-slate-500">produtos/página</div>
      </div>
      <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-3">
        <div class="text-lg font-black text-green-400">1M+</div>
        <div class="text-[11px] text-slate-500">links suportados</div>
      </div>
      <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-3">
        <div class="text-lg font-black text-blue-400">~2h</div>
        <div class="text-[11px] text-slate-500">para 1 milhão</div>
      </div>
    </div>

  </div>

  <script>
    function buildScript() {
      return document.getElementById('script-code').textContent
    }
    function copyScript() {
      const text = document.getElementById('script-code').textContent
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btn-copy')
        btn.innerHTML = '<i class="fas fa-check"></i> Copiado!'
        btn.style.background = '#16a34a'
        setTimeout(() => {
          btn.innerHTML = '<i class="fas fa-copy"></i> Copiar Script'
          btn.style.background = ''
        }, 2500)
      }).catch(() => {
        // Fallback para navegadores mais antigos
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        alert('Script copiado!')
      })
    }
  </script>
</body>
</html>`)
})

function buildScript(storeId: number): string {
  return `;(async function KainowShopeeSync() {
  const CONFIG = { storeId: ${storeId}, kainowUrl: 'https://kainowradar.com.br', maxPages: 0, pageSize: 100, delayMs: 600, chunkSize: 50 }
  window.__krStop = false
  console.log('[KR] Para parar: window.__krStop = true')
  // Cria overlay
  document.getElementById('__kr_overlay')?.remove()
  const ov = document.createElement('div')
  ov.id = '__kr_overlay'
  ov.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#0f172a;color:#f1f5f9;padding:18px 20px;border-radius:16px;font-family:system-ui,sans-serif;font-size:13px;min-width:320px;box-shadow:0 8px 40px rgba(0,0,0,.6);border:1px solid #1e293b'
  ov.innerHTML = '<div style=\\"display:flex;align-items:center;justify-content:space-between;margin-bottom:12px\\"><div style=\\"display:flex;align-items:center;gap:9px\\"><div style=\\"width:10px;height:10px;border-radius:50%;background:#EE4D2D;animation:__kr_p 1s infinite\\"></div><strong style=\\"color:#EE4D2D\\">KainowRadar</strong><span style=\\"color:#475569;font-size:11px\\">Shopee Sync</span></div><button onclick=\\"this.closest(\'#__kr_overlay\').style.opacity=\'.2\'\\" style=\\"background:none;border:none;color:#475569;cursor:pointer\\">−</button></div><div id=\\"__kr_s\\" style=\\"color:#94a3b8;font-size:12px;margin-bottom:8px\\">Iniciando...</div><div style=\\"background:#1e293b;border-radius:6px;height:5px;overflow:hidden;margin-bottom:10px\\"><div id=\\"__kr_b\\" style=\\"height:100%;background:linear-gradient(90deg,#EE4D2D,#FF7337);width:0%;transition:width .4s\\"></div></div><div style=\\"display:flex;gap:0;margin-bottom:8px\\"><div style=\\"flex:1;background:#1e293b;border-radius:8px 0 0 8px;padding:8px;text-align:center;border:1px solid #334155;border-right:none\\"><div id=\\"__kr_f\\" style=\\"font-size:16px;font-weight:800;color:#fb923c\\">0</div><div style=\\"font-size:10px;color:#475569\\">Encontrados</div></div><div style=\\"flex:1;background:#1e293b;padding:8px;text-align:center;border:1px solid #334155;border-right:none\\"><div id=\\"__kr_i\\" style=\\"font-size:16px;font-weight:800;color:#22c55e\\">0</div><div style=\\"font-size:10px;color:#475569\\">Importados</div></div><div style=\\"flex:1;background:#1e293b;border-radius:0 8px 8px 0;padding:8px;text-align:center;border:1px solid #334155\\"><div id=\\"__kr_p2\\" style=\\"font-size:16px;font-weight:800;color:#60a5fa\\">1</div><div style=\\"font-size:10px;color:#475569\\">Página</div></div></div><div id=\\"__kr_l\\" style=\\"background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;font-size:11px;font-family:monospace;max-height:72px;overflow-y:auto;color:#475569\\"></div><style>@keyframes __kr_p{0%,100%{opacity:1}50%{opacity:.3}}</style>'
  document.body.appendChild(ov)
  const S=(m)=>{const e=document.getElementById('__kr_s');if(e)e.textContent=m;console.log('[KR]',m)}
  const B=(p)=>{const e=document.getElementById('__kr_b');if(e)e.style.width=Math.min(100,p)+'%'}
  const ST=(f,i,p)=>{const ef=document.getElementById('__kr_f'),ei=document.getElementById('__kr_i'),ep=document.getElementById('__kr_p2');if(ef)ef.textContent=f.toLocaleString('pt-BR');if(ei)ei.textContent=i.toLocaleString('pt-BR');if(ep)ep.textContent=p}
  const L=(m,c='#475569')=>{const el=document.getElementById('__kr_l');if(!el)return;const d=document.createElement('div');d.style.color=c;d.textContent=new Date().toLocaleTimeString('pt-BR')+' '+m;el.appendChild(d);el.scrollTop=el.scrollHeight;while(el.children.length>80)el.removeChild(el.firstChild)}
  const GET=async(pg,ps)=>{const r=await fetch(\`https://affiliate.shopee.com.br/api/v1/offer/product_offer?page_number=\${pg}&page_size=\${ps}&need_products_info=1&sort_type=2\`,{credentials:'include',headers:{'Accept':'application/json','x-requested-with':'XMLHttpRequest'}});if(r.status===401||r.status===403)throw new Error('Sessão expirada');if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
  const LINK=async(o)=>{const direct=o.short_link||o.affiliate_link||o.offer_link||o.sub_link;if(direct&&direct.startsWith('http'))return direct;const id=o.item_id||o.product_id||o.itemid,sh=o.shop_id||o.shopid||0;if(!id)return null;try{const r=await fetch('https://affiliate.shopee.com.br/api/v1/link/generate',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-requested-with':'XMLHttpRequest'},body:JSON.stringify({item_list:[{item_id:id,shop_id:sh}]})});if(r.ok){const d=await r.json();const l=d?.data?.link_list?.[0]?.short_link||d?.data?.[0]?.short_link;if(l)return l}}catch(_){}try{const r=await fetch('https://affiliate.shopee.com.br/api/v1/offer/generate_affiliate_link',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_id:id,shop_id:sh})});if(r.ok){const d=await r.json();return d?.data?.short_link||null}}catch(_){}return null}
  const BULK=async(offers)=>{const items=offers.filter(o=>o.item_id||o.product_id).map(o=>({item_id:o.item_id||o.product_id,shop_id:o.shop_id||0}));if(!items.length)return{links:[],items:[]};try{const r=await fetch('https://affiliate.shopee.com.br/api/v1/link/generate',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-requested-with':'XMLHttpRequest'},body:JSON.stringify({item_list:items})});if(r.ok){const d=await r.json();const list=d?.data?.link_list||d?.data||[];if(Array.isArray(list)&&list.length){const links=list.map(l=>l?.short_link||l?.affiliate_link).filter(Boolean);if(links.length)return{links,items}}}}catch(_){}return{links:[],items:[]}}
  const SEND=async(lines)=>{if(!lines.length)return{imported:0,updated:0};try{const r=await fetch(\`\${CONFIG.kainowUrl}/admin/api/stores/\${CONFIG.storeId}/import-links\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({links:lines.join('\\\\n')})});if(!r.ok)return{imported:0,updated:0};const d=await r.json();return{imported:d.imported||0,updated:d.updated||0}}catch(_){return{imported:0,updated:0}}}
  let tf=0,ts=0,pg=1,more=true
  try{
    const t=await GET(1,1);const tot=t?.data?.total_count||0;S('Total: '+(tot||'?')+' produtos. Iniciando...');L('Total: '+tot,'#60a5fa');await new Promise(r=>setTimeout(r,500))
    while(more&&!window.__krStop){if(CONFIG.maxPages>0&&pg>CONFIG.maxPages)break;S('Buscando página '+pg+'...');B(tot>0?Math.min(90,(tf/tot)*90):pg*2);let data;try{data=await GET(pg,CONFIG.pageSize)}catch(e){S('❌ '+e.message);L('❌ '+e.message,'#f87171');break}
    const offers=data?.data?.offers||data?.data?.list||data?.data?.items||(Array.isArray(data?.data)?data.data:[]);if(!offers||!offers.length){L('Fim dos produtos','#22c55e');more=false;break}
    L('Pág '+pg+': '+offers.length+' produtos','#60a5fa');S('Pág '+pg+': gerando links...')
    const{links:bl,items:bi}=await BULK(offers);const lines=[]
    if(bl.length>0){L('Bulk: '+bl.length+' links','#22c55e');bl.forEach((l,i)=>{if(!l)return;const o=offers.find(x=>(x.item_id||x.product_id)===bi[i]?.item_id)||offers[i]||{};lines.push([l,o.name||o.product_name||'',o.price||o.sale_price||'',o.image||o.item_image||'',o.item_id||o.product_id||''].join('|'))})}
    else{L('Gerando individualmente...','#f59e0b');for(let i=0;i<offers.length;i++){if(window.__krStop)break;const o=offers[i];const l=await LINK(o);if(l)lines.push([l,o.name||o.product_name||'',o.price||o.sale_price||'',o.image||o.item_image||'',o.item_id||o.product_id||''].join('|'));if(i%20===19){S('Pág '+pg+': '+(i+1)+'/'+offers.length);await new Promise(r=>setTimeout(r,100))}}}
    tf+=lines.length;ST(tf,ts,pg)
    if(lines.length>0){S('Enviando '+lines.length+' links...');for(let i=0;i<lines.length;i+=CONFIG.chunkSize){if(window.__krStop)break;const res=await SEND(lines.slice(i,i+CONFIG.chunkSize));ts+=res.imported+res.updated;ST(tf,ts,pg);B(tot>0?Math.min(95,(ts/tot)*95):50)}L('✅ Pág '+pg+': '+lines.length+' enviados','#22c55e')}
    if(offers.length<CONFIG.pageSize||(tot>0&&tf>=tot))more=false;pg++;if(more&&!window.__krStop)await new Promise(r=>setTimeout(r,CONFIG.delayMs))}
    B(100);const msg=(window.__krStop?'⏹ Parado! ':'🎉 Concluído! ')+ts.toLocaleString('pt-BR')+' importados de '+tf.toLocaleString('pt-BR');S(msg);L(msg,'#22c55e');console.log('[KR] COMPLETO',{tf,ts,pg:pg-1})
  }catch(e){S('❌ Erro: '+e.message);L('❌ '+e.message,'#f87171');console.error('[KR]',e)}
  return{ok:true,totalFound:tf,totalSaved:ts,pages:pg-1}
})()`
}


admin.post('/api/stores/shopee/token', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({}))
  const { store_id, app_id, secret, sub_id } = body
  if (!app_id || !secret) return c.json({ error: 'app_id e secret são obrigatórios' }, 400)

  // Salva nas configs da loja (api_configs)
  await DB.prepare(`
    INSERT INTO api_configs (id, name, network, endpoint_url, api_key, extra_json, is_active, commission_rate, created_at, updated_at)
    VALUES ('shopee-afiliados', 'Shopee Afiliados', 'shopee-api',
      'https://open-api.affiliate.shopee.com.br',
      ?, ?, 1, 6.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      api_key     = excluded.api_key,
      extra_json  = excluded.extra_json,
      is_active   = 1,
      updated_at  = CURRENT_TIMESTAMP
  `).bind(
    app_id,
    JSON.stringify({ secret, sub_id: sub_id || 'kainow', store_id })
  ).run()

  return c.json({ ok: true, message: 'Credenciais Shopee salvas com sucesso!' })
})

// GET /admin/api/stores/shopee/status — Verifica status da conexão Shopee
admin.get('/api/stores/shopee/status', async (c) => {
  const { DB } = c.env
  const storeId = c.req.query('store_id') || ''

  const cfg = await DB.prepare(
    `SELECT api_key, extra_json, updated_at FROM api_configs WHERE id = 'shopee-afiliados'`
  ).first<any>()

  if (!cfg || !cfg.api_key) {
    return c.json({ configured: false })
  }

  const extra = JSON.parse(cfg.extra_json || '{}')

  // Conta links/produtos da loja Shopee
  const store = storeId
    ? await DB.prepare(`SELECT id FROM stores WHERE (affiliate_network IN ('shopee-api','lomadee','socialsoul')) AND name LIKE '%hopee%' AND id = ?`).bind(storeId).first<any>()
    : await DB.prepare(`SELECT id FROM stores WHERE (affiliate_network IN ('shopee-api','lomadee','socialsoul')) AND name LIKE '%hopee%' LIMIT 1`).first<any>()

  let totalLinks = 0
  let totalProducts = 0
  if (store) {
    const pCount = await DB.prepare(`SELECT COUNT(*) as ct FROM products WHERE store_id = ?`).bind(store.id).first<any>()
    totalProducts = pCount?.ct || 0
    const oCount = await DB.prepare(`SELECT COUNT(*) as ct FROM offers WHERE store_id = ?`).bind(store.id).first<any>()
    totalLinks = oCount?.ct || 0
  }

  return c.json({
    configured: true,
    app_id: cfg.api_key,
    sub_id: extra.sub_id || '',
    last_sync: cfg.updated_at,
    total_links: totalLinks,
    total_products: totalProducts
  })
})

// POST /admin/api/stores/shopee/scrape — Scraping real via cookies da sessão do usuário
// Frontend envia os cookies após login, backend acessa API interna da Shopee como o usuário
admin.post('/api/stores/shopee/scrape', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({}))
  const { store_id, cookies, page = 0, page_size = 100, limit = 0 } = body

  if (!cookies) return c.json({ error: 'Cookies da sessão não enviados' }, 400)

  const storeId = parseInt(store_id) || 0
  const maxLinks = limit > 0 ? limit : 999999

  // ── API interna real da Shopee Afiliados ─────────────────────
  // Descoberta via DevTools: o painel usa essa API GraphQL internamente
  const SHOPEE_API = 'https://affiliate.shopee.com.br/api/v1'

  const allLinks: string[] = []
  let currentPage = page
  let hasMore = true
  let totalFound = 0

  const headers: Record<string, string> = {
    'Cookie':           cookies,
    'Content-Type':     'application/json',
    'Accept':           'application/json',
    'Referer':          'https://affiliate.shopee.com.br/offer/product_offer',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'x-requested-with': 'XMLHttpRequest',
    'x-csrftoken':      (cookies.match(/csrftoken=([^;]+)/) || [])[1] || ''
  }

  try {
    while (hasMore && allLinks.length < maxLinks) {
      // API real do painel de afiliados — endpoint de listagem de ofertas
      const apiUrl = `${SHOPEE_API}/offer/product_offer?` + new URLSearchParams({
        page_number: String(currentPage),
        page_size:   String(page_size),
        need_products_info: '1',
        sort_type:   '2'
      })

      const res = await fetch(apiUrl, { headers }).catch(() => null)

      if (!res || !res.ok) {
        // Tenta endpoint alternativo
        const res2 = await fetch(`${SHOPEE_API}/offer/get_offer_link`, {
          method:  'POST',
          headers,
          body: JSON.stringify({
            page_number: currentPage,
            page_size,
            sort_type: 2
          })
        }).catch(() => null)

        if (!res2 || !res2.ok) break

        const json2: any = await res2.json().catch(() => null)
        const items2 = json2?.data?.offers || json2?.data?.items || json2?.data || []

        if (!Array.isArray(items2) || items2.length === 0) { hasMore = false; break }

        for (const item of items2) {
          const link = item.affiliate_link || item.short_link || item.offer_link || item.link
          if (link) allLinks.push(link)
        }
        totalFound = json2?.total || json2?.data?.total || allLinks.length
        if (items2.length < page_size) hasMore = false
        currentPage++
        continue
      }

      const json: any = await res.json().catch(() => null)
      const items = json?.data?.offers || json?.data?.items || json?.data?.list || json?.data || []

      if (!Array.isArray(items) || items.length === 0) { hasMore = false; break }

      for (const item of items) {
        const link = item.affiliate_link || item.short_link || item.offer_link || item.link || item.url
        if (link) allLinks.push(link)
      }

      totalFound = json?.data?.total_count || json?.data?.total || json?.total || allLinks.length
      if (items.length < page_size) hasMore = false
      currentPage++
    }
  } catch (err: any) {
    return c.json({ ok: false, error: err.message, links: [], fetched: 0 })
  }

  if (allLinks.length === 0) {
    return c.json({
      ok: false,
      fetched: 0,
      links: [],
      total: totalFound,
      message: 'Nenhum link encontrado. Verifique se está logado no painel da Shopee.'
    })
  }

  // Atualiza last_sync
  await DB.prepare(`
    INSERT INTO api_configs (id, name, network, is_active, commission_rate, created_at, updated_at)
    VALUES ('shopee-afiliados','Shopee Afiliados','shopee-api',1,6.0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run()

  return c.json({
    ok:      true,
    fetched: allLinks.length,
    total:   totalFound,
    page:    currentPage,
    links:   allLinks,
    has_more: hasMore && allLinks.length < maxLinks
  })
})

// ── GET /admin/api/stores/:id/shopee-cookies-status ────────────────────
// Verifica se há cookies salvos no KV para este store
admin.get('/api/stores/:id/shopee-cookies-status', async (c) => {
  const { CACHE } = c.env
  const storeId = c.req.param('id')
  const kvKey   = `shopee_cookies_${storeId}`

  const raw = await CACHE.get(kvKey, 'text').catch(() => null)
  if (!raw) return c.json({ has_cookies: false })

  try {
    const parsed = JSON.parse(raw)
    return c.json({
      has_cookies: !!(parsed.cookies),
      saved_at:    parsed.saved_at || null,
      store_id:    storeId
    })
  } catch {
    // valor antigo era só a string de cookies
    return c.json({ has_cookies: true, saved_at: null, store_id: storeId })
  }
})

// ── POST /admin/api/stores/:id/shopee-save-cookies ─────────────────────
// Salva cookies da sessão do usuário no KV (TTL 7 dias)
admin.post('/api/stores/:id/shopee-save-cookies', async (c) => {
  const { CACHE } = c.env
  const storeId = c.req.param('id')
  const body    = await c.req.json().catch(() => ({}))
  const { cookies } = body

  if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 20) {
    return c.json({ ok: false, error: 'Cookies inválidos ou muito curtos' }, 400)
  }

  const kvKey  = `shopee_cookies_${storeId}`
  const payload = JSON.stringify({
    cookies:  cookies.trim(),
    saved_at: new Date().toISOString(),
    store_id: storeId
  })

  // Salva por 7 dias (604800 segundos)
  await CACHE.put(kvKey, payload, { expirationTtl: 604800 })

  return c.json({ ok: true, store_id: storeId, saved_at: new Date().toISOString() })
})

// ── POST /admin/api/stores/:id/shopee-server-sync ──────────────────────
// Coleta server-side: usa cookies salvos no KV (ou enviados no body)
// para chamar a API interna da Shopee Afiliados e importar todos os produtos
admin.post('/api/stores/:id/shopee-server-sync', async (c) => {
  const { DB, CACHE } = c.env
  const storeId = parseInt(c.req.param('id'))
  if (!storeId) return c.json({ ok: false, error: 'storeId inválido' }, 400)

  // Busca a loja
  const store = await DB.prepare(
    `SELECT id, name, affiliate_network FROM stores WHERE id = ?`
  ).bind(storeId).first<any>()
  if (!store) return c.json({ ok: false, error: 'Loja não encontrada' }, 404)

  const body = await c.req.json().catch(() => ({}))
  let cookies: string = (body.cookies || '').trim()

  // Se não veio no body, busca no KV
  if (!cookies) {
    const kvKey = `shopee_cookies_${storeId}`
    const raw   = await CACHE.get(kvKey, 'text').catch(() => null)
    if (raw) {
      try { cookies = JSON.parse(raw).cookies || raw } catch { cookies = raw }
    }
  }

  if (!cookies) {
    return c.json({
      ok: false,
      error: 'Cookies não encontrados. Cole seus cookies e clique "Salvar e Coletar".',
      hint: 'Abra affiliate.shopee.com.br → F12 → Network → copie o header "cookie:"'
    }, 400)
  }

  // Salva/atualiza cookies no KV para reutilizar depois
  const kvKey   = `shopee_cookies_${storeId}`
  const kvPayload = JSON.stringify({ cookies, saved_at: new Date().toISOString(), store_id: storeId })
  await CACHE.put(kvKey, kvPayload, { expirationTtl: 604800 }).catch(() => {})

  // ── Headers para a API interna da Shopee Afiliados ─────────────────
  const csrfMatch = cookies.match(/csrftoken=([^;]+)/)
  const csrf      = csrfMatch ? csrfMatch[1] : ''

  const shopeeHeaders: Record<string, string> = {
    'Cookie':            cookies,
    'Accept':            'application/json, text/plain, */*',
    'Content-Type':      'application/json',
    'Referer':           'https://affiliate.shopee.com.br/offer/product_offer',
    'Origin':            'https://affiliate.shopee.com.br',
    'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-requested-with':  'XMLHttpRequest',
    'x-csrftoken':       csrf,
  }

  const maxLinks    = (body.limit && body.limit > 0) ? body.limit : 999999
  const PAGE_SIZE   = 100
  const SHOPEE_BASE = 'https://affiliate.shopee.com.br/api/v1'

  // ── Slugify helper ────────────────────────────────────────────────
  const slugify = (t: string): string =>
    t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120)

  // ── Coleta paginada ───────────────────────────────────────────────
  type ShopeeItem = {
    url: string; name: string; price: number | null
    image_url: string | null; external_id: string | null
  }

  const allItems: ShopeeItem[] = []
  let   currentPage = 1
  let   hasMore     = true
  let   totalAPI    = 0
  let   apiErrors   = 0

  while (hasMore && allItems.length < maxLinks) {
    const apiUrl = `${SHOPEE_BASE}/offer/product_offer?` + new URLSearchParams({
      page_number:        String(currentPage),
      page_size:          String(PAGE_SIZE),
      need_products_info: '1',
      sort_type:          '2'
    })

    const res = await fetch(apiUrl, { headers: shopeeHeaders }).catch(() => null)

    // Tenta endpoint alternativo se o principal falhar
    if (!res || !res.ok) {
      apiErrors++
      if (apiErrors >= 3) break

      // Endpoint alternativo: lista de ofertas por POST
      const res2 = await fetch(`${SHOPEE_BASE}/offer/get_offer_link`, {
        method:  'POST',
        headers: shopeeHeaders,
        body:    JSON.stringify({ page_number: currentPage, page_size: PAGE_SIZE, sort_type: 2 })
      }).catch(() => null)

      if (!res2 || !res2.ok) { hasMore = false; break }

      const json2: any = await res2.json().catch(() => null)
      const list2 = json2?.data?.offers || json2?.data?.items || json2?.data || []
      if (!Array.isArray(list2) || list2.length === 0) { hasMore = false; break }

      for (const item of list2) {
        const link = item.affiliate_link || item.short_link || item.offer_link || item.link || item.url
        if (!link) continue
        allItems.push({
          url:         link,
          name:        item.item_name || item.name || item.title || '',
          price:       item.price_min != null ? Number(item.price_min) / 100000 :
                       item.price     != null ? Number(item.price)     / 100000 : null,
          image_url:   item.image || item.image_url || null,
          external_id: String(item.item_id || item.id || '')
        })
      }
      totalAPI = json2?.data?.total_count || json2?.total || allItems.length
      if (list2.length < PAGE_SIZE) hasMore = false
      currentPage++
      apiErrors = 0
      continue
    }

    const json: any = await res.json().catch(() => null)
    if (!json) { apiErrors++; if (apiErrors >= 3) break; continue }

    const list = json?.data?.offers   ||
                 json?.data?.items    ||
                 json?.data?.list     ||
                 (Array.isArray(json?.data) ? json.data : null) || []

    if (!Array.isArray(list) || list.length === 0) { hasMore = false; break }

    for (const item of list) {
      const link = item.affiliate_link || item.short_link || item.offer_link || item.link || item.url
      if (!link) continue
      allItems.push({
        url:         link,
        name:        item.item_name || item.name || item.title || '',
        price:       item.price_min != null ? Number(item.price_min) / 100000 :
                     item.price     != null ? Number(item.price)     / 100000 : null,
        image_url:   item.image || item.image_url || null,
        external_id: String(item.item_id || item.id || ''),
      })
    }

    totalAPI = json?.data?.total_count || json?.data?.total || json?.total || allItems.length
    if (list.length < PAGE_SIZE) hasMore = false
    currentPage++
    apiErrors = 0
  }

  if (allItems.length === 0) {
    return c.json({
      ok:      false,
      fetched: 0,
      error:   'Nenhum produto encontrado.',
      message: 'Verifique se os cookies são válidos e se você está logado em affiliate.shopee.com.br',
      pages:   currentPage - 1,
      api_total: totalAPI
    }, 422)
  }

  // ── Salva no banco (mesma lógica do import-links) ─────────────────
  let imported = 0, updated = 0, skipped = 0, errors = 0

  for (const item of allItems) {
    if (!item.url) { skipped++; continue }
    try {
      let baseUrl = item.url
      try { baseUrl = new URL(item.url).origin + new URL(item.url).pathname } catch { /* ignora */ }

      // Dedup por external_id primeiro
      let existing: any = null
      if (item.external_id && item.external_id !== '' && item.external_id !== 'undefined') {
        existing = await DB.prepare(
          `SELECT o.id, o.product_id, o.price FROM offers o WHERE o.external_id = ? LIMIT 1`
        ).bind(item.external_id).first<any>()
      }
      if (!existing) {
        existing = await DB.prepare(
          `SELECT o.id, o.product_id, o.price FROM offers o
           WHERE o.affiliate_url = ? OR o.affiliate_url = ? LIMIT 1`
        ).bind(item.url, baseUrl).first<any>()
      }

      // Nome fallback
      let name = (item.name || '').trim()
      if (!name) {
        const hash = item.url.split('/').filter(Boolean).pop() || ''
        name = `Produto Shopee ${hash}`
      }
      name = name.substring(0, 200)

      const price = item.price && item.price > 0 ? item.price : null
      const extId = (item.external_id && item.external_id !== '' && item.external_id !== 'undefined')
        ? item.external_id
        : 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

      if (existing) {
        await DB.prepare(
          `UPDATE offers
           SET price       = COALESCE(?, price),
               image_url   = COALESCE(?, image_url),
               affiliate_url = COALESCE(NULLIF(?, ''), affiliate_url),
               last_updated = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(price, item.image_url, item.url, existing.id).run()

        if (price) {
          await DB.prepare(
            `UPDATE products
             SET best_price = COALESCE(?, best_price),
                 image_url  = COALESCE(?, image_url)
             WHERE id = ? AND (best_price IS NULL OR ? < best_price)`
          ).bind(price, item.image_url, existing.product_id, price).run()
        }
        updated++
      } else {
        const slug = slugify(name) + '-' + Date.now().toString(36)
        const insP = await DB.prepare(
          `INSERT INTO products (name, slug, best_price, image_url, is_active, created_at)
           VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`
        ).bind(name, slug, price, item.image_url).run()
        const productId = insP.meta.last_row_id as number

        await DB.prepare(
          `INSERT INTO offers
             (product_id, store_id, title, price, original_price,
              affiliate_url, checkout_url, image_url, in_stock, is_active,
              source, external_id, last_updated)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 1, 'shopee-affiliate', ?, CURRENT_TIMESTAMP)`
        ).bind(productId, storeId, name, price, item.url, item.url, item.image_url, extId).run()

        await DB.prepare(
          `UPDATE products SET best_store_id = ? WHERE id = ?`
        ).bind(storeId, productId).run()

        imported++
      }
    } catch (e: any) {
      errors++
    }
  }

  // Registra timestamp do último sync no api_configs
  await DB.prepare(`
    INSERT INTO api_configs (id, name, network, is_active, commission_rate, created_at, updated_at)
    VALUES ('shopee-afiliados','Shopee Afiliados','shopee-api',1,6.0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run().catch(() => {})

  return c.json({
    ok:        true,
    store_id:  storeId,
    store_name: store.name,
    fetched:   allItems.length,
    api_total: totalAPI,
    pages:     currentPage - 1,
    imported,
    updated,
    skipped,
    errors
  })
})
admin.post('/api/stores/shopee/fetch-links', async (c) => {
  const { DB } = c.env
  const body   = await c.req.json().catch(() => ({}))
  const { store_id, limit = 1000, period = 30 } = body

  // Busca credenciais salvas
  const cfg = await DB.prepare(
    `SELECT api_key, extra_json FROM api_configs WHERE id = 'shopee-afiliados'`
  ).first<any>()

  if (!cfg || !cfg.api_key) {
    // Sem credenciais — retorna instrução para configurar
    return c.json({
      ok: false,
      fetched: 0,
      links: [],
      message: 'Configure o Token API primeiro na aba "Token API".'
    })
  }

  const extra  = JSON.parse(cfg.extra_json || '{}')
  const appId  = cfg.api_key
  const secret = extra.secret || ''
  const subId  = extra.sub_id || 'kainow'

  // ── Tenta buscar via Shopee Open Platform API ──────────────────
  // Endpoint: GET /v2/affiliate/get_offer_list
  const links: string[] = []
  let page = 0
  const pageSize = 100
  const maxLinks = limit > 0 ? limit : 100000
  let hasMore = true

  try {
    while (hasMore && links.length < maxLinks) {
      const params = new URLSearchParams({
        app_id:    appId,
        token:     secret,
        page:      String(page),
        page_size: String(pageSize),
        scenario:  'ALL'
      })

      const res = await fetch(`https://open-api.affiliate.shopee.com.br/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`
        },
        body: JSON.stringify({
          query: `{ getOfferList(page: ${page}, pageSize: ${pageSize}) { offers { productLink affiliateLink } totalCount } }`
        })
      }).catch(() => null)

      if (!res || !res.ok) break

      const json: any = await res.json().catch(() => null)
      const offers = json?.data?.getOfferList?.offers || []

      if (!offers.length) { hasMore = false; break }

      for (const o of offers) {
        const link = o.affiliateLink || o.productLink
        if (link) links.push(link)
      }

      page++
      if (offers.length < pageSize) hasMore = false
    }
  } catch (_) { /* silencia — API pode não estar disponível */ }

  // ── Fallback: Se API não retornou nada, orienta o usuário ────────
  if (links.length === 0) {
    return c.json({
      ok: true,
      fetched: 0,
      links: [],
      message: 'A API da Shopee Afiliados requer credenciais válidas. Use o modo Manual para colar seus links.'
    })
  }

  // Atualiza timestamp de sync
  await DB.prepare(
    `UPDATE api_configs SET updated_at = CURRENT_TIMESTAMP WHERE id = 'shopee-afiliados'`
  ).run()

  return c.json({
    ok: true,
    fetched: links.length,
    links: links.slice(0, maxLinks)
  })
})

// ── POST /admin/api/stores/:storeId/import-links ─────────────────
// Importa produtos/links em massa para qualquer loja
// Aceita bloco de texto ou CSV com URLs (uma por linha)
// Cria produto + oferta no banco → aparece pro usuário final imediatamente
//
// Formato suportado no bloco de texto:
//   URL apenas:            https://meli.la/1guaPXV
//   URL | Nome:            https://meli.la/1guaPXV | Tênis Adidas
//   URL | Nome | Preço:    https://meli.la/1guaPXV | Tênis Adidas | 299.90
//   URL | Nome | Preço | Img: https://... | Nome | 299.90 | https://img...
// Formato CSV: url,name,price,image_url (primeira linha pode ser cabeçalho)
admin.post('/api/stores/:storeId/import-links', async (c) => {
  const { DB } = c.env
  const storeId = parseInt(c.req.param('storeId'))
  if (!storeId) return c.json({ error: 'storeId inválido' }, 400)

  // Busca a loja no banco
  const store = await DB.prepare(`SELECT id, name, slug, affiliate_network FROM stores WHERE id = ?`).bind(storeId).first<any>()
  if (!store) return c.json({ error: 'Loja não encontrada' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const raw: string = body.links || ''
  if (!raw.trim()) return c.json({ error: 'Nenhum link enviado' }, 400)

  // ══════════════════════════════════════════════════════════════
  // ROTA GENÉRICA — qualquer loja que NÃO seja Mercado Livre
  // Suporta links Shopee (s.shopee.com.br/xxx) com dados ricos
  // Formato por linha:
  //   URL simples:                   https://s.shopee.com.br/xxx
  //   URL|Nome:                      https://s.shopee.com.br/xxx|Tênis Nike
  //   URL|Nome|Preço:                https://...|Tênis Nike|299.90
  //   URL|Nome|Preço|Img|ExternalId: https://...|Nome|299.90|https://img...|item_123
  // ══════════════════════════════════════════════════════════════
  if (store.affiliate_network !== 'meli-api') {
    const rawLines = raw.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)
    const parsed: { url: string; name: string; price: number | null; image_url: string | null; external_id: string | null }[] = []

    // ── Helpers para classificar URLs por tipo ────────────────────────
    // URLs de imagem/CDN (nunca serão URL do produto)
    const isImageUrl = (u: string) =>
      /susercontent\.com|img\.susercontent|cloudfront\.net|imgix\.net|\.webp(\?|$)|\.jpg(\?|$)|\.jpeg(\?|$)|\.png(\?|$)|\.gif(\?|$)|cdn\.|img\.|images\./i.test(u)
    // URLs de produto/afiliado (sempre serão URL do produto quando encontradas)
    const isProductUrl = (u: string) =>
      /s\.shopee\.com\.br|shopee\.com\.br|meli\.la|mercadolivre\.com\.br|mercadolibre\.com|amazon\.com\.br|amzn\.to|magazineluiza|magalu|via\.com\.br|americanas\.com|submarino\.com\.br/i.test(u)

    for (const line of rawLines) {
      if (line.includes('|')) {
        const parts = line.split('|').map((p: string) => p.trim())

        // ── Formato A (padrão): URL-produto | Nome | Preço | Imagem ──────
        // Ex: https://s.shopee.com.br/xxx | Tênis Nike | 299.90 | https://img...
        // Condição: primeiro campo é URL de produto (não é imagem CDN)
        if (parts[0].startsWith('http') && !isImageUrl(parts[0])) {
          parsed.push({
            url:         parts[0],
            name:        parts[1] || '',
            price:       parts[2] ? parseFloat(parts[2].replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
            image_url:   parts[3] && parts[3].startsWith('http') ? parts[3] : null,
            external_id: parts[4] || null,
          })
          continue
        }

        // ── Formato B (rico): Nome | R$Valor | Imagem-CDN | URL-produto ──
        // Ex: Tênis Nike | R$299,90 | https://susercontent.com/img.webp | https://s.shopee.com.br/xxx
        // Detecta: campo que é URL de produto reconhecido (shopee, meli, amazon, etc.)
        const productUrlIdx = parts.findIndex((p: string) => p.startsWith('http') && isProductUrl(p))
        if (productUrlIdx >= 0) {
          const url     = parts[productUrlIdx]
          // Imagem: qualquer outro campo http (preferencialmente CDN de imagem)
          const imgIdx  = parts.findIndex((p: string, i: number) =>
            i !== productUrlIdx && p.startsWith('http'))
          // Preço: campo com padrão R$xxx,xx ou número com vírgula/ponto
          const priceStr = parts.find((p: string, i: number) =>
            i !== productUrlIdx && i !== imgIdx && /R?\$?\s*\d[\d.,]*/.test(p))
          // Nome: tudo que sobrou
          const nameParts = parts.filter((_: string, i: number) =>
            i !== productUrlIdx && i !== imgIdx && !(priceStr && parts[i] === priceStr))
          parsed.push({
            url,
            name:        nameParts.join(' ').trim(),
            price:       priceStr ? parseFloat(priceStr.replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
            image_url:   imgIdx >= 0 ? parts[imgIdx] : null,
            external_id: null,
          })
          continue
        }

        // ── Formato C: fallback — primeiro campo http não-imagem é a URL ─
        // Útil para outros domínios não listados acima
        const anyProductIdx = parts.findIndex((p: string) => p.startsWith('http') && !isImageUrl(p))
        const anyUrlIdx     = anyProductIdx >= 0 ? anyProductIdx : parts.findIndex((p: string) => p.startsWith('http'))
        if (anyUrlIdx >= 0) {
          const url    = parts[anyUrlIdx]
          const imgIdx = parts.findIndex((p: string, i: number) => i !== anyUrlIdx && p.startsWith('http'))
          const priceStr = parts.find((p: string, i: number) =>
            i !== anyUrlIdx && i !== imgIdx && /R?\$?\s*\d[\d.,]*/.test(p))
          const nameParts = parts.filter((_: string, i: number) =>
            i !== anyUrlIdx && i !== imgIdx && !(priceStr && parts[i] === priceStr))
          parsed.push({
            url,
            name:        nameParts.join(' ').trim(),
            price:       priceStr ? parseFloat(priceStr.replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
            image_url:   imgIdx >= 0 ? parts[imgIdx] : null,
            external_id: null,
          })
        }
      } else if (line.startsWith('http')) {
        parsed.push({ url: line, name: '', price: null, image_url: null, external_id: null })
      }
    }

    if (!parsed.length) return c.json({ error: 'Nenhuma linha válida encontrada' }, 400)

    const slugifyGeneric = (t: string): string =>
      t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120)

    // Detecta se é loja Shopee pelo affiliate_network ou pelo domínio dos links
    const isShopeeStore = store.affiliate_network === 'shopee-api'
      || store.affiliate_network === 'lomadee'
      || store.affiliate_network === 'socialsoul'
      || parsed.some(p => p.url.includes('shopee') || p.url.includes('s.shopee'))

    // Source label para rastreabilidade
    const sourceLabel = isShopeeStore ? 'shopee-affiliate' : 'manual'

    let imported = 0, updated = 0, skipped = 0, errors = 0
    const results: any[] = []

    for (const item of parsed) {
      if (!item.url) { skipped++; continue }
      try {
        // ── RESOLUÇÃO AUTOMÁTICA de links curtos Shopee ──────────────────
        // s.shopee.com.br/HASH → extrai shopid/itemid → busca nome, preço e imagem
        const isShortShopeeLink = /s\.shopee\.com\.br\//i.test(item.url)
        let resolvedShopeeId: string | null = item.external_id || null
        let resolvedShopeeShopId: string | null = null

        if (isShopeeStore && isShortShopeeLink && (!item.name || !item.price)) {
          try {
            const shopeeData = await resolveAndFetchShopee(item.url)
            if (shopeeData.itemId) {
              resolvedShopeeId     = shopeeData.itemId
              resolvedShopeeShopId = shopeeData.shopId
              if (!item.name  && shopeeData.title) item.name      = shopeeData.title
              if (!item.price && shopeeData.price) item.price     = shopeeData.price
              if (!item.image_url && shopeeData.image) item.image_url = shopeeData.image
            }
          } catch { /* ignora — continua com dados parciais */ }
        }

        // Dedup: normaliza URL removendo query string para comparação
        let baseUrl = item.url
        try { baseUrl = new URL(item.url).origin + new URL(item.url).pathname } catch { /* ignora */ }

        // Para Shopee, dedup por itemId (chave canônica) em vez de URL
        // Links diferentes podem apontar para o mesmo produto
        let existing: any = null
        const dedupExtId = resolvedShopeeId || item.external_id
        if (dedupExtId) {
          existing = await DB.prepare(
            `SELECT o.id, o.product_id, o.price FROM offers o
             WHERE o.external_id = ? LIMIT 1`
          ).bind(dedupExtId).first<any>()
        }
        if (!existing) {
          existing = await DB.prepare(
            `SELECT o.id, o.product_id, o.price FROM offers o
             WHERE o.affiliate_url = ? OR o.affiliate_url = ? LIMIT 1`
          ).bind(item.url, baseUrl).first<any>()
        }

        // Nome: usa o fornecido (resolvido via Shopee) ou extrai da URL
        let name = (item.name || '').trim()
        if (!name) {
          try {
            const pth = new URL(item.url).pathname
            const slug = pth.replace(/\/$/, '').split('/').filter(Boolean).pop() || ''
            // Só usa slug se NÃO for um hash curto (ex: "2qRS7tomiu")
            if (slug && slug.length >= 4 && !/^[A-Za-z0-9]{4,12}$/.test(slug)) {
              name = slug.replace(/-+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).trim().substring(0, 120)
            }
          } catch { /* ignora */ }
        }
        // Para links curtos Shopee sem nome resolvido, usa placeholder rastreável
        if (!name) {
          const hash = item.url.split('/').filter(Boolean).pop() || ''
          name = isShopeeStore ? `Produto Shopee ${hash}` : 'Produto Importado ' + Date.now().toString(36).toUpperCase()
        }

        const price = item.price && item.price > 0 ? item.price : null
        const slug  = slugifyGeneric(name) + '-' + Date.now().toString(36)
        // extId: usa itemId da Shopee resolvido como chave canônica de dedup
        const extId = resolvedShopeeId || item.external_id || ('imp-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6))

        // URL canônica Shopee para refresh interno de preço/imagem
        const canonicalShopeeUrl = (isShopeeStore && resolvedShopeeShopId && resolvedShopeeId)
          ? `https://shopee.com.br/product/${resolvedShopeeShopId}/${resolvedShopeeId}`
          : null

        if (existing) {
          // Atualiza oferta existente com novos dados se disponíveis
          await DB.prepare(
            `UPDATE offers
             SET price             = COALESCE(?, price),
                 image_url         = COALESCE(?, image_url),
                 affiliate_url     = COALESCE(NULLIF(?, ''), affiliate_url),
                 shopee_product_url = COALESCE(?, shopee_product_url),
                 last_updated      = CURRENT_TIMESTAMP
             WHERE id = ?`
          ).bind(price, item.image_url, item.url, canonicalShopeeUrl, existing.id).run()

          if (price) {
            await DB.prepare(
              `UPDATE products
               SET best_price = COALESCE(?, best_price),
                   image_url  = COALESCE(?, image_url)
               WHERE id = ? AND (best_price IS NULL OR ? < best_price)`
            ).bind(price, item.image_url, existing.product_id, price).run()
          }

          updated++
          results.push({ action: 'updated', url: item.url, name })
        } else {
          // Cria produto novo
          const insP = await DB.prepare(
            `INSERT INTO products (name, slug, best_price, image_url, is_active, created_at)
             VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`
          ).bind(name, slug, price, item.image_url).run()
          const productId = insP.meta.last_row_id as number

          // Cria oferta com source rastreável
          await DB.prepare(
            `INSERT INTO offers
               (product_id, store_id, title, price, original_price,
                affiliate_url, checkout_url, image_url, in_stock, is_active,
                source, external_id, shopee_product_url, last_updated)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 1, ?, ?, ?, CURRENT_TIMESTAMP)`
          ).bind(productId, storeId, name, price ?? 0,
            item.url, item.url, item.image_url,
            sourceLabel, extId, canonicalShopeeUrl).run()

          // Atualiza best_store_id no produto
          await DB.prepare(
            `UPDATE products SET best_store_id = ? WHERE id = ?`
          ).bind(storeId, productId).run()

          imported++
          results.push({ action: 'imported', url: item.url, name })
        }
      } catch (e: any) {
        errors++
        results.push({ action: 'error', url: item.url, error: e?.message })
      }
    }

    return c.json({
      ok: true,
      store_id: storeId,
      store_name: store.name,
      total: parsed.length,
      imported,
      updated,
      skipped,
      errors,
      results,
    })
  }

  // ══════════════════════════════════════════════════════════════
  // ROTA MERCADO LIVRE (meli-api) — lógica completa preservada
  // NÃO MEXER: dedup ml_item_id, /social/, wid=, hint_mlb_id, tudo
  // ══════════════════════════════════════════════════════════════
  // Cada linha pode ser:
  //   - só URL
  //   - URL | Nome
  //   - URL | Nome | Preço
  //   - URL | Nome | Preço | ImageURL
  //   - CSV: url,name,price,image_url
  // Separa linhas — também divide 2 URLs coladas na mesma linha por espaço
  // Normaliza URL: converte #...&wid=MLB... (fragment) para ?wid=MLB... (query param)
  // Necessário para URLs coladas diretamente sem passar pelo frontend (siExtractUrlsFromText)
  // Também remove o restante do fragment (ex: #polycard_client=...) que não é necessário
  function normalizeFragmentWid(u: string): string {
    if (!u.includes('#')) return u
    const hashIdx = u.indexOf('#')
    const base    = u.substring(0, hashIdx)
    const frag    = u.substring(hashIdx + 1)
    const widMatch = frag.match(/(?:^|[&?])wid=(MLB[\w-]+)/i)
    if (widMatch) {
      const sep = base.includes('?') ? '&' : '?'
      return base + sep + 'wid=' + widMatch[1]
    }
    return base // descarta fragment sem wid=
  }

  const rawLines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const lines: string[] = []
  for (const l of rawLines) {
    const parts = l.split(/\s+/).filter(Boolean)
    if (parts.length >= 2 && parts.every(p => p.startsWith('http'))) {
      // Linha com 2+ URLs separadas por espaço (ex: "url_produto url_social")
      // Normaliza cada URL: converte #...&wid= para ?wid= (mesmo comportamento do frontend)
      lines.push(...parts.map(normalizeFragmentWid))
    } else if (l.startsWith('http') && l.includes('#')) {
      // URL simples com fragment — normaliza para remover fragment e converter wid=
      lines.push(normalizeFragmentWid(l))
    } else {
      lines.push(l)
    }
  }

  // Detecta se é CSV (primeira linha tem vírgula e parece cabeçalho)
  const firstLine = lines[0] || ''
  const isCSV = /^url[,;]/i.test(firstLine) || (firstLine.includes(',') && !firstLine.startsWith('http'))

  // Pula cabeçalho CSV se existir
  const dataLines = isCSV && /^url[,;]/i.test(firstLine) ? lines.slice(1) : lines

  interface ParsedItem {
    url: string
    name: string
    price: number | null
    image_url: string | null
    hint_mlb_id: string | null   // MLB-ID passado pelo frontend como hint (campo 5: "mlb:XXXXXXXX")
  }

  function parseLine(line: string): ParsedItem | null {
    // Tenta separar por | (bloco de texto)
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim())
      const url = parts[0]
      if (!url.startsWith('http')) return null
      // Hint MLB: aceita em QUALQUER campo após o 1º com prefixo "mlb:"
      // Formato enviado pelo frontend: "url | mlb:MLB123" (2 campos)
      // Formato legado:                "url | nome | preço | img | mlb:MLB123" (5 campos)
      let hintMlbId: string | null = null
      let namePart = ''
      let pricePart = ''
      let imagePart = ''
      for (let pi = 1; pi < parts.length; pi++) {
        const p = parts[pi]
        const mlbMatch = p.match(/^mlb:(.+)$/i)
        if (mlbMatch) {
          hintMlbId = mlbMatch[1].trim()
        } else if (pi === 1 && !mlbMatch) {
          namePart = p
        } else if (pi === 2) {
          pricePart = p
        } else if (pi === 3) {
          imagePart = p
        }
      }
      return {
        url,
        name: namePart,
        price: pricePart ? parseFloat(pricePart.replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
        image_url: imagePart && imagePart.startsWith('http') ? imagePart : null,
        hint_mlb_id: hintMlbId,
      }
    }
    // Tenta separar por , (CSV)
    if (line.includes(',')) {
      const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''))
      const url = parts[0]
      if (!url.startsWith('http')) return null
      return {
        url,
        name: parts[1] || '',
        price: parts[2] ? parseFloat(parts[2].replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
        image_url: parts[3] && parts[3].startsWith('http') ? parts[3] : null,
        hint_mlb_id: null,
      }
    }
    // Só URL
    if (line.startsWith('http')) {
      return { url: line, name: '', price: null, image_url: null, hint_mlb_id: null }
    }
    return null
  }

  if (dataLines.length === 0) return c.json({ error: 'Nenhuma linha válida encontrada' }, 400)
  // ML (meli-api) e Shopee: limita a 10 por chamada
  // ML: 5-8 queries D1 por item (dedup complexo)
  // Shopee: resolve 2 HTTP requests por item (resolveAndFetchShopee)
  // Outras lojas: 50 por chamada (queries simples, sem HTTP externo)
  const CHUNK_LIMIT = 10
  const dataChunk = dataLines.slice(0, CHUNK_LIMIT)
  const hasMore   = dataLines.length > CHUNK_LIMIT

  // ── Processa cada linha ──────────────────────────────────────
  function slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 120)
  }

  // ── Pré-processa pares: produto + link afiliado (com cfegdhabc31955)
  // Cenários:
  //   A) Frontend enviou "socialUrl | Nome | Preço | Img | mlb:XXXXXXXX" → linha com /social/ + hint
  //   B) Duas linhas separadas: linha produto + linha /social/ pura (sem |)
  //   C) Linha normal de produto sem /social/
  interface PairItem {
    productUrl: string
    affiliateUrl: string | null
    name: string
    price: number | null
    image_url: string | null
    hint_mlb_id: string | null  // MLB-ID fornecido pelo frontend como hint de deduplicação
  }
  const pairedItems: PairItem[] = []

  for (let i = 0; i < dataChunk.length; i++) {
    const line = dataChunk[i]
    const item = parseLine(line)
    if (!item) { continue }

    const isSocialLink = /mercadolivre\.com\.br\/social\//.test(item.url)

    // Caso B: linha pura "/social/" sem nome E sem hint_mlb_id
    //   → associa ao produto anterior como affiliate_url (par produto+social em 2 linhas)
    //   CONDIÇÃO: sem hint_mlb_id — se tem hint, veio da aba "Em Massa" e é link principal (Caso A)
    if (isSocialLink && !item.name && !item.hint_mlb_id && pairedItems.length > 0 && pairedItems[pairedItems.length - 1].affiliateUrl === null) {
      pairedItems[pairedItems.length - 1].affiliateUrl = item.url
      continue
    }

    // Caso A: link /social/ com nome OU com hint_mlb_id (veio da aba "Em Massa")
    //   → socialUrl É o affiliate_url principal (já tem tracking embutido)
    //   Também cobre /social/ puro sem par anterior (affiliateUrl != null ou lista vazia)
    //   nesses casos cria item sem nome — enrich completará depois
    if (isSocialLink) {
      pairedItems.push({ productUrl: item.url, affiliateUrl: item.url, name: item.name, price: item.price, image_url: item.image_url, hint_mlb_id: item.hint_mlb_id })
    } else {
      // Caso C: produto normal (não é /social/)
      pairedItems.push({ productUrl: item.url, affiliateUrl: null, name: item.name, price: item.price, image_url: item.image_url, hint_mlb_id: item.hint_mlb_id })
    }
  }

  const results: any[] = []
  let imported = 0   // novos produtos/offers criados
  let updated  = 0   // offers existentes atualizadas (preço/imagem/url)
  let skipped  = 0
  let duplicates = 0
  let errors   = 0

  for (const item of pairedItems) {
    const { productUrl, affiliateUrl: affUrl, name: rawName, price: rawPrice, image_url, hint_mlb_id } = item
    // Usa o link afiliado correto (/social/ com ref=) se disponível, senão usa a URL do produto
    const finalAffiliateUrl = affUrl || productUrl
    if (!finalAffiliateUrl) { skipped++; continue }

    const affiliateUrl = finalAffiliateUrl
    let name = (rawName || '').trim()
    let resolvedPrice: number | null = rawPrice ?? null
    let resolvedImage: string | null = image_url || null
    let resolvedMlbId: string | null = hint_mlb_id || null

    // ── RESOLUÇÃO AUTOMÁTICA de links curtos meli.la ─────────────
    // Para links meli.la sem MLB ID conhecido, resolve o redirect e extrai
    // MLB ID, nome, preço e imagem da página /social/ do ML
    // Isso garante deduplicação correta por ml_item_id, não por nome
    const isShortMeliLink = /meli\.la\/|mlv\.cl\/|merc\.ad\//i.test(affiliateUrl)
    const hasNoMlb = !resolvedMlbId && !/MLB\d{6,12}/i.test(affiliateUrl) && !/MLB\d{6,12}/i.test(productUrl)
    if (isShortMeliLink && hasNoMlb) {
      try {
        const resolved = await resolveAndFetchML(affiliateUrl)
        if (resolved.mlbId) resolvedMlbId = resolved.mlbId.replace(/^MLB/i, '')
        if (!name && resolved.title) name = resolved.title
        if (!resolvedPrice && resolved.price) resolvedPrice = resolved.price
        if (!resolvedImage && resolved.image) resolvedImage = resolved.image
      } catch { /* ignora — continua com dados parciais */ }
    }
    if (!name) {
      const tryUrl = productUrl || affiliateUrl
      // Para URLs /social/ ou meli.la não usar path como nome (não tem slug útil)
      const isSocialTryUrl = /mercadolivre\.com\.br\/social\//.test(tryUrl)
      const isMeliLa = /meli\.la\/|mlv\.cl\/|merc\.ad\//i.test(tryUrl)
      if (!isSocialTryUrl && !isMeliLa) {
        try {
          const pth = new URL(tryUrl).pathname
          // Remove segmentos de ID do fim do path antes de pegar o slug:
          // - /p/MLB123456     (URL universal de produto)
          // - /MLB123456       (URL direta de produto)
          // - /up/MLBU123456   (URL afiliada com rastreamento uplift)
          const cleanPath = pth
            .replace(/\/up\/MLBU[\w-]*/i, '')   // remove /up/MLBU...
            .replace(/\/p\/MLB[\w-]*/i, '')     // remove /p/MLB...
            .replace(/\/MLB[\w-]*/i, '')        // remove /MLB...
          const slug = cleanPath.replace(/\/$/, '').split('/').filter(Boolean).pop() || ''
          if (slug && slug.length >= 4 && !/^MLB[U]?\d/i.test(slug)) {
            name = slug.replace(/-+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).trim().substring(0, 120)
          }
          if (!name) {
            const mlb = (pth + new URL(tryUrl).search).match(/\b(MLB\d{6,12})\b/i)
            if (mlb) name = 'Produto ' + mlb[1].toUpperCase()
          }
        } catch { /* ignora */ }
      }
    }

    // Último recurso: nome genérico (nunca rejeita por falta de nome)
    // Para /social/ com hint_mlb_id, usa o MLB-ID como referência temporária
    if (!name) {
      if (resolvedMlbId) {
        name = 'Produto MLB' + resolvedMlbId
      } else if (hint_mlb_id) {
        const digitsOnly = hint_mlb_id.replace(/^MLB[\-_]?/i, '')
        name = 'Produto MLB' + digitsOnly
      } else {
        name = 'Produto Importado ' + Date.now().toString(36).toUpperCase()
      }
    }

    const price   = resolvedPrice ?? 0
    const imgUrl  = resolvedImage || null
    const slug    = slugify(name) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)
    const extId   = 'import-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)

    try {
      // 1) Cria o produto se não existir (ou cria novo se sem nome único)
      let productId: number | null = null

      // ── DEDUPLICAÇÃO: localiza offer existente com chave precisa ────────
      // Ordem de prioridade (do mais confiável ao menos):
      //   0) hint_mlb_id passado pelo frontend — MLB-ID resolvido pelo resolve-url (PRIORIDADE MÁXIMA)
      //      Usado quando saveUrl é /social/ mas o produto tem MLB-ID conhecido via url1
      //   1) MLB-ID extraído da URL (produto ou affiliateUrl com MLB na path)
      //   2) ref= da URL /social/ como fingerprint (quando nenhum MLB disponível)
      //   3) URL exata sem query string (fallback último recurso)
      // NUNCA usar LIKE %cfegdhabc31955% — publisher_id é igual em TODOS os links.

      // Extrai wid= da URL do produto (query param OU fragment — backend normaliza antes)
      // O wid é o item-ID da variante (cor/tamanho) — tem prioridade para dedup precisa
      // Busca tanto ?wid= (após normalizeFragmentWid) quanto #...&wid= (por segurança)
      const widMatch = productUrl.match(/[?&]wid=(MLB[\w-]+)/i)
                    || productUrl.match(/#[^?]*(?:^|[&?])wid=(MLB[\w-]+)/i)
      const widMlbId = widMatch ? widMatch[1].replace(/-/g, '') : null

      // Prioridade 0: resolvedMlbId — resolvido via resolveAndFetchML (link meli.la)
      // Prioridade 1: hint do frontend (MLB-ID resolvido via url1 quando saveUrl=/social/)
      // Prioridade 2: wid= da URL (variante específica — mais preciso que MLB do path)
      // Normaliza para sempre SÓ DÍGITOS
      const rawMlbId: string | null =
        resolvedMlbId                                          // resolvido via resolveAndFetchML
        ?? hint_mlb_id                                         // frontend resolveu via url1
        ?? widMlbId                                            // wid= da variante (query param)
        ?? productUrl.match(/MLB[\-_]?(\d+)/i)?.[1]           // MLB na url do produto
        ?? affiliateUrl.match(/MLB[\-_]?(\d+)/i)?.[1]         // MLB no affiliateUrl
        ?? null
      // Remove prefixo "MLB" se presente — LIKE usa sempre %MLB-DIGITS% e %MLBDIGITS%
      const effectiveMlbId: string | null = rawMlbId
        ? rawMlbId.replace(/^MLB[\-_]?/i, '')
        : null

      // Extrai ref= da URL /social/ — fingerprint único por produto (fallback)
      const refMatch = affiliateUrl.match(/[?&]ref=([^&]+)/)
      const socialRef = refMatch ? refMatch[1] : null

      let existingAnyStore: any = null

      if (effectiveMlbId) {
        // ── PRIORIDADE 1: ml_item_id no produto (chave canônica, mais confiável) ──
        // Cobre TODOS os casos: affiliate_url /social/ (sem MLB na string),
        // produto.mercadolivre.com.br/MLB-XXXX, mercadolivre.com.br/.../p/MLBXXXX, etc.
        // ml_item_id salvo sempre como só dígitos, effectiveMlbId também é só dígitos → match direto
        const byMlItemId = await DB.prepare(
          `SELECT o.id, p.id as product_id, COALESCE(o.title, p.name) as title,
                  o.store_id, o.affiliate_url, s.name as store_name
           FROM products p
           LEFT JOIN offers o ON o.product_id = p.id
           LEFT JOIN stores s ON s.id = o.store_id
           WHERE p.ml_item_id = ?
           ORDER BY o.is_active DESC
           LIMIT 1`
        ).bind(effectiveMlbId).first<any>()
        if (byMlItemId) existingAnyStore = byMlItemId

        // ── PRIORIDADE 2: MLB-ID na affiliate_url salva (produto.mercadolivre.com.br/MLB-XXXXX) ──
        // Necessário quando ml_item_id ainda não foi preenchido (produto recém importado)
        if (!existingAnyStore) {
          existingAnyStore = await DB.prepare(
            `SELECT o.id, o.product_id, o.title, o.store_id, o.affiliate_url, s.name as store_name
             FROM offers o
             LEFT JOIN stores s ON s.id = o.store_id
             WHERE o.affiliate_url LIKE ? OR o.affiliate_url LIKE ?
             LIMIT 1`
          ).bind(`%MLB-${effectiveMlbId}%`, `%MLB${effectiveMlbId}%`).first<any>()
        }
      } else if (socialRef) {
        // /social/ sem MLB visível → ref= é fingerprint único por produto
        existingAnyStore = await DB.prepare(
          `SELECT o.id, o.product_id, o.title, o.store_id, o.affiliate_url, s.name as store_name
           FROM offers o
           LEFT JOIN stores s ON s.id = o.store_id
           WHERE o.affiliate_url LIKE ?
           LIMIT 1`
        ).bind(`%ref=${socialRef}%`).first<any>()
      } else {
        // Fallback: URL exata sem query string
        const baseUrl = affiliateUrl.split('?')[0]
        existingAnyStore = await DB.prepare(
          `SELECT o.id, o.product_id, o.title, o.store_id, o.affiliate_url, s.name as store_name
           FROM offers o
           LEFT JOIN stores s ON s.id = o.store_id
           WHERE o.affiliate_url = ? OR o.affiliate_url LIKE ?
           LIMIT 1`
        ).bind(affiliateUrl, `${baseUrl}%`).first<any>()
      }

      if (existingAnyStore) {
        const isSameStore = existingAnyStore.store_id === storeId

        if (isSameStore) {
          // Mesma loja → atualiza dados e, SEMPRE, o affiliate_url se o novo for /social/
          const incomingIsSocial = /mercadolivre\.com\.br\/social\//.test(affiliateUrl)
          const existingIsSocial = /mercadolivre\.com\.br\/social\//.test(existingAnyStore.affiliate_url || '')
          // Atualiza affiliate_url quando: o novo é /social/ E o atual não é /social/
          const shouldUpdateAffUrl = incomingIsSocial && !existingIsSocial

          const hasNewName  = name && name !== existingAnyStore.title
          const hasNewPrice = price > 0

          if (shouldUpdateAffUrl || hasNewName || hasNewPrice) {
            await DB.prepare(`
              UPDATE offers SET
                title        = CASE WHEN ? != '' THEN ? ELSE title END,
                price        = CASE WHEN ? > 0   THEN ? ELSE price END,
                image_url    = CASE WHEN ? != '' THEN ? ELSE image_url END,
                affiliate_url = CASE WHEN ? = 1  THEN ? ELSE affiliate_url END,
                last_updated = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(
              name, name,
              price, price,
              imgUrl||'', imgUrl||'',
              shouldUpdateAffUrl ? 1 : 0, affiliateUrl,
              existingAnyStore.id
            ).run()

            await DB.prepare(`
              UPDATE products SET
                name       = CASE WHEN ? != '' THEN ? ELSE name END,
                best_price = CASE WHEN ? > 0 AND (best_price IS NULL OR ? < best_price) THEN ? ELSE best_price END,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(name, name, price, price, price, existingAnyStore.product_id).run()

            const updateInfo = shouldUpdateAffUrl ? ' (affiliate_url atualizado para /social/)' : ''
            results.push({ url: affiliateUrl, status: 'atualizado', product_id: existingAnyStore.product_id, name, info: updateInfo.trim() })
            updated++
          } else {
            // Idêntico — duplicado puro
            duplicates++
            results.push({
              url: affiliateUrl,
              status: 'duplicado',
              product_id: existingAnyStore.product_id,
              product_name: existingAnyStore.title,
              message: 'Link já importado nesta loja — ignorado',
            })
          }
        } else {
          // Link já existe em OUTRA loja — recusa para evitar duplicação cruzada
          duplicates++
          results.push({
            url: affiliateUrl,
            status: 'duplicado',
            product_id: existingAnyStore.product_id,
            product_name: existingAnyStore.title,
            existing_store: existingAnyStore.store_name,
            message: `Link já importado na loja "${existingAnyStore.store_name}" — ignorado`,
          })
        }
        continue
      }

      // Cria produto novo — mas primeiro verifica se já existe produto com mesmo nome
      // Evita duplicatas quando o mesmo arquivo é importado mais de uma vez
      const existingByName = await DB.prepare(
        `SELECT id FROM products WHERE name = ? LIMIT 1`
      ).bind(name).first<{ id: number }>()

      if (existingByName) {
        // Produto com mesmo nome já existe — vincula offer ao produto existente
        const productId2 = existingByName.id

        // Verifica se offer já existe para este produto+loja
        const offerExists = await DB.prepare(
          `SELECT id, affiliate_url FROM offers WHERE product_id = ? AND store_id = ? LIMIT 1`
        ).bind(productId2, storeId).first<{ id: number; affiliate_url: string }>()

        if (offerExists) {
          // Offer existe: atualiza preço/imagem/affiliate_url se houver dados melhores
          // (novo link /social/, preço atualizado, imagem nova)

          // Oportunidade: preenche ml_item_id se estava NULL e agora temos o valor
          if (effectiveMlbId) {
            await DB.prepare(`UPDATE products SET ml_item_id = ? WHERE id = ? AND (ml_item_id IS NULL OR ml_item_id = '')`).bind(effectiveMlbId, productId2).run().catch(() => {})
          }
          const incomingIsSocial  = /mercadolivre\.com\.br\/social\//.test(affiliateUrl)
          const existingIsSocial  = /mercadolivre\.com\.br\/social\//.test(offerExists.affiliate_url || '')
          const shouldUpdateAffUrl = incomingIsSocial && !existingIsSocial

          await DB.prepare(`
            UPDATE offers SET
              title        = CASE WHEN ? != '' THEN ? ELSE title END,
              price        = CASE WHEN ? > 0   THEN ? ELSE price END,
              image_url    = CASE WHEN ? != '' THEN ? ELSE image_url END,
              affiliate_url = CASE WHEN ? = 1  THEN ? ELSE affiliate_url END,
              last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            name, name,
            price, price,
            imgUrl || '', imgUrl || '',
            shouldUpdateAffUrl ? 1 : 0, affiliateUrl,
            offerExists.id
          ).run()

          await DB.prepare(`
            UPDATE products SET
              best_price = CASE WHEN ? > 0 AND (best_price IS NULL OR ? < best_price) THEN ? ELSE best_price END,
              image_url  = CASE WHEN ? != '' AND (image_url IS NULL OR image_url = '') THEN ? ELSE image_url END,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(price, price, price, imgUrl || '', imgUrl || '', productId2).run()

          updated++
          results.push({ url: affiliateUrl, status: 'atualizado', product_id: productId2, name, price, message: 'Offer atualizado com novos dados' })
          continue
        }

        // Offer não existe para esta loja → cria offer vinculado ao produto existente
        // Oportunidade: preenche ml_item_id se estava NULL e agora temos o valor
        if (effectiveMlbId) {
          await DB.prepare(`UPDATE products SET ml_item_id = ? WHERE id = ? AND (ml_item_id IS NULL OR ml_item_id = '')`).bind(effectiveMlbId, productId2).run().catch(() => {})
        }
        await DB.prepare(`
          INSERT INTO offers
            (product_id, store_id, external_id, title, price, affiliate_url, image_url,
             is_active, in_stock, free_shipping, source, created_at, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(productId2, storeId, extId, name, price > 0 ? price : 0, affiliateUrl, imgUrl).run()

        await DB.prepare(`
          UPDATE products SET offer_count = offer_count + 1,
            best_price = CASE WHEN best_price IS NULL OR (? > 0 AND ? < best_price) THEN ? ELSE best_price END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, price, price, productId2).run()

        imported++
        results.push({ url: affiliateUrl, status: 'importado', product_id: productId2, name, price })
        continue
      }

      // Auto-detecta categoria pelo nome + URL do produto
      const detectedCategory = detectCategoryWithFallback(
        name,
        productUrl || affiliateUrl || '',
        null
      )

      const prodResult = await DB.prepare(`
        INSERT INTO products (name, slug, category, source, is_active, ml_item_id, created_at, updated_at, best_price, best_store_id)
        VALUES (?, ?, ?, 'manual', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
      `).bind(name, slug, detectedCategory || 'outros', effectiveMlbId || null, price > 0 ? price : null, storeId).run()

      productId = prodResult.meta.last_row_id as number

      if (imgUrl) {
        await DB.prepare(`UPDATE products SET image_url = ? WHERE id = ?`).bind(imgUrl, productId).run()
      }

      // 2) Cria a oferta vinculada ao produto + loja
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, affiliate_url, image_url,
           is_active, in_stock, free_shipping, source, created_at, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        productId, storeId, extId,
        name, price > 0 ? price : 0,
        affiliateUrl, imgUrl
      ).run()

      // 3) Atualiza contadores do produto
      await DB.prepare(`
        UPDATE products
        SET offer_count = offer_count + 1,
            best_price = CASE WHEN best_price IS NULL OR ? < best_price THEN ? ELSE best_price END,
            best_store_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(price > 0 ? price : 0, price > 0 ? price : 0, storeId, productId).run()

      // 4) Incrementa product_count da categoria no banco (inclui 'outros')
      await DB.prepare(`
        UPDATE categories SET product_count = product_count + 1
        WHERE slug = ? AND is_active = 1
      `).bind(detectedCategory || 'outros').run().catch(() => {})

      results.push({ url: affiliateUrl, status: 'importado', product_id: productId, name, category: detectedCategory })
      imported++

    } catch (e: any) {
      results.push({ url: affiliateUrl, status: 'erro', error: e?.message || String(e) })
      errors++
    }
  }

  return c.json({
    ok: true,
    store_id: storeId,
    store_name: store.name,
    total: dataChunk.length,
    total_received: dataLines.length,
    has_more: hasMore,
    imported,
    updated,
    duplicates,
    skipped,
    errors,
    results,
  })
})

// ── GET /admin/api/stores/:storeId/import-links/history ──────────
admin.get('/api/stores/:storeId/import-links/history', async (c) => {
  const { DB } = c.env
  const storeId = parseInt(c.req.param('storeId'))
  const rows = await DB.prepare(`
    SELECT o.id, o.title, o.affiliate_url, o.price, o.image_url, o.created_at, p.slug
    FROM offers o
    LEFT JOIN products p ON p.id = o.product_id
    WHERE o.store_id = ? AND o.source = 'manual'
    ORDER BY o.created_at DESC
    LIMIT 100
  `).bind(storeId).all<any>()
  return c.json({ results: rows.results })
})

// ── POST /admin/api/sync-products-from-offers ─────────────────────────────
// Copia image_url, best_price, title e best_store_id da offer mais barata
// para cada produto que está com esses campos em branco.
// Roda em lotes de 100 — chame várias vezes até "synced: 0".
admin.post('/api/sync-products-from-offers', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const BATCH = Math.min(parseInt(body.limit) || 100, 200)

  // Produtos que ainda precisam de sync: sem image_url OU sem best_price
  const { results: prods } = await DB.prepare(`
    SELECT p.id
    FROM products p
    WHERE p.is_active = 1
      AND (p.image_url IS NULL OR p.image_url = '' OR p.best_price IS NULL)
    LIMIT ?
  `).bind(BATCH).all<{ id: number }>()

  if (!prods.length) {
    return c.json({ ok: true, synced: 0, message: 'Todos os produtos já estão sincronizados.' })
  }

  let synced = 0
  for (const prod of prods) {
    // Pega a offer com menor preço > 0 com imagem disponível para este produto
    const best = await DB.prepare(`
      SELECT o.price, o.image_url, o.title, o.store_id
      FROM offers o
      WHERE o.product_id = ?
        AND o.is_active = 1
        AND o.price > 0
        AND o.image_url IS NOT NULL AND o.image_url != ''
      ORDER BY o.price ASC LIMIT 1
    `).bind(prod.id).first<any>()

    if (!best) continue  // offer ainda sem dados — pula

    await DB.prepare(`
      UPDATE products SET
        best_price    = CASE WHEN best_price IS NULL OR ? < best_price THEN ? ELSE best_price END,
        image_url     = CASE WHEN image_url IS NULL OR image_url = '' THEN ? ELSE image_url END,
        name          = CASE WHEN name LIKE 'Produto Import%' OR name LIKE 'cfegdhabc%' THEN ? ELSE name END,
        best_store_id = CASE WHEN best_store_id IS NULL THEN ? ELSE best_store_id END,
        offer_count   = CASE WHEN offer_count = 0 THEN 1 ELSE offer_count END,
        updated_at    = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      best.price, best.price,
      best.image_url,
      best.title || ('Produto ' + prod.id),
      best.store_id,
      prod.id
    ).run()

    synced++
  }

  const remaining = prods.length === BATCH ? '?' : '0'
  return c.json({
    ok: true,
    synced,
    total_checked: prods.length,
    message: `${synced} produtos sincronizados das offers.`,
  })
})

// ── POST /admin/api/fix-names — Corrige nomes ruins tentando API ML primeiro ──
// 1ª tentativa: busca nome real via API ML (/items/{mlbId}) pelo ml_item_id ou slug
// 2ª tentativa (fallback): deleta produto inválido se não conseguir resolver
admin.post('/api/fix-names', async (c) => {
  const { DB } = c.env

  // Busca produtos com nome inválido + ml_item_id para tentar recuperar
  const { results: badProds } = await DB.prepare(
    `SELECT p.id, p.name, p.ml_item_id, p.slug,
            o.affiliate_url
     FROM products p
     LEFT JOIN offers o ON o.product_id = p.id
     WHERE p.name LIKE 'cfegdhabc%'
        OR p.name LIKE 'Cfegdhabc%'
        OR p.name LIKE 'Produto MLB%'
        OR p.name LIKE 'Produto Import%'
     LIMIT 50`
  ).all<{ id: number; name: string; ml_item_id: string | null; slug: string; affiliate_url: string | null }>()

  let fixed = 0
  let deleted = 0
  const details: { id: number; old: string; new?: string; action: string }[] = []

  // Helper inline para extrair MLB-ID de string
  const xMlb = (s: string | null): string | null => {
    if (!s) return null
    const m = s.match(/\b(MLB)-?(\d{6,12})\b/i)
    return m ? ('MLB' + m[2]).toUpperCase() : null
  }

  for (const p of badProds) {
    // Tenta extrair MLB-ID de múltiplas fontes
    const mlbId = p.ml_item_id
      ? (p.ml_item_id.startsWith('MLB') ? p.ml_item_id : 'MLB' + p.ml_item_id)
      : (xMlb(p.slug) ?? xMlb(p.affiliate_url) ?? xMlb(p.name))

    let resolved = false

    if (mlbId) {
      try {
        const token = await getMlBearerToken(c.env)
        if (token) {
          const rItem = await fetch(
            `https://api.mercadolibre.com/items/${mlbId}?attributes=id,title,price,thumbnail,pictures`,
            {
              headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
              signal: AbortSignal.timeout(7000),
            }
          )
          if (rItem.ok) {
            const d = await rItem.json() as any
            if (d.title && d.title.length > 4) {
              // Limpa o título igual ao cleanName do resolve-url
              const cleanTitle = d.title
                .replace(/\s+/g, ' ')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .trim()
                .substring(0, 200)

              // Atualiza nome, preço e imagem se disponíveis
              const bestImg = (() => {
                const pics: any[] = d.pictures || []
                const p2 = pics.find((x: any) => x.url?.includes('mlstatic')) || pics[0]
                return p2?.url || d.thumbnail || null
              })()

              await DB.prepare(`
                UPDATE products SET
                  name       = ?,
                  best_price = CASE WHEN best_price IS NULL AND ? > 0 THEN ? ELSE best_price END,
                  image_url  = CASE WHEN (image_url IS NULL OR image_url = '') AND ? != '' THEN ? ELSE image_url END,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).bind(
                cleanTitle,
                d.price ?? 0, d.price ?? 0,
                bestImg ?? '', bestImg ?? '',
                p.id
              ).run()

              // Atualiza também o título na oferta vinculada
              await DB.prepare(`
                UPDATE offers SET title = ?, updated_at = CURRENT_TIMESTAMP
                WHERE product_id = ? AND (title IS NULL OR title LIKE 'cfegdhabc%' OR title LIKE 'Produto%')
              `).bind(cleanTitle, p.id).run().catch(() => {})

              details.push({ id: p.id, old: p.name, new: cleanTitle, action: 'fixed' })
              fixed++
              resolved = true
            }
          }
          // Se item não encontrado (404), tenta como Product ID (≤10 dígitos)
          if (!resolved) {
            const digits = mlbId.replace(/^MLB/i, '')
            if (digits.length <= 10) {
              const rProd = await fetch(
                `https://api.mercadolibre.com/products/${mlbId}?attributes=id,name`,
                { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                  signal: AbortSignal.timeout(5000) }
              )
              if (rProd.ok) {
                const dp = await rProd.json() as any
                if (dp.name && dp.name.length > 4) {
                  const cleanTitle = dp.name.replace(/\s+/g, ' ').trim().substring(0, 200)
                  await DB.prepare(
                    `UPDATE products SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
                  ).bind(cleanTitle, p.id).run()
                  details.push({ id: p.id, old: p.name, new: cleanTitle, action: 'fixed' })
                  fixed++
                  resolved = true
                }
              }
            }
          }
        }
      } catch { /* API falhou → deleta */ }
    }

    // Sem MLB-ID ou API falhou → deleta produto e ofertas
    if (!resolved) {
      await DB.prepare(`DELETE FROM offers WHERE product_id = ?`).bind(p.id).run()
      await DB.prepare(`DELETE FROM products WHERE id = ?`).bind(p.id).run()
      details.push({ id: p.id, old: p.name, action: 'deleted' })
      deleted++
    }
  }

  return c.json({
    ok: true,
    fixed,
    deleted,
    total: badProds.length,
    details,
    message: badProds.length === 0
      ? 'Nenhum produto com nome inválido encontrado.'
      : `${fixed} corrigidos via API ML · ${deleted} removidos (sem MLB-ID).`
  })
})

// ── POST /admin/api/sweep — Varredura completa do banco ─────────────────────
// Corrige em sequência:
//   1. ml_item_id corrompido (não numérico) → limpa para NULL
//   2. Produtos duplicados (mesmo ml_item_id) → merge: mantém o mais antigo, remove os extras
//   3. Nomes ruins (Produto MLB…, cfegdhabc…) → tenta API ML, fallback: deleta
//   4. Preço/imagem faltando → busca via API ML /items/{id}
admin.post('/api/sweep', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const BATCH = Math.min(parseInt(body.batch) || 20, 40)

  const report: Record<string, any> = {
    corrupted_fixed: 0,
    duplicates_merged: 0,
    names_fixed: 0,
    names_deleted: 0,
    prices_fixed: 0,
    images_fixed: 0,
    errors: [] as string[],
  }

  // ── PASSO 1: limpa ml_item_id corrompido (não é só dígitos) ─────────────
  const { meta: m1 } = await DB.prepare(`
    UPDATE products SET ml_item_id = NULL
    WHERE ml_item_id IS NOT NULL
      AND ml_item_id != ''
      AND ml_item_id NOT GLOB '[0-9]*'
  `).run()
  report.corrupted_fixed = m1.changes ?? 0

  // ── PASSO 2: merge de duplicatas por ml_item_id ──────────────────────────
  // Busca grupos com mesmo ml_item_id (mais de 1 produto)
  const { results: dupGroups } = await DB.prepare(`
    SELECT ml_item_id,
           MIN(id) as keep_id,
           GROUP_CONCAT(id) as all_ids,
           COUNT(*) as qtd
    FROM products
    WHERE ml_item_id IS NOT NULL AND ml_item_id != ''
    GROUP BY ml_item_id
    HAVING COUNT(*) > 1
    LIMIT 50
  `).all<{ ml_item_id: string; keep_id: number; all_ids: string; qtd: number }>()

  for (const grp of dupGroups) {
    const allIds = grp.all_ids.split(',').map(Number)
    const keepId = grp.keep_id
    const removeIds = allIds.filter(id => id !== keepId)

    // Garante que o produto mantido tem nome e imagem do melhor dos duplicados
    const { results: candidates } = await DB.prepare(`
      SELECT id, name, image_url, best_price FROM products
      WHERE id IN (${allIds.join(',')})
      ORDER BY
        CASE WHEN name NOT LIKE 'Produto%' AND name NOT LIKE 'cfeg%' THEN 0 ELSE 1 END,
        CASE WHEN image_url IS NOT NULL THEN 0 ELSE 1 END,
        best_price ASC NULLS LAST
    `).all<{ id: number; name: string; image_url: string | null; best_price: number | null }>()

    const best = candidates[0]
    if (best && best.id !== keepId) {
      await DB.prepare(`
        UPDATE products SET
          name      = CASE WHEN name LIKE 'Produto%' OR name LIKE 'cfeg%' THEN ? ELSE name END,
          image_url = CASE WHEN image_url IS NULL THEN ? ELSE image_url END,
          best_price = CASE WHEN best_price IS NULL AND ? IS NOT NULL THEN ? ELSE best_price END
        WHERE id = ?
      `).bind(best.name, best.image_url, best.best_price, best.best_price, keepId).run()
    }

    // Reaponta offers dos duplicados para o produto mantido
    for (const rmId of removeIds) {
      await DB.prepare(`UPDATE offers SET product_id = ? WHERE product_id = ?`).bind(keepId, rmId).run()
      await DB.prepare(`DELETE FROM products WHERE id = ?`).bind(rmId).run()
      report.duplicates_merged++
    }
  }

  // ── PASSO 3: corrige nomes ruins via API ML ──────────────────────────────
  const { results: badNames } = await DB.prepare(`
    SELECT p.id, p.name, p.ml_item_id
    FROM products p
    WHERE p.name LIKE 'Produto MLB%'
       OR p.name LIKE 'Produto Import%'
       OR p.name LIKE 'cfegdhabc%'
       OR p.name LIKE 'Cfegdhabc%'
    LIMIT ?
  `).bind(BATCH).all<{ id: number; name: string; ml_item_id: string | null }>()

  const token = await getMlBearerToken(c.env).catch(() => null)

  for (const p of badNames) {
    const mlbId = p.ml_item_id ? `MLB${p.ml_item_id}` : null
    if (!mlbId || !token) {
      await DB.prepare(`DELETE FROM offers WHERE product_id = ?`).bind(p.id).run()
      await DB.prepare(`DELETE FROM products WHERE id = ?`).bind(p.id).run()
      report.names_deleted++
      continue
    }
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/items/${mlbId}?attributes=id,title,price,thumbnail,pictures`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) }
      )
      if (r.ok) {
        const d = await r.json() as any
        if (d.title && d.title.length > 4) {
          const pics: any[] = d.pictures || []
          const img = pics.find((x: any) => x.url?.includes('mlstatic'))?.url || d.thumbnail || null
          await DB.prepare(`
            UPDATE products SET name = ?, image_url = COALESCE(image_url, ?),
              best_price = CASE WHEN best_price IS NULL AND ? > 0 THEN ? ELSE best_price END,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(d.title.trim().substring(0, 250), img, d.price ?? 0, d.price ?? 0, p.id).run()
          await DB.prepare(`UPDATE offers SET title = ?, price = CASE WHEN price = 0 AND ? > 0 THEN ? ELSE price END,
            image_url = CASE WHEN image_url IS NULL THEN ? ELSE image_url END WHERE product_id = ?
          `).bind(d.title.trim().substring(0, 250), d.price ?? 0, d.price ?? 0, img, p.id).run()
          report.names_fixed++
        } else { throw new Error('sem título') }
      } else { throw new Error(`HTTP ${r.status}`) }
    } catch (e: any) {
      await DB.prepare(`DELETE FROM offers WHERE product_id = ?`).bind(p.id).run()
      await DB.prepare(`DELETE FROM products WHERE id = ?`).bind(p.id).run()
      report.names_deleted++
    }
  }

  // ── PASSO 4: completa preço e imagem faltando via API ML ────────────────
  const { results: noPrice } = await DB.prepare(`
    SELECT p.id as product_id, p.ml_item_id, p.name,
           o.id as offer_id, o.price, o.image_url
    FROM products p
    JOIN offers o ON o.product_id = p.id
    WHERE (o.price IS NULL OR o.price = 0 OR o.image_url IS NULL OR o.image_url = '')
      AND p.ml_item_id IS NOT NULL AND p.ml_item_id != ''
      AND p.ml_item_id GLOB '[0-9]*'
    LIMIT ?
  `).bind(BATCH).all<{ product_id: number; ml_item_id: string; name: string; offer_id: number; price: number; image_url: string | null }>()

  for (const row of noPrice) {
    if (!token) break
    try {
      const mlbId = `MLB${row.ml_item_id}`
      const r = await fetch(
        `https://api.mercadolibre.com/items/${mlbId}?attributes=id,title,price,thumbnail,pictures`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) }
      )
      if (!r.ok) continue
      const d = await r.json() as any
      const pics: any[] = d.pictures || []
      const img = pics.find((x: any) => x.url?.includes('mlstatic'))?.url || d.thumbnail || null
      const price = d.price && d.price > 0 ? d.price : null

      let fixed = false
      if (price && (!row.price || row.price === 0)) {
        await DB.prepare(`UPDATE offers SET price = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`).bind(price, row.offer_id).run()
        await DB.prepare(`UPDATE products SET best_price = CASE WHEN best_price IS NULL OR ? < best_price THEN ? ELSE best_price END WHERE id = ?`).bind(price, price, row.product_id).run()
        report.prices_fixed++
        fixed = true
      }
      if (img && (!row.image_url || row.image_url === '')) {
        await DB.prepare(`UPDATE offers SET image_url = ? WHERE id = ?`).bind(img, row.offer_id).run()
        await DB.prepare(`UPDATE products SET image_url = COALESCE(image_url, ?) WHERE id = ?`).bind(img, row.product_id).run()
        report.images_fixed++
        fixed = true
      }
    } catch { /* ignora timeout */ }
  }

  const total_fixed = report.corrupted_fixed + report.duplicates_merged + report.names_fixed + report.prices_fixed + report.images_fixed
  return c.json({
    ok: true,
    ...report,
    total_fixed,
    message: total_fixed === 0
      ? 'Banco já está limpo — nenhum problema encontrado.'
      : `✅ ${total_fixed} correções: ${report.corrupted_fixed} ml_item_id · ${report.duplicates_merged} duplicatas · ${report.names_fixed} nomes · ${report.prices_fixed} preços · ${report.images_fixed} imagens`,
  })
})

// ── GET /admin/api/match-preview — Simula matching de nome cross-loja ──
// Mostra como o sistema agruparia um produto importado de outra loja
// Query: name (obrigatório), brand (opcional), category (opcional)
admin.get('/api/match-preview', async (c) => {
  const db    = c.env.DB
  const name  = c.req.query('name') || ''
  const brand = c.req.query('brand') || undefined
  const cat   = c.req.query('category') || undefined

  if (!name.trim()) return c.json({ ok: false, error: 'name é obrigatório' }, 400)

  const normStr = (s: string) => s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()

  const COLOR_SET = new Set([
    'preto','preta','branco','branca','prata','prateado','prateada',
    'dourado','dourada','gold','rosa','pink','azul','blue','verde','green',
    'vermelho','vermelha','red','cinza','grey','gray','laranja','orange',
    'roxo','roxa','purple','violeta','lilas','amarelo','amarela','yellow',
    'bege','chumbo','grafite','champagne','titanio','titanium','silver','black','white',
  ])

  const extractColor = (n: string): string | null => {
    const tokens = normStr(n).split(' ')
    for (const t of tokens) if (COLOR_SET.has(t)) return t
    return null
  }

  const STOP = new Set([
    'de','do','da','com','para','por','em','no','na','e','a','o','os','as','um','uma',
    'the','with','for','and','or','in','lacrado','original','novo','nova',
    ...COLOR_SET,
  ])

  const VARIANTS = new Set([...COLOR_SET,'128gb','256gb','512gb','1tb','2tb','4gb','6gb','8gb',
    '12gb','16gb','32gb','64gb','wi-fi','4g','5g','wifi'])

  const extractFP = (n: string) => normStr(n).split(' ')
    .filter(t => t.length > 1 && !STOP.has(t) && !VARIANTS.has(t))

  const linkFP    = extractFP(name)
  const linkNorm  = normStr(name)
  const linkTokens= linkNorm.split(' ').filter(t => t.length > 1 && !STOP.has(t))
  const linkColor = extractColor(name)

  // Busca candidatos
  const queryStr = brand
    ? `SELECT id, name, brand, category, slug, best_price, image_url FROM products WHERE (brand = ? OR category = ?) AND is_active = 1 LIMIT 400`
    : `SELECT id, name, brand, category, slug, best_price, image_url FROM products WHERE is_active = 1 LIMIT 600`

  const { results: candidates } = brand
    ? await db.prepare(queryStr).bind(brand, cat || '').all<any>()
    : await db.prepare(queryStr).all<any>()

  const scored: Array<{
    id: number; name: string; brand: string|null; category: string|null; slug: string
    best_price: number; image_url: string|null
    score: number; method: string
    color_mine: string|null; color_theirs: string|null; color_conflict: boolean
    action: 'agrupar' | 'variante'
  }> = []

  for (const cand of candidates) {
    if (/^(Produto\s+Importado|Produto\s+MLB|Cfegdhabc|MLBU?\d{6,12})/i.test(cand.name)) continue

    const candFP    = extractFP(cand.name)
    const candNorm  = normStr(cand.name)
    const candTokens= new Set(candNorm.split(' ').filter(t => t.length > 1 && !STOP.has(t)))

    const candFPSet = new Set(candFP)
    const fpInter = linkFP.filter(t => candFPSet.has(t)).length
    const fpUnion = new Set([...linkFP, ...candFP]).size
    const fpJacc  = fpUnion > 0 ? fpInter / fpUnion : 0

    const fullInter = linkTokens.filter(t => candTokens.has(t)).length
    const fullUnion = new Set([...linkTokens, ...candTokens]).size
    const fullJacc  = fullUnion > 0 ? fullInter / fullUnion : 0

    // Cobertura: quantos dos meus tokens existem no candidato?
    // Robusto quando candidato tem tokens extras (Series 11, Whatsapp, 2026)
    const coverageInter = linkFP.filter(t => candFPSet.has(t)).length
    const inputCoverage = linkFP.length > 0 ? coverageInter / linkFP.length : 0

    // Bônus de modelo alfanumérico (S11, X100, Tab5 etc) — token muito específico
    const modelTokensL = linkFP.filter(t => /^[a-z]+\d+/.test(t) || /^\d+[a-z]+/.test(t))
    const modelMatch   = modelTokensL.length > 0 && modelTokensL.every(t => candFPSet.has(t))
    const modelBonus   = modelMatch ? 0.10 : 0

    const brandBonus = (brand && cand.brand && normStr(brand) === normStr(cand.brand)) ? 0.08 : 0
    const score = Math.min(1.0, Math.max(fpJacc, fullJacc, inputCoverage) + brandBonus + modelBonus)
    const threshold = brandBonus > 0 ? 0.60 : modelMatch ? 0.65 : 0.72

    if (score >= threshold) {
      const candColor = extractColor(cand.name)
      const colorConflict = !!(linkColor && candColor && linkColor !== candColor)
      scored.push({
        id: cand.id, name: cand.name, brand: cand.brand, category: cand.category,
        slug: cand.slug, best_price: cand.best_price, image_url: cand.image_url,
        score: Math.round(score * 100) / 100,
        method: inputCoverage >= fpJacc && inputCoverage >= fullJacc ? 'coverage' : fpJacc >= fullJacc ? 'fingerprint' : 'fuzzy',
        color_mine: linkColor, color_theirs: candColor, color_conflict: colorConflict,
        action: colorConflict ? 'variante' : 'agrupar',
      })
    }
  }

  // Ordena: maior score primeiro; desempate → mesma cor tem prioridade sobre cor diferente
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Desempate: prefere agrupar (mesma cor ou sem conflito) sobre variante (cor diferente)
    if (a.action === 'agrupar' && b.action !== 'agrupar') return -1
    if (b.action === 'agrupar' && a.action !== 'agrupar') return 1
    return 0
  })

  return c.json({
    ok: true,
    input: { name, brand: brand||null, color: linkColor },
    fingerprint: linkFP,
    total_candidates_scanned: candidates.length,
    matches: scored.slice(0, 10),
    top_action: scored[0]?.action || 'novo_produto',
    top_match: scored[0] || null,
  })
})

// ── GET /admin/api/fetch-debug — Testa acesso a URL externa do Worker ──
// Debug: verifica se o Worker consegue acessar URLs do ML
admin.get('/api/fetch-debug', async (c) => {
  const url = c.req.query('url') || 'https://produto.mercadolivre.com.br/MLB-6463890784'
  const ua  = c.req.query('ua')  || 'bot'
  const userAgent = ua === 'mobile'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  try {
    const t0 = Date.now()
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': userAgent, 'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(12000),
    })
    const elapsed = Date.now() - t0
    const html    = await res.text()
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1]
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
    const price   = html.match(/"price"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/)?.[1]
    const isMLBU  = url.includes('/up/MLBU')
    return c.json({
      ok: true, status: res.status, elapsed_ms: elapsed,
      url: res.url, size: html.length,
      og_title: ogTitle || null, og_image: ogImage || null,
      price_json: price || null,
      is_microlanding: isMLBU,
      html_snippet: html.substring(0, 500),
    })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message, url }, 500)
  }
})

// ── POST /admin/api/enrich-offers — Enriquece offers sem preço/imagem ──
// Busca preço e imagem via resolve-url para offers importadas manualmente
// sem preço (price=0) ou sem imagem (image_url=null)
admin.post('/api/enrich-offers', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const BATCH = Math.min(parseInt(body.limit) || 20, 50)
  const DELETE_FAILED = body.delete_failed === true // só deleta se explicitamente solicitado

  // Busca offers sem preço ou sem imagem, que têm affiliate_url
  const { results: offers } = await DB.prepare(`
    SELECT o.id AS offer_id, o.affiliate_url, o.product_id,
           o.price, o.image_url, p.name
    FROM offers o
    JOIN products p ON p.id = o.product_id
    WHERE o.source = 'manual'
      AND o.affiliate_url IS NOT NULL
      AND o.affiliate_url != ''
      AND (o.price IS NULL OR o.price = 0 OR o.image_url IS NULL OR o.image_url = '')
    ORDER BY o.id ASC
    LIMIT ?
  `).bind(BATCH).all<any>()

  if (!offers.length) return c.json({ ok: true, enriched: 0, message: 'Nenhum offer para enriquecer' })

  // ── UAs ──────────────────────────────────────────────────────────────────
  const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const botUA    = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

  // Helper: extrai MLB ID de URL/string (aceita MLB-XXXXXXX e MLBXXXXXXX)
  const extractMlbId = (s: string): string | null => {
    // Aceita MLB-68335778 (com hífen) e MLB68335778 (sem hífen)
    const m = s.match(/\b(MLB)-?(\d{6,12})\b/i)
    if (m) return ('MLB' + m[2]).toUpperCase()
    return null
  }

  // Helper: extrai preço de HTML — igual ao resolve-url (prioridade: current_price > price > itemprop > R$)
  const extractPrice = (html: string): number | null => {
    const patterns = [
      // /social/ forceInApp=true: "current_price":{"value":14.54} — PRIORIDADE MÁXIMA
      /"current_price"\s*:\s*\{"value"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
      // produto.mercadolivre.com.br: "price":119.9
      /"price"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
      // Schema.org itemprop
      /content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/i,
      /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i,
      // "amount":14.54
      /"amount"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
    ]
    for (const pat of patterns) {
      const m = html.match(pat)
      if (m) {
        const raw = m[1].replace(/\.(?=\d{3})/g, '').replace(',', '.')
        const val = parseFloat(raw)
        if (!isNaN(val) && val > 0 && val < 9_000_000) return val
      }
    }
    return null
  }

  // Helper: extrai preço do og:title "Nome - R$ 62,35" — igual ao resolve-url
  const extractPriceFromTitle = (title: string): number | null => {
    const m = title.match(/R\$\s*([\d]+(?:[.,][\d]{1,2})?)\s*$/i)
    if (!m) return null
    const val = parseFloat(m[1].replace(',', '.'))
    return (!isNaN(val) && val > 0 && val < 9_000_000) ? val : null
  }

  // Helper: normaliza URL de imagem mlstatic — igual ao resolve-url
  const fixImgUrl = (img: string): string => {
    if (!img || img.startsWith('data:')) return ''
    img = img.replace(/\\u002F/g, '/').replace(/\\/g, '')
    if (img.startsWith('//')) img = 'https:' + img
    img = img.replace(/_[A-Z](-\d+)?(\.(webp|jpg|png))(\?.*)?$/, '_O$2')
    return img
  }

  // Helper: extrai og:image de HTML (meta tag padrão)
  const extractImage = (html: string): string => {
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    return fixImgUrl(og?.[1] || '')
  }

  let enriched = 0
  let failed   = 0
  let deleted  = 0
  const details: any[] = []

  for (const offer of offers) {
    try {
      const url = offer.affiliate_url
      let price: number | null = null
      let image = ''
      let newName: string | null = null
      const hasInvalidName = /^(Produto MLB|Produto Import|cfegdhabc)/i.test(offer.name || '')

      // Passo 1: tenta extrair MLB da affiliate_url diretamente
      // Prioridade: wid=MLB... (query param) > MLB no path
      const widInQuery  = url.match(/[?&]wid=(MLB[\w-]+)/i)
      const mlbFromWid  = widInQuery ? widInQuery[1].replace(/-/g, '') : null
      let mlbId: string | null = mlbFromWid ? (mlbFromWid.startsWith('MLB') ? mlbFromWid : 'MLB' + mlbFromWid) : extractMlbId(url)

      // ══════════════════════════════════════════════════════════════════
      // PASSO 1b: Para URLs /up/MLBU...?wid=MLB... (micro-landing de afiliado)
      //   A URL é uma micro-landing de bot challenge (sem preço real).
      //   Se temos o mlbId do wid=, vamos direto para produto.mercadolivre.com.br
      //   com Googlebot UA — que retorna SSR completo com preço e imagem.
      //   Isso evita perder tempo com a micro-landing.
      // ══════════════════════════════════════════════════════════════════
      if (mlbId && url.includes('/up/MLBU')) {
        try {
          const mlbDash = mlbId.replace(/^MLB/i, 'MLB-')
          // Tenta com Googlebot (SSR bot-mode — sem JS, serve meta tags completas)
          const prodRes = await fetch(`https://produto.mercadolivre.com.br/${mlbDash}`, {
            redirect: 'follow',
            headers: {
              'User-Agent':      botUA,
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9',
            },
            signal: AbortSignal.timeout(12000),
          })
          if (prodRes.ok) {
            const html = await prodRes.text()
            // item_id no JSON inline
            if (!mlbId) {
              const itemIdM = html.match(/"item_id"\s*:\s*"(MLB\d{6,12})"/i)
              if (itemIdM) mlbId = itemIdM[1].toUpperCase()
            }
            // Preço via padrões JSON
            if (!price) price = extractPrice(html)
            // Imagem via og:image meta tag
            if (!image) image = extractImage(html)
            // og:title → preço e nome
            const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
            if (ogTitle) {
              if (!price) price = extractPriceFromTitle(ogTitle[1])
              if (hasInvalidName && ogTitle[1] && ogTitle[1].length > 5) {
                newName = ogTitle[1].replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, '').trim()
              }
            }
          }
        } catch { /* ignora timeout */ }
      }

      // ══════════════════════════════════════════════════════════════════
      // PASSO 2: /social/ com Mobile UA + forceInApp=true
      //   IGUAL ao resolve-url — o único jeito que funciona no Cloudflare Worker
      //   Mobile UA + forceInApp=true → ML serve JSON SSR com:
      //     "current_price":{"value":14.54}   ← preço
      //     "item_id":"MLB27071946"            ← MLB ID (mais confiável que href)
      //     "type":"og:image","content":"..."  ← imagem
      //     "type":"og:title","content":"Nome - R$ 62,35" ← preço alternativo
      // ══════════════════════════════════════════════════════════════════
      if (!price && !image && url.includes('/social/')) {
        try {
          // Adiciona forceInApp=true (essencial para o ML retornar JSON com preço)
          let fetchUrl = url
          if (!url.includes('forceInApp=true')) {
            try {
              const u = new URL(url)
              u.searchParams.set('forceInApp', 'true')
              fetchUrl = u.toString()
            } catch { /* mantém URL original */ }
          }

          const socialRes = await fetch(fetchUrl, {
            redirect: 'follow',
            headers: {
              'User-Agent':      mobileUA,   // ← MOBILE (não Googlebot)
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9',
            },
            signal: AbortSignal.timeout(10000),
          })
          if (socialRes.ok) {
            const html = await socialRes.text()

            // 1) MLB ID via "item_id":"MLB..." (mais confiável que href)
            if (!mlbId) {
              const itemIdM = html.match(/"item_id"\s*:\s*"(MLB\d{7,12})"/i)
              if (itemIdM) mlbId = itemIdM[1].toUpperCase()
            }

            // 2) Preço via "current_price":{"value":14.54} — presente no JSON do /social/ com forceInApp
            if (!price) price = extractPrice(html)

            // 3) Nome + Preço via og:title: {"type":"og:title","content":"Nome - R$ 62,35"}
            const titleM = html.match(/"type"\s*:\s*"og:title"\s*,\s*"content"\s*:\s*"([^"]+)"/)
                        || html.match(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"og:title"/)
            if (titleM) {
              if (!price) price = extractPriceFromTitle(titleM[1])
              // Salva nome se produto tem nome genérico
              if (hasInvalidName && titleM[1] && titleM[1].length > 5) {
                // Remove " - R$ XX,XX" do final se presente
                newName = titleM[1].replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, '').trim()
              }
            }

            // 4) Imagem via og:image no JSON inline
            if (!image) {
              const imgM = html.match(/"type"\s*:\s*"og:image"\s*,\s*"content"\s*:\s*"([^"]+)"/)
                        || html.match(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"og:image"/)
              if (imgM) image = fixImgUrl(imgM[1])
            }
            // 5) Imagem fallback: og:image via meta tag padrão
            if (!image) image = extractImage(html)

            // 6) Fallback MLB ID via href do produto na página
            if (!mlbId) {
              const hrefM = html.match(/href="(https:\/\/www\.mercadolivre\.com\.br\/[^"]+\/p\/MLB\d+[^"]*)"/)
                         || html.match(/href="(https:\/\/www\.mercadolivre\.com\.br\/[^"]+\/MLB\d+[^"]*?\.html[^"]*?)"/)
              if (hrefM) {
                try {
                  const u = new URL(hrefM[1].replace(/&amp;/g, '&'))
                  mlbId = extractMlbId(u.origin + u.pathname)
                } catch { /* ignora */ }
              }
            }
          }
        } catch { /* ignora timeout */ }
      }

      // ══════════════════════════════════════════════════════════════════
      // PASSO 2b: se URL é www.mercadolivre.com.br/slug/p/MLB... sem /social/
      //   Tenta buscar direto com Mobile UA (serve SSR em algumas páginas)
      //   Pula URLs /up/MLBU (micro-landing — já tratado no Passo 1b)
      // ══════════════════════════════════════════════════════════════════
      if (!price && !image && url.includes('mercadolivre.com.br') && !url.includes('/social/') && !url.includes('/up/MLBU')) {
        try {
          const directRes = await fetch(url, {
            redirect: 'follow',
            headers: {
              'User-Agent':      mobileUA,
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9',
              'Cache-Control':   'no-cache',
            },
            signal: AbortSignal.timeout(12000),
          })
          if (directRes.ok) {
            const html = await directRes.text()
            if (!mlbId) {
              const itemIdM = html.match(/"item_id"\s*:\s*"(MLB\d{6,12})"/i)
              if (itemIdM) mlbId = itemIdM[1].toUpperCase()
            }
            if (!price) price = extractPrice(html)
            if (!image) {
              const imgM = html.match(/"type"\s*:\s*"og:image"\s*,\s*"content"\s*:\s*"([^"]+)"/)
                        || html.match(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"og:image"/)
              if (imgM) image = fixImgUrl(imgM[1])
              if (!image) image = extractImage(html)
            }
            if (!price) {
              const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
              if (ogTitle) {
                if (!price) price = extractPriceFromTitle(ogTitle[1])
                if (hasInvalidName && ogTitle[1] && ogTitle[1].length > 5) {
                  newName = ogTitle[1].replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, '').trim()
                }
              }
            }
          }
        } catch { /* ignora timeout */ }
      }

      // ══════════════════════════════════════════════════════════════════
      // PASSO 2c: se URL já é produto.mercadolivre.com.br, tenta buscar direto
      //   (affiliate_url não continha /social/, mas tem MLB ID na própria URL)
      // ══════════════════════════════════════════════════════════════════
      if (!price && !image && url.includes('produto.mercadolivre.com.br') && mlbId) {
        try {
          const mlbDash = mlbId.replace(/^MLB/i, 'MLB-')
          const prodRes = await fetch(`https://produto.mercadolivre.com.br/${mlbDash}`, {
            redirect: 'follow',
            headers: {
              'User-Agent':      mobileUA,
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9',
            },
            signal: AbortSignal.timeout(10000),
          })
          if (prodRes.ok) {
            const html = await prodRes.text()
            // Tenta item_id no JSON da página
            if (!mlbId) {
              const itemIdM = html.match(/"item_id"\s*:\s*"(MLB\d{6,12})"/i)
              if (itemIdM) mlbId = itemIdM[1].toUpperCase()
            }
            if (!price) price = extractPrice(html)
            if (!image) image = extractImage(html)
            // og:title fallback
            if (!price) {
              const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
              if (ogTitle) price = extractPriceFromTitle(ogTitle[1])
            }
          }
        } catch { /* ignora timeout */ }
      }

      // ══════════════════════════════════════════════════════════════════
      // PASSO 3 (fallback): produto.mercadolivre.com.br/MLBXXXXXX via Googlebot
      //   Funciona para Item IDs curtos — serve SSR completo para bots
      //   NOTA: IPs da Cloudflare são bloqueados para scraping de produto normal,
      //   mas produto.mercadolivre.com.br tem menos bloqueio
      //   Pula URLs /up/MLBU (já tratado no Passo 1b — evita double fetch)
      // ══════════════════════════════════════════════════════════════════
      if (mlbId && (!price || !image) && !url.includes('/up/MLBU')) {
        try {
          const mlbDash = mlbId.replace(/^MLB/i, 'MLB-')
          const res = await fetch(`https://produto.mercadolivre.com.br/${mlbDash}`, {
            headers: {
              'User-Agent':      botUA,
              'Accept':          'text/html,application/xhtml+xml',
              'Accept-Language': 'pt-BR,pt;q=0.9',
            },
            signal: AbortSignal.timeout(10000),
          })
          if (res.ok) {
            const html = await res.text()
            if (!price) price = extractPrice(html)
            if (!image) image = extractImage(html)
            // Fallback: preço do og:title "Nome - R$ 261,5"
            if (!price) {
              const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
              if (ogTitle) {
                price = extractPriceFromTitle(ogTitle[1])
                if (!price && hasInvalidName && ogTitle[1] && ogTitle[1].length > 5) {
                  newName = ogTitle[1].replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, '').trim()
                }
              }
            }
          }
        } catch { /* ignora */ }
      }

      if (price || image) {
        // Atualiza offer
        await DB.prepare(`
          UPDATE offers SET
            price      = CASE WHEN ? > 0 THEN ? ELSE price END,
            image_url  = CASE WHEN ? != '' THEN ? ELSE image_url END,
            last_updated = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price || 0, price || 0, image, image, offer.offer_id).run()

        // Extrai dígitos do mlbId encontrado via /social/ para salvar em ml_item_id
        const newMlItemId = mlbId ? mlbId.replace(/^MLB/i, '') : null

        // Atualiza produto — inclui ml_item_id e nome (se genérico) quando encontrado via /social/
        await DB.prepare(`
          UPDATE products SET
            image_url  = CASE WHEN ? != '' AND (image_url IS NULL OR image_url = '') THEN ? ELSE image_url END,
            best_price = CASE WHEN ? > 0 AND (best_price IS NULL OR best_price = 0) THEN ? ELSE best_price END,
            ml_item_id = CASE WHEN ? IS NOT NULL AND (ml_item_id IS NULL OR ml_item_id = '') THEN ? ELSE ml_item_id END,
            name       = CASE WHEN ? IS NOT NULL THEN ? ELSE name END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(image, image, price || 0, price || 0, newMlItemId, newMlItemId, newName, newName, offer.product_id).run()

        // Se atualizou nome, também atualiza o offer title
        if (newName) {
          await DB.prepare(`UPDATE offers SET title = ? WHERE id = ? AND (title IS NULL OR title = '' OR title LIKE 'Produto %' OR title LIKE 'cfegdhabc%')`).bind(newName, offer.offer_id).run()
        }

        enriched++
        details.push({ name: offer.name, price, image: image ? '✓' : '✗', mlb: mlbId, status: 'ok' })
      } else {
        // Não conseguiu enriquecer
        // Auto-deleta se o produto tem nome inválido (Produto MLB*, Produto Import*, cfegdhabc*)
        // — esses nunca vão resolver, são lixo do parseLine bugado
        if (DELETE_FAILED || hasInvalidName) {
          try {
            await DB.prepare(`DELETE FROM offers WHERE id = ?`).bind(offer.offer_id).run()
            // Deleta o produto se não tiver outros offers vinculados
            const otherOffers = await DB.prepare(
              `SELECT COUNT(*) as n FROM offers WHERE product_id = ?`
            ).bind(offer.product_id).first<{ n: number }>()
            if (!otherOffers?.n) {
              await DB.prepare(`DELETE FROM products WHERE id = ?`).bind(offer.product_id).run()
            }
            deleted++
            details.push({ name: offer.name, mlb: mlbId, status: 'deletado' })
          } catch (de: any) {
            failed++
            details.push({ name: offer.name, mlb: mlbId, status: 'sem_dados', error: de?.message })
          }
        } else {
          // Mantém no banco — só loga como falha sem dados
          failed++
          details.push({ name: offer.name, mlb: mlbId || null, status: 'sem_dados' })
        }
      }
    } catch (e: any) {
      failed++
      details.push({ name: offer.name, status: 'erro', error: e?.message })
    }
  }

  // Conta total restante
  const remaining = await DB.prepare(`
    SELECT COUNT(*) as n FROM offers
    WHERE source='manual' AND affiliate_url IS NOT NULL
      AND (price IS NULL OR price = 0 OR image_url IS NULL OR image_url = '')
  `).first<{ n: number }>()

  return c.json({
    ok: true,
    processed: offers.length,
    enriched,
    deleted,
    failed,
    remaining: remaining?.n || 0,
    details,
  })
})

// -- POST /admin/api/affiliate-bot/run-all -- Bot em lote
// Estrategia de token:
//   1) client_credentials (ML_APP_ID + ML_SECRET) -- nao depende de OAuth do usuario
//      O ML exige Bearer token mesmo para /items/{id}. client_credentials usa apenas
//      app credentials (Cloudflare secrets) e nunca expira de forma silenciosa.
//      Token dura 6h, cacheado no KV (ml_app_token) por 5h.
//   2) Fallback: ml_access_token do KV (OAuth usuario) se client_credentials falhar
//   3) Sem token: apenas fallback de busca (lista.mercadolivre.com.br)
// Fases:
//   Fase 1: produtos COM ml_item_id -> GET /items/{id} -> permalink real
//   Fase 2: produtos SEM ml_item_id -> GET /sites/MLB/search -> 1o match -> permalink
//   Fallback: lista.mercadolivre.com.br/BUSCA?matt_word=... (rastreavel, sem produto especifico)
// Link final: permalink?matt_word=PUBLISHER_ID&matt_tool=61674414&forceInApp=true
admin.post('/api/affiliate-bot/run-all', async (c) => {
  const { DB, CACHE } = c.env
  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '61674414'
  const ML_API       = 'https://api.mercadolibre.com'
  const body: any = await c.req.json().catch(() => ({}))
  const LIMIT = Math.min(Math.max(parseInt(body.limit) || 50, 1), 100)

  // -- Passo 1: token via client_credentials (ML_APP_ID + ML_SECRET) ------
  // Nao precisa de reautorizacao do usuario -- usa apenas secrets do Cloudflare.
  let token: string | null = null
  let token_source = 'none'
  const appId  = (c.env as any).ML_APP_ID  || '3098423019766450'
  const secret = (c.env as any).ML_SECRET  || ''

  if (secret) {
    try {
      // Tenta cache KV primeiro -- evita chamar /oauth/token a cada run
      const cached = await CACHE?.get('ml_app_token').catch(() => null)
      if (cached) {
        token = cached
        token_source = 'cache'
      } else {
        // Gera novo token de app via client_credentials
        const tokenRes = await fetch(ML_API + '/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: new URLSearchParams({
            grant_type:    'client_credentials',
            client_id:     appId,
            client_secret: secret,
          }),
        })
        if (tokenRes.ok) {
          const td: any = await tokenRes.json()
          if (td.access_token) {
            token = td.access_token
            token_source = 'client_credentials'
            // Cache por 5h (token ML dura 6h -- margem de seguranca)
            await CACHE?.put('ml_app_token', token!, { expirationTtl: 18000 }).catch(() => {})
          }
        }
      }
    } catch {}
  }

  // -- Passo 2: fallback token OAuth do usuario (KV) se client_credentials falhar --
  if (!token) {
    token = await CACHE?.get('ml_access_token').catch(() => null)
    if (token) token_source = 'oauth_kv'
  }

  // ── Fase 1: produtos COM ml_item_id ─────────────────
  const { results: phase1 } = await DB.prepare(`
    SELECT id, name, ml_item_id FROM products
    WHERE is_active = 1
      AND ml_item_id IS NOT NULL AND ml_item_id != ''
      AND (affiliate_url IS NULL OR affiliate_url = ''
           OR affiliate_url NOT LIKE '%matt_word%')
    ORDER BY id ASC
    LIMIT ?
  `).bind(LIMIT).all<any>()

  // ── Fase 2: produtos SEM ml_item_id ─────────────────
  const remaining = LIMIT - phase1.length
  const { results: phase2 } = remaining > 0
    ? await DB.prepare(`
        SELECT id, name, brand FROM products
        WHERE is_active = 1
          AND (ml_item_id IS NULL OR ml_item_id = '')
          AND (affiliate_url IS NULL OR affiliate_url = '')
        ORDER BY id ASC
        LIMIT ?
      `).bind(remaining).all<any>()
    : { results: [] as any[] }

  const total = phase1.length + phase2.length
  if (!total) {
    return c.json({ ok: true, refreshed: 0, linked: 0, fallback: 0,
      no_token: !token, message: 'Todos os produtos já têm link de afiliado!' })
  }

  let refreshed = 0, linked = 0, fallback = 0
  const errors: string[] = []

  // Helper: monta link afiliado com rastreamento real
  const buildLink = (permalink: string) =>
    `${permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

  // ── Processar Fase 1 ──────────────────────────
  for (const p of phase1) {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(
        `https://api.mercadolibre.com/items/${p.ml_item_id}?attributes=id,permalink`,
        { headers }
      )
      if (!res.ok) {
        errors.push(`#${p.id} ${p.ml_item_id}: HTTP ${res.status}`)
        continue
      }
      const item: any = await res.json()
      if (!item?.permalink) { errors.push(`#${p.id}: sem permalink`); continue }

      const affiliate_url = buildLink(item.permalink)
      await DB.prepare(`
        UPDATE products
        SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(affiliate_url, p.id).run()
      refreshed++
      await new Promise(r => setTimeout(r, 100))
    } catch (e: any) {
      errors.push(`#${p.id}: ${e.message}`)
    }
  }

  // ── Processar Fase 2 ──────────────────────────
  for (const p of phase2) {
    try {
      const query = `${p.brand || ''} ${p.name}`.trim()
      const searchUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=1`
      const headers: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(searchUrl, { headers })
      if (!res.ok) {
        // Search bloqueado -- fallback: link de busca afiliado
        const searchAff = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}`
        await DB.prepare(`UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(searchAff, p.id).run()
        fallback++
        continue
      }

      const data: any = await res.json()
      const item = data.results?.[0]
      if (!item?.permalink) {
        // Sem resultado -- fallback: link de busca afiliado
        const searchAff = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}`
        await DB.prepare(`UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(searchAff, p.id).run()
        fallback++
        continue
      }

      const affiliate_url = buildLink(item.permalink)
      await DB.prepare(`
        UPDATE products
        SET ml_item_id = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(item.id, affiliate_url, p.id).run()
      linked++
      await new Promise(r => setTimeout(r, 120))
    } catch (e: any) {
      errors.push(`#${p.id}: ${e.message}`)
    }
  }

  const message = [
    `[Link] Fase 1: ${refreshed} atualizados (COM ml_item_id → /items/{id})`,
    `[Busca] Fase 2: ${linked} novos + ${fallback} fallbacks (SEM ml_item_id)`,
    errors.length ? ` ${errors.length} erros` : '',
  ].filter(Boolean).join(' | ')

  return c.json({ ok: true, refreshed, linked, fallback, no_token: !token,
    errors: errors.slice(0, 10), message })
})

// ── DELETE /admin/api/affiliate-bot/clear/:id — Remove link ─
admin.delete('/api/affiliate-bot/clear/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  await DB.prepare(`
    UPDATE products SET ml_item_id = NULL, affiliate_url = NULL, affiliate_updated_at = NULL
    WHERE id = ?
  `).bind(id).run()
  return c.json({ ok: true })
})

// ── POST /admin/api/affiliate-bot/import-offers ──────────
// Scrapa mercadolivre.com.br/ofertas, extrai o JSON embutido (_n.ctx.r)
// e importa os produtos com link de afiliado — SEM chamar /items/{id}.
// Todo o dados (titulo, preco, imagem, permalink) ja estao no HTML.
// Link afiliado = permalink + ?matt_word=cfegdhabc31955&matt_tool=61674414&forceInApp=true
admin.post('/api/affiliate-bot/import-offers', async (c) => {
  const { DB } = c.env
  const body: any    = await c.req.json().catch(() => ({}))
  const limit        = Math.min(Math.max(parseInt(body.limit) || 54, 1), 54)
  const categoryHint = (body.category || '').trim()
  const dryRun       = !!body.dry_run

  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '61674414'

  // ── 1. Scrapa /ofertas ────────────────────────────────────
  let scrape_status  = 0
  let scrape_bytes   = 0
  let rawItems: any[] = []

  try {
    const res = await fetch('https://www.mercadolivre.com.br/ofertas', {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Referer':         'https://www.mercadolivre.com.br/',
      },
    })
    scrape_status = res.status

    if (!res.ok) {
      return c.json({ ok: false, error: `HTTP ${res.status} ao acessar /ofertas`, scrape_status }, 502)
    }

    const html = await res.text()
    scrape_bytes = html.length

    // Detecta bot challenge
    if (html.includes('_bmstate') || html.includes('PoW') || html.length < 20000) {
      return c.json({
        ok: false, error: 'Bot challenge detectado — IP do Worker foi bloqueado.',
        scrape_status, scrape_bytes,
        tip: 'Tente novamente em alguns minutos.',
      }, 503)
    }

    // ── 2. Extrai JSON embutido _n.ctx.r = {...} ──────────────
    // O ML embute todos os dados dos produtos neste objeto JS no HTML
    const ctxMatch = html.match(/_n\.ctx\.r\s*=\s*(\{)/)
    if (!ctxMatch || ctxMatch.index === undefined) {
      return c.json({
        ok: false, error: 'JSON _n.ctx.r nao encontrado no HTML. Estrutura da pagina pode ter mudado.',
        scrape_status, scrape_bytes,
        tip: 'Verifique /admin/api/ml/search-debug (T12) para diagnosticar.',
      }, 422)
    }

    // Parse incremental — pega apenas o objeto JSON, ignora o JS que vem depois
    const jsonStart = ctxMatch.index + ctxMatch[0].length - 1  // posicao do {
    const rawJson   = html.slice(jsonStart)

    // Percorre caracter a caracter para encontrar o fim do objeto raiz
    let depth = 0, end = 0, inStr = false, esc = false
    for (let i = 0; i < rawJson.length; i++) {
      const ch = rawJson[i]
      if (esc)          { esc = false; continue }
      if (ch === '\\')  { esc = true;  continue }
      if (ch === '"')   { inStr = !inStr; continue }
      if (inStr)        { continue }
      if (ch === '{')   { depth++; continue }
      if (ch === '}')   { depth--; if (depth === 0) { end = i + 1; break } }
    }

    if (!end) {
      return c.json({ ok: false, error: 'Nao foi possivel delimitar o JSON do _n.ctx.r', scrape_status }, 422)
    }

    const ctx: any = JSON.parse(rawJson.slice(0, end))
    rawItems = ctx?.appProps?.pageProps?.data?.items ?? []

    if (rawItems.length === 0) {
      return c.json({
        ok: false, error: 'Nenhum item encontrado no JSON da pagina.',
        scrape_status, scrape_bytes,
      }, 422)
    }
  } catch (e: any) {
    return c.json({ ok: false, error: 'Falha ao scraping /ofertas: ' + (e?.message || e), scrape_status }, 500)
  }

  // ── 3. Helpers ────────────────────────────────────────────
  function detectCat(title: string, hint: string): string {
    if (hint && hint !== 'outros') return hint
    const t = title.toLowerCase()
    if (/iphone|galaxy|smartphone|celular|motorola|xiaomi|redmi/.test(t))     return 'smartphones'
    if (/notebook|macbook|laptop|ultrabook/.test(t))                           return 'notebooks'
    if (/smart tv|televisor|\btv\b|qled|oled|led [0-9]/.test(t))              return 'tv'
    if (/fone|headphone|airpods|speaker|caixa de som|headset/.test(t))        return 'audio'
    if (/playstation|xbox|nintendo|\bgame\b|console/.test(t))                  return 'games'
    if (/camera|drone|gopro/.test(t))                                          return 'cameras'
    if (/tablet|\bipad\b/.test(t))                                             return 'tablets'
    if (/geladeira|fogao|maquina de lavar|microondas|ar condicionado/.test(t)) return 'eletrodomesticos'
    if (/perfume|eau de|colonia/.test(t))                                      return 'perfumes'
    if (/relogio|smartwatch|\bwatch\b/.test(t))                                return 'smartwatches'
    if (/cadeira|sofa|mesa|cama|movel/.test(t))                                return 'moveis'
    if (/tenis|camisa|calcado|roupa|jaqueta/.test(t))                          return 'moda'
    if (/creatina|suplemento|whey|protein|vitamina/.test(t))                   return 'saude'
    if (/escada|ferramenta|parafuso|furadeira/.test(t))                        return 'ferramentas'
    return 'outros'
  }

  function makeSlug(title: string, mlId: string): string {
    return title.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .substring(0, 70) + '-' + mlId.toLowerCase()
  }

  // ── 4. Busca loja ML no banco ─────────────────────────────
  const mlStore = await DB.prepare(
    `SELECT id FROM stores WHERE slug = 'mercadolivre' AND is_active = 1 LIMIT 1`
  ).first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  // ── 5. Processa cada item do JSON ─────────────────────────
  const imported: any[] = []
  const skipped:  any[] = []
  const errors:   any[] = []

  for (const raw of rawItems.slice(0, limit)) {
    try {
      const card  = raw?.card ?? {}
      const meta  = card?.metadata ?? {}
      const comps: Record<string, any> = {}
      for (const comp of (card?.components ?? [])) comps[comp.type] = comp

      // Dados do produto — tudo ja esta no HTML, sem nenhuma chamada de API
      const mlId  = (meta.id || '').toUpperCase()
      if (!mlId || !/^MLB\d{10,}$/.test(mlId)) {
        skipped.push({ id: mlId || '?', reason: 'ID invalido ou catalog ID (< 10 digitos)' })
        continue
      }

      const title = comps.title?.title?.text?.trim() || mlId
      if (!title || title === mlId) {
        skipped.push({ id: mlId, reason: 'sem titulo no JSON' })
        continue
      }

      const priceBlk   = comps.price?.price ?? {}
      const price      = priceBlk?.current_price?.value as number | undefined
      const origPrice  = priceBlk?.previous_price?.value as number | undefined
      const discPct    = priceBlk?.discount?.value as number ?? 0

      if (!price || price <= 0) {
        skipped.push({ id: mlId, title: title.slice(0, 50), reason: 'sem preco no JSON' })
        continue
      }

      // URL limpa sem parametros de tracking
      const rawUrl   = meta.url || ''
      const permalink = rawUrl
        ? 'https://' + rawUrl.split('?')[0].split('#')[0]
        : `https://www.mercadolivre.com.br/p/${mlId}`

      // Link de afiliado — formato oficial do programa ML Afiliados
      const affUrl = `${permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

      // Imagem: monta URL a partir do picture_id (formato D_{id}-O.jpg)
      const picId  = (card?.pictures?.pictures ?? [])[0]?.id ?? ''
      const imgUrl = picId ? `https://http2.mlstatic.com/D_${picId}-O.jpg` : null

      const cat  = detectCat(title, categoryHint)
      const slug = makeSlug(title, mlId)
      const disc = discPct > 0
        ? discPct
        : (origPrice && origPrice > price ? Math.round(((origPrice - price) / origPrice) * 100) : 0)

      if (dryRun) {
        imported.push({
          ml_id: mlId, title: title.slice(0, 70), price,
          original_price: origPrice ?? null, discount_percent: disc,
          category: cat, affiliate_url: affUrl, image_url: imgUrl, dry_run: true,
        })
        continue
      }

      // ── 6. Salva ou atualiza no banco ─────────────────────
      // DEDUPLICAÇÃO: checa ml_item_id E affiliate_url para cobrir todos os casos
      const existing = await DB.prepare(
        `SELECT id, best_price FROM products WHERE ml_item_id = ? LIMIT 1`
      ).bind(mlId).first<{ id: number; best_price: number | null }>()

      if (existing) {
        // Produto já existe → atualiza preço/afiliado mas NÃO duplica
        await DB.prepare(`
          UPDATE products SET
            best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP,
            image_url  = COALESCE(NULLIF(image_url,''), ?),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, affUrl, imgUrl, existing.id).run()

        skipped.push({
          id: mlId, title: title.slice(0, 50),
          status: 'duplicado',
          reason: 'já importado — preço atualizado',
          price_before: existing.best_price, price_after: price, product_id: existing.id,
        })
        continue
      }

      // Checa também pela affiliate_url (produto sem ml_item_id)
      const existingByUrl = await DB.prepare(
        `SELECT id FROM offers WHERE affiliate_url = ? LIMIT 1`
      ).bind(affUrl).first<{ id: number }>()

      if (existingByUrl) {
        skipped.push({
          id: mlId, title: title.slice(0, 50),
          status: 'duplicado',
          reason: 'affiliate_url já cadastrado em outra oferta',
        })
        continue
      }

      const ins = await DB.prepare(`
        INSERT INTO products
          (name, slug, brand, category, description, image_url,
           ml_item_id, affiliate_url, affiliate_updated_at,
           best_price, best_store_id, offer_count, is_active,
           created_at, updated_at)
        VALUES (?, ?, NULL, ?, '', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(title, slug, cat, imgUrl, mlId, affUrl, price, storeId).run()

      const productId = ins.meta.last_row_id as number

      // Oferta correspondente (expira em 6h — dados das ofertas do dia mudam)
      const expiresAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString()
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, original_price,
           discount_percent, free_shipping, in_stock, product_url, image_url, cache_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
      `).bind(productId, storeId, mlId, title, price, origPrice ?? null, disc, affUrl, imgUrl, expiresAt).run()

      await DB.prepare(`UPDATE categories SET product_count = product_count + 1 WHERE slug = ?`)
        .bind(cat).run().catch(() => {})

      imported.push({
        id: productId, ml_id: mlId, title: title.slice(0, 70), price,
        original_price: origPrice ?? null, discount_percent: disc,
        category: cat, affiliate_url: affUrl, image_url: imgUrl,
      })

    } catch (e: any) {
      errors.push({ error: e?.message || 'exception' })
    }
  }

  const updated    = skipped.filter((s: any) => s.reason?.includes('atualizado')).length
  const duplicates = skipped.filter((s: any) => s.status === 'duplicado').length

  return c.json({
    ok: true,
    dry_run: dryRun,
    scrape: {
      status:          scrape_status,
      bytes:           scrape_bytes,
      total_found:     rawItems.length,
      processed:       Math.min(rawItems.length, limit),
    },
    summary: {
      imported:   imported.length,
      updated,
      duplicates,
      skipped:    skipped.length - updated - duplicates,
      errors:     errors.length,
    },
    imported,
    skipped,
    errors: errors.slice(0, 10),
    tip: imported.length > 0
      ? `${imported.length} produto(s) importado(s) direto da pagina de ofertas do ML!`
      : duplicates > 0
        ? `Todos os ${duplicates} link(s) já foram importados anteriormente.`
        : 'Nenhum produto novo. Pode ter tudo ja importado — rode com dry_run:true para ver.',
  })
})

// ── POST /admin/api/affiliate-bot/import-ids ─────────────
// Recebe lista de IDs/URLs do ML, busca preço e importa no banco
// Usa mesmas estratégias de preço do mlScraper (funciona no Worker)
admin.post('/api/affiliate-bot/import-ids', async (c) => {
  const { DB, CACHE } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const rawIds:  string[]  = body.ids || []
  const category: string   = (body.category || 'outros').trim()

  if (!rawIds.length) return c.json({ error: 'ids[] obrigatório' }, 400)

  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '61674414'
  const ML_API       = 'https://api.mercadolibre.com'
  const appId        = (c.env as any).ML_APP_ID || '3098423019766450'
  const secret       = (c.env as any).ML_SECRET  || ''

  // ── 1. Token ────────────────────────────────────────────
  let token: string | null = null
  let token_source = 'none'
  const oauthToken = await CACHE?.get('ml_access_token').catch(() => null)
  if (oauthToken) { token = oauthToken; token_source = 'oauth' }
  if (!token && secret) {
    const cached = await CACHE?.get('ml_app_token').catch(() => null)
    if (cached) { token = cached; token_source = 'cc_cache' }
    else {
      try {
        const tr = await fetch(`${ML_API}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: secret }),
        })
        if (tr.ok) {
          const td: any = await tr.json()
          if (td.access_token) {
            token = td.access_token; token_source = 'cc_new'
            await CACHE?.put('ml_app_token', token!, { expirationTtl: 18000 }).catch(() => {})
          }
        }
      } catch {}
    }
  }

  const authHeaders: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0', 'Accept': 'application/json' }
  if (token) authHeaders['Authorization'] = `Bearer ${token}`

  // ── 2. Normaliza IDs ────────────────────────────────────
  function normalizeId(s: string): string | null {
    s = s.trim()
    let m = s.match(/\/p\/(MLB\d+)/i)
    if (m) return m[1].toUpperCase()
    m = s.match(/MLB[-_](\d+)/i)
    if (m) return 'MLB' + m[1]
    m = s.match(/(MLB\d+)/i)
    if (m) return m[1].toUpperCase()
    return null
  }
  const ids = rawIds.map(normalizeId).filter(Boolean) as string[]
  if (!ids.length) return c.json({ error: 'Nenhum ID ML válido encontrado' }, 400)

  // ── 3. Estratégias de preço (mesmas do mlScraper) ───────
  function isCatalogId(id: string): boolean { return id.replace(/^MLB/i,'').length <= 9 }

  interface PInfo { price:number|null; orig:number|null; thumb:string|null; link:string; in_stock:boolean; strategy:string; title:string|null }
  const NULL_P = (id:string): PInfo => ({ price:null, orig:null, thumb:null, link:`https://www.mercadolivre.com.br/p/${id}`, in_stock:false, strategy:'none', title:null })

  async function getPrice(mlId: string): Promise<PInfo> {
    if (!isCatalogId(mlId)) {
      // item_id real → /items/{id} direto
      try {
        const r = await fetch(`${ML_API}/items/${mlId}?attributes=id,title,price,original_price,available_quantity,thumbnail,permalink,status`, { headers: authHeaders })
        if (r.ok) {
          const d: any = await r.json().catch(() => null)
          if (d?.price) return {
            price: d.price, orig: d.original_price || null,
            thumb: d.thumbnail || null, link: d.permalink || `https://www.mercadolivre.com.br/p/${mlId}`,
            in_stock: (d.available_quantity || 0) > 0 && d.status !== 'closed',
            strategy: 'item_direct', title: d.title || null,
          }
        }
      } catch {}
    }

    // Estratégia A: /products/{id}/items → lista de anúncios ativos
    try {
      const r = await fetch(`${ML_API}/products/${mlId}/items?limit=5`, { headers: authHeaders })
      if (r.ok) {
        const d: any = await r.json().catch(() => null)
        const items: any[] = d?.results || d?.items || []
        const active = items.filter((x:any) => x.status !== 'closed' && x.status !== 'paused' && x.price)
        const pool   = active.length > 0 ? active : items.filter((x:any) => x.price)
        const best   = pool.sort((a:any,b:any) => (a.price||0)-(b.price||0))[0]
        if (best?.price) return {
          price: best.price, orig: best.original_price || null,
          thumb: best.thumbnail || null, link: best.permalink || `https://www.mercadolivre.com.br/p/${mlId}`,
          in_stock: best.status !== 'closed' && best.status !== 'paused',
          strategy: 'catalog_items', title: best.title || null,
        }
      }
    } catch {}

    // Estratégia B: /products/{id} → buy_box_winner
    try {
      const r = await fetch(`${ML_API}/products/${mlId}?attributes=id,name,status,buy_box_winner,suggested_price,pictures`, { headers: authHeaders })
      if (r.ok) {
        const d: any = await r.json().catch(() => null)
        if (d) {
          const bbw = d.buy_box_winner
          const thumb = d.pictures?.[0]?.url || null
          if (bbw?.price) return {
            price: bbw.price, orig: bbw.original_price || null,
            thumb, link: bbw.permalink || `https://www.mercadolivre.com.br/p/${mlId}`,
            in_stock: true, strategy: 'buy_box_winner', title: d.name || null,
          }
          const sp = d.suggested_price || d.price
          if (sp) return {
            price: sp, orig: null, thumb,
            link: `https://www.mercadolivre.com.br/p/${mlId}`,
            in_stock: d.status !== 'inactive', strategy: 'suggested_price', title: d.name || null,
          }
        }
      }
    } catch {}

    return NULL_P(mlId)
  }

  // ── 4. Store ID do Mercado Livre ────────────────────────
  const mlStore = await DB.prepare(`SELECT id FROM stores WHERE slug='mercadolivre' AND is_active=1 LIMIT 1`).first<{id:number}>()
  const storeId = mlStore?.id ?? 3

  // ── 5. Auto-detecta categoria ───────────────────────────
  function detectCat(title: string, fallback: string): string {
    const t = (title||'').toLowerCase()
    if (fallback && fallback !== 'outros') return fallback
    if (t.match(/iphone|galaxy|smartphone|celular/)) return 'smartphones'
    if (t.match(/notebook|macbook|laptop/)) return 'notebooks'
    if (t.match(/smart tv|televisor|\btv\b|qled|oled/)) return 'tv'
    if (t.match(/fone|headphone|airpods|speaker|caixa de som/)) return 'audio'
    if (t.match(/playstation|xbox|nintendo|console|\bgame\b/)) return 'games'
    if (t.match(/câmera|camera|drone|gopro/)) return 'cameras'
    if (t.match(/tablet|ipad/)) return 'tablets'
    if (t.match(/geladeira|fogão|máquina de lavar|microondas|ar condicionado/)) return 'eletrodomesticos'
    if (t.match(/perfume|eau de/)) return 'perfumes'
    return 'outros'
  }

  // ── 6. Importa cada ID ──────────────────────────────────
  const imported: any[] = []
  const skipped:  any[] = []
  const errors:   any[] = []

  for (const mlId of ids) {
    try {
      const p = await getPrice(mlId)
      await new Promise(r => setTimeout(r, 150))

      if (!p.price) {
        skipped.push({ ml_id: mlId, reason: 'sem preço — catalog_items e buy_box_winner retornaram null' })
        continue
      }

      const title = p.title || mlId
      const cat   = detectCat(title, category)
      const slug  = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
        .substring(0, 80) + '-' + mlId.toLowerCase()

      const affiliate_url = `${p.link}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

      // DEDUPLICAÇÃO: checa ml_item_id (mais confiável que slug)
      const existing = await DB.prepare(
        `SELECT id FROM products WHERE ml_item_id = ? LIMIT 1`
      ).bind(mlId).first<{id:number}>()

      if (existing) {
        // Produto já existe → atualiza preço/afiliado mas NÃO duplica
        await DB.prepare(`
          UPDATE products SET affiliate_url=?, affiliate_updated_at=CURRENT_TIMESTAMP,
            best_price=?, image_url=COALESCE(NULLIF(image_url,''),?), updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(affiliate_url, p.price, p.thumb, existing.id).run()
        skipped.push({
          ml_id: mlId, title,
          status: 'duplicado',
          reason: 'já importado — preço e afiliado atualizados',
          id: existing.id,
        })
        continue
      }

      // Checa também pela affiliate_url
      const existingByUrl = await DB.prepare(
        `SELECT id FROM offers WHERE affiliate_url = ? LIMIT 1`
      ).bind(affiliate_url).first<{id:number}>()

      if (existingByUrl) {
        skipped.push({
          ml_id: mlId, title,
          status: 'duplicado',
          reason: 'affiliate_url já cadastrado em outra oferta',
        })
        continue
      }

      const ins = await DB.prepare(`
        INSERT INTO products
          (name,slug,brand,category,description,image_url,ml_item_id,
           affiliate_url,affiliate_updated_at,best_price,best_store_id,
           offer_count,is_active,created_at,updated_at)
        VALUES (?,?,?,?,'',?,?,?,CURRENT_TIMESTAMP,?,?,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `).bind(title,slug,'',cat,p.thumb,mlId,affiliate_url,p.price,storeId).run()

      const productId = ins.meta.last_row_id as number
      const disc  = p.orig && p.orig > p.price ? Math.round(((p.orig-p.price)/p.orig)*100) : 0
      const expAt = new Date(Date.now() + 6*3600*1000).toISOString()

      await DB.prepare(`
        INSERT INTO offers (product_id,store_id,external_id,title,price,original_price,
          discount_percent,free_shipping,in_stock,product_url,image_url,cache_expires_at)
        VALUES (?,?,?,?,?,?,?,1,?,?,?,?)
      `).bind(productId,storeId,mlId,title,p.price,p.orig||null,disc,p.in_stock?1:0,affiliate_url,p.thumb,expAt).run()

      await DB.prepare(`UPDATE categories SET product_count=product_count+1 WHERE slug=?`)
        .bind(cat).run().catch(()=>{})

      imported.push({ id: productId, title, price: p.price, original_price: p.orig,
        category: cat, affiliate_url, ml_id: mlId, thumbnail: p.thumb,
        in_stock: p.in_stock, strategy: p.strategy })

    } catch (e: any) {
      errors.push({ ml_id: mlId, error: e?.message || 'exception' })
    }
  }

  const duplicates = skipped.filter((s: any) => s.status === 'duplicado').length

  return c.json({
    ok: true,
    token_source,
    summary: {
      found:      ids.length,
      imported:   imported.length,
      duplicates,
      skipped:    skipped.length - duplicates,
      errors:     errors.length,
    },
    imported,
    skipped,
    errors: errors.slice(0, 10),
    tip: imported.length > 0
      ? `${imported.length} produto(s) importado(s) com sucesso!`
      : duplicates > 0
        ? `Todos os ${duplicates} ID(s) já foram importados anteriormente.`
        : 'Nenhum produto novo importado.',
  })
})

// ── Rotas ML dentro do Admin (com auth) ──────────────────
admin.route('/api/ml', ml)

// ============================================================
// AUTO-SYNC BOT — Scraping completo ML + geração de links
// POST /admin/api/affiliate-bot/auto-sync
//
// Faz 3 etapas em sequência:
//  1. Scraping de /ofertas  → importa até 54 produtos novos com link afiliado
//  2. Busca por nome        → para produtos sem ml_item_id, busca no ML pelo título
//  3. Atualização de preço  → re-scrapa permalink dos produtos com ml_item_id
// ============================================================
admin.post('/api/affiliate-bot/auto-sync', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const dryRun      = !!body.dry_run
  const steps       = (body.steps as string[] | undefined) ?? ['import', 'search', 'prices']
  // limit por etapa: padrão 1 para evitar timeout no Worker (~30s wall clock)
  // Cada chamada GeckoAPI leva ~5s → limit=1: ~10s max (PDP+PLP fallback)
  // O front-end usa has_more para chamar em loop até acabar os produtos
  const searchLimit = Math.min(parseInt(body.search_limit) || 1, 5)
  const pricesLimit = Math.min(parseInt(body.prices_limit) || 1, 5)

  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '61674414'

  const affLink = (url: string) =>
    `${url}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

  const report: Record<string, any> = { dry_run: dryRun, steps_run: steps }

  // ─────────────────────────────────────────────────────────
  // HELPERS compartilhados
  // ─────────────────────────────────────────────────────────
  function detectCat(title: string): string {
    const t = title.toLowerCase()
    if (/iphone|galaxy|smartphone|celular|motorola|xiaomi|redmi/.test(t))      return 'smartphones'
    if (/notebook|macbook|laptop|ultrabook/.test(t))                            return 'notebooks'
    if (/smart tv|televisor|\btv\b|qled|oled|led [0-9]/.test(t))               return 'tv'
    if (/fone|headphone|airpods|speaker|caixa de som|headset/.test(t))         return 'audio'
    if (/playstation|xbox|nintendo|\bgame\b|console/.test(t))                   return 'games'
    if (/camera|drone|gopro/.test(t))                                           return 'cameras'
    if (/tablet|\bipad\b/.test(t))                                              return 'tablets'
    if (/geladeira|fogao|maquina de lavar|microondas|ar condicionado/.test(t))  return 'eletrodomesticos'
    if (/perfume|eau de|colonia/.test(t))                                       return 'perfumes'
    if (/relogio|smartwatch|\bwatch\b/.test(t))                                 return 'smartwatches'
    if (/cadeira|sofa|mesa|cama|movel/.test(t))                                 return 'moveis'
    if (/tenis|camisa|calcado|roupa|jaqueta/.test(t))                           return 'moda'
    if (/creatina|suplemento|whey|protein|vitamina/.test(t))                    return 'saude'
    if (/escada|ferramenta|parafuso|furadeira/.test(t))                         return 'ferramentas'
    return 'outros'
  }

  function makeSlug(title: string, mlId: string): string {
    return title.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .substring(0, 70) + '-' + mlId.toLowerCase()
  }

  const mlStore = await DB.prepare(
    `SELECT id FROM stores WHERE slug = 'mercadolivre' AND is_active = 1 LIMIT 1`
  ).first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  // ─────────────────────────────────────────────────────────
  // ETAPA 1 — Scraping /ofertas (importa produtos novos)
  // ─────────────────────────────────────────────────────────
  if (steps.includes('import')) {
    const imp: any = { status: 'ok', imported: 0, updated: 0, skipped: 0, errors: 0 }
    report.import = imp

    try {
      const res = await fetch('https://www.mercadolivre.com.br/ofertas', {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Referer':         'https://www.mercadolivre.com.br/',
        },
      })
      imp.http_status = res.status

      if (!res.ok) { imp.status = 'error'; imp.error = `HTTP ${res.status}`; }
      else {
        const html = await res.text()
        imp.html_kb = Math.round(html.length / 1024)

        if (html.includes('_bmstate') || html.includes('PoW') || html.length < 20000) {
          imp.status = 'blocked'; imp.error = 'Bot challenge detectado'
        } else {
          // Extrai _n.ctx.r — parse incremental
          const ctxMatch = html.match(/_n\.ctx\.r\s*=\s*(\{)/)
          if (!ctxMatch || ctxMatch.index === undefined) {
            imp.status = 'error'; imp.error = '_n.ctx.r não encontrado no HTML'
          } else {
            const jsonStart = ctxMatch.index + ctxMatch[0].length - 1
            const rawJson   = html.slice(jsonStart)
            let depth = 0, end = 0, inStr = false, esc = false
            for (let i = 0; i < rawJson.length; i++) {
              const ch = rawJson[i]
              if (esc)         { esc = false; continue }
              if (ch === '\\') { esc = true;  continue }
              if (ch === '"')  { inStr = !inStr; continue }
              if (inStr)       { continue }
              if (ch === '{')  { depth++; continue }
              if (ch === '}')  { depth--; if (depth === 0) { end = i + 1; break } }
            }
            const ctx: any   = end ? JSON.parse(rawJson.slice(0, end)) : {}
            const rawItems: any[] = ctx?.appProps?.pageProps?.data?.items ?? []
            imp.total_found = rawItems.length

            for (const raw of rawItems) {
              try {
                const card  = raw?.card ?? {}
                const meta  = card?.metadata ?? {}
                const comps: Record<string, any> = {}
                for (const comp of (card?.components ?? [])) comps[comp.type] = comp

                const mlId = (meta.id || '').toUpperCase()
                if (!mlId || !/^MLB\d{10,}$/.test(mlId)) { imp.skipped++; continue }

                const title = comps.title?.title?.text?.trim() || ''
                if (!title) { imp.skipped++; continue }

                const priceBlk  = comps.price?.price ?? {}
                const price     = priceBlk?.current_price?.value as number | undefined
                const origPrice = priceBlk?.previous_price?.value as number | undefined
                const discPct   = (priceBlk?.discount?.value as number) ?? 0
                if (!price || price <= 0) { imp.skipped++; continue }

                const rawUrl    = meta.url || ''
                const permalink = rawUrl
                  ? 'https://' + rawUrl.split('?')[0].split('#')[0]
                  : `https://www.mercadolivre.com.br/p/${mlId}`
                const affUrl    = affLink(permalink)
                const picId     = (card?.pictures?.pictures ?? [])[0]?.id ?? ''
                const imgUrl    = picId ? `https://http2.mlstatic.com/D_${picId}-O.jpg` : null
                const cat       = detectCat(title)
                const disc      = discPct > 0
                  ? discPct
                  : (origPrice && origPrice > price ? Math.round(((origPrice - price) / origPrice) * 100) : 0)

                if (dryRun) { imp.imported++; continue }

                const existing = await DB.prepare(
                  `SELECT id FROM products WHERE ml_item_id = ? LIMIT 1`
                ).bind(mlId).first<{ id: number }>()

                if (existing) {
                  await DB.prepare(`
                    UPDATE products SET
                      best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP,
                      image_url  = COALESCE(NULLIF(image_url,''), ?), updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                  `).bind(price, affUrl, imgUrl, existing.id).run()
                  // Atualiza oferta
                  await DB.prepare(`
                    UPDATE offers SET price = ?, affiliate_url = ?, last_updated = CURRENT_TIMESTAMP
                    WHERE product_id = ? AND store_id = ?
                  `).bind(price, affUrl, existing.id, storeId).run()
                  imp.updated++
                } else {
                  const slug = makeSlug(title, mlId)
                  const ins  = await DB.prepare(`
                    INSERT OR IGNORE INTO products
                      (name, slug, brand, category, description, image_url,
                       ml_item_id, affiliate_url, affiliate_updated_at,
                       best_price, best_store_id, offer_count, is_active,
                       created_at, updated_at)
                    VALUES (?, ?, NULL, ?, '', ?, ?, ?, CURRENT_TIMESTAMP,
                            ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                  `).bind(title, slug, cat, imgUrl, mlId, affUrl, price, storeId).run()

                  if (ins.meta.last_row_id) {
                    const pid = ins.meta.last_row_id as number
                    const exp = new Date(Date.now() + 6 * 3600_000).toISOString()
                    await DB.prepare(`
                      INSERT OR IGNORE INTO offers
                        (product_id, store_id, external_id, title, price, original_price,
                         discount_percent, free_shipping, in_stock,
                         product_url, affiliate_url, image_url, cache_expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
                    `).bind(pid, storeId, mlId, title, price, origPrice ?? null,
                             disc, affUrl, affUrl, imgUrl, exp).run()
                    await DB.prepare(`UPDATE categories SET product_count = product_count + 1 WHERE slug = ?`)
                      .bind(cat).run().catch(() => {})
                    imp.imported++
                  } else {
                    imp.skipped++ // slug duplicado
                  }
                }
              } catch { imp.errors++ }
            }
          }
        }
      }
    } catch (e: any) {
      report.import = { status: 'error', error: e?.message || 'exception' }
    }
  }

  // ─────────────────────────────────────────────────────────
  // HELPER: GeckoAPI /v1/extract — encapsula auth, retry e erro
  // Retorna: { data, error, noCredits }
  //   data      → payload útil (ou null se falhou)
  //   error     → string descritiva do erro (ou null)
  //   noCredits → true se INSUFFICIENT_CREDITS (para parar o loop)
  // ─────────────────────────────────────────────────────────
  const GECKO_BASE = 'https://api.geckoapi.com.br'
  const geckoKey   = (c.env as any).GECKO_API_KEY as string | undefined

  type GeckoResult = { data: any; error: string | null; noCredits: boolean }

  async function geckoExtract(payload: Record<string, unknown>): Promise<GeckoResult> {
    const empty: GeckoResult = { data: null, error: null, noCredits: false }
    if (!geckoKey) return { ...empty, error: 'GECKO_API_KEY não configurada' }
    try {
      const r = await fetch(`${GECKO_BASE}/v1/extract`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${geckoKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(payload),
      })
      const json: any = await r.json()
      if (json.errorCode === 'INSUFFICIENT_CREDITS') {
        return { data: null, error: 'Créditos GeckoAPI esgotados — recarregue em geckoapi.com.br', noCredits: true }
      }
      if (json.errorCode || !r.ok) {
        return { data: null, error: `GeckoAPI error: ${json.message || json.errorCode || r.status}`, noCredits: false }
      }
      return { data: json.data ?? null, error: null, noCredits: false }
    } catch (e: any) {
      return { data: null, error: `GeckoAPI exception: ${e?.message || 'unknown'}`, noCredits: false }
    }
  }

  // ─────────────────────────────────────────────────────────
  // ETAPA 2 — Busca por nome via GeckoAPI PLP (1 crédito/busca)
  // Produtos sem ml_item_id → keyword → 1º match → url+sku+preço
  // Link afiliado = URL limpa do produto + parâmetros afiliado
  // ─────────────────────────────────────────────────────────
  if (steps.includes('search')) {
    const srch: any = {
      status: 'ok', found: 0, skipped: 0, errors: 0,
      no_gecko_key: !geckoKey, products: [],
    }
    report.search = srch

    if (!geckoKey) {
      srch.status = 'skipped'
      srch.error  = 'GECKO_API_KEY não configurada — defina o secret no Cloudflare Pages'
    } else {
      try {
        // Conta total ainda sem link (para has_more)
        const noLinkCount = await DB.prepare(`
          SELECT COUNT(*) as n FROM products
          WHERE is_active = 1 AND (ml_item_id IS NULL OR ml_item_id = '')
        `).first<{ n: number }>()
        srch.total_pending = noLinkCount?.n ?? 0

        const noLink = await DB.prepare(`
          SELECT id, name, brand, best_price FROM products
          WHERE is_active = 1
            AND (ml_item_id IS NULL OR ml_item_id = '')
          ORDER BY id LIMIT ?
        `).bind(searchLimit).all<any>()

        for (const prod of noLink.results ?? []) {
          try {
            const keyword = prod.name.replace(/['"()\[\]]/g, '').trim()

            // GeckoAPI PLP: busca produtos no ML por keyword
            const { data, error: geckoErr, noCredits } = await geckoExtract({
              target:  'mercadolivre.com.br',
              type:    'plp',
              keyword,
            })

            // Créditos esgotados → para o loop imediatamente
            if (noCredits) {
              srch.status = 'no_credits'
              srch.error  = geckoErr!
              srch.total_pending = srch.total_pending // mantém o count real
              break
            }

            if (geckoErr || !data) { srch.skipped++; continue }

            const items: any[] = data?.items ?? []
            // Pega o 1º item com URL válida, SKU e preço positivo
            const first = items.find((it: any) =>
              it?.url?.startsWith('http') && it?.sku && it?.price > 0
            )

            if (!first) { srch.skipped++; continue }

            // sku = "MLB4410983832" — é o ml_item_id
            const mlId      = (first.sku as string).toUpperCase()
            const permalink = (first.url as string).split('?')[0].split('#')[0]
            const price     = (first.price as number) ?? (prod.best_price ?? null)
            const newAffUrl = affLink(permalink)

            srch.products.push({
              product_id:    prod.id,
              name:          prod.name.slice(0, 60),
              ml_id:         mlId,
              permalink,
              affiliate_url: newAffUrl,
              price,
            })

            if (!dryRun) {
              await DB.prepare(`
                UPDATE products SET
                  ml_item_id = ?, affiliate_url = ?,
                  affiliate_updated_at = CURRENT_TIMESTAMP,
                  best_price  = COALESCE(NULLIF(?, 0), best_price),
                  updated_at  = CURRENT_TIMESTAMP
                WHERE id = ?
              `).bind(mlId, newAffUrl, price ?? 0, prod.id).run()

              // Atualiza ou insere oferta
              const offExist = await DB.prepare(
                `SELECT id FROM offers WHERE product_id = ? AND store_id = ? LIMIT 1`
              ).bind(prod.id, storeId).first<{ id: number }>()

              if (offExist) {
                await DB.prepare(`
                  UPDATE offers SET
                    external_id   = ?,
                    price         = COALESCE(NULLIF(?, 0), price),
                    product_url   = ?,
                    affiliate_url = ?,
                    last_updated  = CURRENT_TIMESTAMP
                  WHERE id = ?
                `).bind(mlId, price ?? 0, newAffUrl, newAffUrl, offExist.id).run()
              } else {
                await DB.prepare(`
                  INSERT OR IGNORE INTO offers
                    (product_id, store_id, external_id, title, price,
                     free_shipping, in_stock, product_url, affiliate_url)
                  VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
                `).bind(prod.id, storeId, mlId, prod.name,
                         price ?? 0, newAffUrl, newAffUrl).run()
              }
            }
            srch.found++
          } catch { srch.errors++ }
        }
      } catch (e: any) {
        srch.status = 'error'; srch.error = e?.message || 'exception'
      }
    } // fecha else (!geckoKey)
  } // fecha if (steps.includes('search'))

  // ─────────────────────────────────────────────────────────
  // ETAPA 3 — Atualização de preço via GeckoAPI (PDP + fallback PLP)
  //
  // Para cada produto com ml_item_id (os mais desatualizados primeiro):
  //   1. Tenta GeckoAPI PDP → cashPrice / price
  //   2. Se PDP retornar price=null (catálogo sem oferta selecionada),
  //      faz fallback GeckoAPI PLP pelo nome do produto → pega preço
  //      e atualiza também o permalink/ml_item_id se o PLP trouxer
  //      um resultado melhor.
  //
  // Limite: 5 produtos por execução (cada um consome 1-2 créditos Gecko)
  // ─────────────────────────────────────────────────────────
  if (steps.includes('prices')) {
    const prcs: any = {
      status: 'ok', updated: 0, unchanged: 0, errors: 0, skipped: 0,
      pdp_hits: 0, plp_fallbacks: 0, no_gecko_key: !geckoKey,
    }
    report.prices = prcs

    if (!geckoKey) {
      prcs.status = 'skipped'
      prcs.error  = 'GECKO_API_KEY não configurada — defina o secret no Cloudflare Pages'
    } else {
      try {
        // Conta total ainda com preço desatualizado (para has_more)
        const staleCount = await DB.prepare(`
          SELECT COUNT(*) as n FROM products
          WHERE is_active = 1
            AND ml_item_id IS NOT NULL AND ml_item_id != ''
            AND (affiliate_updated_at IS NULL
                 OR affiliate_updated_at < datetime('now', '-6 hours'))
        `).first<{ n: number }>()
        prcs.total_stale = staleCount?.n ?? 0

        // Produtos mais desatualizados primeiro (limita créditos e tempo do Worker)
        const withId = await DB.prepare(`
          SELECT p.id, p.name, p.ml_item_id, p.affiliate_url, p.best_price,
                 o.product_url, o.id as offer_id
          FROM products p
          LEFT JOIN offers o ON o.product_id = p.id AND o.store_id = ?
          WHERE p.is_active = 1
            AND p.ml_item_id IS NOT NULL AND p.ml_item_id != ''
          ORDER BY p.affiliate_updated_at ASC NULLS FIRST
          LIMIT ?
        `).bind(storeId, pricesLimit).all<any>()

        for (const prod of withId.results ?? []) {
          try {
            // Monta URL canônica a partir do que temos no banco
            const baseUrl = (prod.product_url || prod.affiliate_url || '')
              .split('?')[0].split('#')[0]
            const productUrl = baseUrl.startsWith('http')
              ? baseUrl
              : `https://www.mercadolivre.com.br/p/${prod.ml_item_id.toLowerCase()}`

            let newPrice:   number | null = null
            let newUrl:     string        = productUrl
            let newMlId:    string        = prod.ml_item_id

            // ── 1. Tentativa PDP ────────────────────────────
            // GeckoAPI PDP retorna { price, cashPrice, canonicalUrl, name, ... }
            const { data: pdpData, noCredits: pdpNoCredits, error: pdpErr } = await geckoExtract({
              target: 'mercadolivre.com.br',
              type:   'pdp',
              url:    productUrl,
            })

            // Créditos esgotados → para o loop imediatamente
            if (pdpNoCredits) {
              prcs.status = 'no_credits'
              prcs.error  = pdpErr!
              break
            }

            if (pdpData) {
              // Preferência: cashPrice (à vista) > price (com parcelamento)
              const pdpPrice =
                (pdpData.cashPrice && pdpData.cashPrice > 0) ? pdpData.cashPrice
                  : (pdpData.price && pdpData.price > 0)    ? pdpData.price
                  : null

              if (pdpPrice && pdpPrice > 0) {
                newPrice = pdpPrice
                newUrl   = (pdpData.canonicalUrl || productUrl).split('?')[0].split('#')[0]
                prcs.pdp_hits++
              }
            }

            // ── 2. Fallback PLP (quando PDP não retornou preço) ──
            if (!newPrice && prod.name) {
              const keyword = (prod.name as string).replace(/['"()\[\]]/g, '').trim()
              const { data: plpData, noCredits: plpNoCredits, error: plpErr } = await geckoExtract({
                target:  'mercadolivre.com.br',
                type:    'plp',
                keyword,
              })

              if (plpNoCredits) {
                prcs.status = 'no_credits'
                prcs.error  = plpErr!
                break
              }

              const items: any[] = plpData?.items ?? []
              const best = items.find((it: any) =>
                it?.url?.startsWith('http') && it?.sku && it?.price > 0
              )

              if (best) {
                newPrice = best.price as number
                newUrl   = (best.url as string).split('?')[0].split('#')[0]
                newMlId  = (best.sku  as string).toUpperCase()
                prcs.plp_fallbacks++
              }
            }

            // ── Sem preço mesmo após os dois métodos → skip ──
            if (!newPrice || newPrice <= 0) { prcs.skipped++; continue }

            const newAffUrl = affLink(newUrl)

            if (!dryRun) {
              await DB.prepare(`
                UPDATE products SET
                  best_price           = ?,
                  ml_item_id           = ?,
                  affiliate_url        = ?,
                  affiliate_updated_at = CURRENT_TIMESTAMP,
                  updated_at           = CURRENT_TIMESTAMP
                WHERE id = ?
              `).bind(newPrice, newMlId, newAffUrl, prod.id).run()

              if (prod.offer_id) {
                await DB.prepare(`
                  UPDATE offers SET
                    price         = ?,
                    external_id   = ?,
                    product_url   = ?,
                    affiliate_url = ?,
                    last_updated  = CURRENT_TIMESTAMP
                  WHERE id = ?
                `).bind(newPrice, newMlId, newAffUrl, newAffUrl, prod.offer_id).run()
              }

              // Histórico de preços
              await DB.prepare(`
                INSERT OR IGNORE INTO price_history
                  (product_id, store_id, price, recorded_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              `).bind(prod.id, storeId, newPrice).run().catch(() => {})
            }

            const changed = Math.abs((prod.best_price ?? 0) - newPrice) > 0.01
            if (changed) prcs.updated++; else prcs.unchanged++

          } catch { prcs.errors++ }
        }
      } catch (e: any) {
        prcs.status = 'error'; prcs.error = e?.message || 'exception'
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Resultado final
  // ─────────────────────────────────────────────────────────
  // has_more: informa ao front se ainda há produtos para processar
  // Para o loop se créditos acabaram (no_credits) — não adianta chamar de novo
  const searchNoCredits = report.search?.status === 'no_credits'
  const pricesNoCredits = report.prices?.status === 'no_credits'

  const searchPending   = (report.search?.total_pending ?? 0)
  const searchProcessed = (report.search?.found ?? 0) + (report.search?.skipped ?? 0) + (report.search?.errors ?? 0)
  const searchHasMore   = steps.includes('search')
    && !searchNoCredits
    && (searchPending - searchProcessed) > 0

  const pricesStale     = (report.prices?.total_stale ?? 0)
  const pricesProcessed = (report.prices?.updated ?? 0) + (report.prices?.unchanged ?? 0)
    + (report.prices?.skipped ?? 0) + (report.prices?.errors ?? 0)
  const pricesHasMore   = steps.includes('prices')
    && !pricesNoCredits
    && (pricesStale - pricesProcessed) > 0

  const totalActions =
    ((report.import?.imported ?? 0) + (report.import?.updated ?? 0)) +
    (report.search?.found ?? 0) +
    (report.prices?.updated ?? 0)

  return c.json({
    ok:           true,
    dry_run:      dryRun,
    total_actions: totalActions,
    has_more:     searchHasMore || pricesHasMore,
    report,
    tip: totalActions > 0
      ? `${totalActions} ação(ões) executada(s) com sucesso!`
      : 'Nada novo encontrado — todos os produtos já estão atualizados.',
  })
})

// ============================================================
// BUSCAPÉ — Importar produto + ofertas via scraping JSON-LD
// ============================================================

// ── POST /admin/api/affiliate-bot/import-buscape ─────────────
// Recebe: { url: "https://www.buscape.com.br/..." }
// 1. fetch(url) → HTML
// 2. Parseia <script type="application/ld+json"> → Product + offers
// 3. Parseia __NEXT_DATA__ → productID, entityID
// 4. Para cada oferta: upsert em products + offers (com affiliate_url)
// 5. Retorna: { imported, updated, offers[], product }
admin.post('/api/affiliate-bot/import-buscape', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const url: string = (body.url || '').trim()

  if (!url || !url.includes('buscape.com.br')) {
    return c.json({ ok: false, error: 'URL inválida — precisa ser do buscape.com.br' }, 400)
  }

  // ── 1. Fetch HTML do Buscapé ─────────────────────────────────
  let html = ''
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) {
      return c.json({ ok: false, error: `Buscapé retornou HTTP ${resp.status}` }, 502)
    }
    html = await resp.text()
  } catch (e: any) {
    return c.json({ ok: false, error: `Erro ao buscar URL: ${e?.message || 'timeout'}` }, 502)
  }

  // ── 2. Parseia JSON-LD — Product com offers ──────────────────
  // Buscapé usa Next.js e embute <script type="application/ld+json">
  // com @graph contendo @type=Product + lista de offers
  type BuscapeOffer = {
    id: string          // OID da oferta
    offeredBy: string   // Nome da loja (ex: "Casas Bahia")
    price: number
    image?: string
    url?: string
  }

  type ProductLD = {
    name: string
    brand?: string
    image?: string
    description?: string
    ean?: string
    offers?: { offers?: BuscapeOffer[] }
  }

  let productLD: ProductLD | null = null
  let rawOffers: BuscapeOffer[] = []

  // Extrai todos os blocos JSON-LD
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of ldMatches) {
    try {
      const parsed: any = JSON.parse(m[1].trim())
      // Pode vir como objeto direto ou como @graph
      const nodes: any[] = parsed['@graph'] ? parsed['@graph'] : [parsed]
      for (const node of nodes) {
        if (node['@type'] === 'Product' && node.offers) {
          productLD = node as ProductLD
          // Buscapé aninha: offers.offers = array de ofertas
          const offersNode = node.offers
          rawOffers = Array.isArray(offersNode)
            ? offersNode
            : (offersNode?.offers ?? offersNode?.itemListElement ?? [])
          break
        }
      }
    } catch { /* ignora JSON mal-formado */ }
    if (productLD) break
  }

  if (!productLD) {
    return c.json({ ok: false, error: 'Produto não encontrado no JSON-LD desta página. Verifique se a URL é de um produto (PDP).' }, 422)
  }

  if (rawOffers.length === 0) {
    return c.json({ ok: false, error: 'Nenhuma oferta encontrada no JSON-LD. O produto pode estar fora de estoque.' }, 422)
  }

  // ── 3. Parseia __NEXT_DATA__ — productID e entityID ──────────
  let buscapeProductId: string | null = null
  let buscapeEntityId: string | null = null
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (nextDataMatch) {
    try {
      const nd: any = JSON.parse(nextDataMatch[1])
      // Navega pelos props do Next.js para encontrar productID
      const pageProps = nd?.props?.pageProps ?? {}
      buscapeProductId = (
        pageProps?.product?.id ??
        pageProps?.productId ??
        pageProps?.product?.productID ??
        nd?.query?.productSlug ??
        null
      )?.toString() ?? null
      buscapeEntityId = (
        pageProps?.product?.entityId ??
        pageProps?.entityId ??
        null
      )?.toString() ?? null
    } catch { /* ignora */ }
  }

  // Fallback: tenta extrair productId da URL
  // Ex: /barbeador-philips/5600-abc123 → último segmento
  if (!buscapeProductId) {
    const urlSlug = url.split('/').filter(Boolean).pop() ?? ''
    // Tenta formato "slug-PRODUCT_ID" (ex: modelo-abc-12345)
    const slugId = urlSlug.match(/[a-f0-9]{8,}$/i)?.[0] ?? null
    if (slugId) buscapeProductId = slugId
  }

  // ── 4. Monta slug e normaliza dados do produto ───────────────
  const productName: string = (productLD.name || 'Produto Buscapé').trim()
  const productBrand: string = (
    (typeof productLD.brand === 'string' ? productLD.brand : (productLD.brand as any)?.name) ?? ''
  ).trim()
  const productImage: string = (
    Array.isArray(productLD.image)
      ? (productLD.image as any)[0]
      : productLD.image
  ) ?? ''
  const productDesc: string = (productLD.description ?? '').trim()
  const productEan: string = (productLD.ean ?? '').trim()

  // Gera slug único a partir do nome
  const slugBase = productName
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  // Garante unicidade adicionando sufixo aleatório se slug já existir
  const slugSuffix = Math.random().toString(36).slice(2, 6)
  const slug = `${slugBase}-bscp-${slugSuffix}`

  // ── 5. Upsert do produto no banco ────────────────────────────
  // Tenta buscar por EAN primeiro, depois por buscape_product_id, depois cria novo
  let productId: number | null = null
  let isNewProduct = false

  if (productEan) {
    const existing = await DB.prepare(`SELECT id FROM products WHERE ean = ? LIMIT 1`)
      .bind(productEan).first<{ id: number }>()
    if (existing) productId = existing.id
  }
  if (!productId && buscapeProductId) {
    const existing = await DB.prepare(`SELECT id FROM products WHERE buscape_product_id = ? LIMIT 1`)
      .bind(buscapeProductId).first<{ id: number }>()
    if (existing) productId = existing.id
  }

  // Menor preço das ofertas (para best_price)
  const prices = rawOffers.map((o: any) => {
    const p = typeof o.price === 'string'
      ? parseFloat(o.price.replace(/[^\d.,]/g, '').replace(',', '.'))
      : (typeof o.price === 'number' ? o.price : 0)
    return isNaN(p) ? 0 : p
  }).filter(p => p > 0)
  const bestPrice = prices.length > 0 ? Math.min(...prices) : null

  if (!productId) {
    // Insere novo produto
    isNewProduct = true
    const ins = await DB.prepare(`
      INSERT INTO products
        (name, slug, brand, description, image_url, ean, best_price, offer_count,
         is_active, buscape_product_id, buscape_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      productName, slug, productBrand || null, productDesc || null,
      productImage || null, productEan || null, bestPrice,
      buscapeProductId, url
    ).run()
    productId = ins.meta.last_row_id as number
  } else {
    // Atualiza produto existente
    await DB.prepare(`
      UPDATE products SET
        name = ?, brand = ?, image_url = COALESCE(NULLIF(?, ''), image_url),
        best_price = COALESCE(?, best_price),
        buscape_product_id = COALESCE(?, buscape_product_id),
        buscape_url = COALESCE(?, buscape_url),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      productName, productBrand || null, productImage || '',
      bestPrice, buscapeProductId, url, productId
    ).run()
  }

  // ── 6. Mapa de slugs de lojas do Buscapé → slug do banco ────
  // O Buscapé usa o nome da loja em texto livre — precisamos mapear para o slug
  const storeNameMap: Record<string, string> = {
    'casas bahia':    'casasbahia',
    'casasbahia':     'casasbahia',
    'magazine luiza': 'magalu',
    'magazineluiza':  'magalu',
    'magalu':         'magalu',
    'americanas':     'americanas',
    'amazon':         'amazon',
    'shopee':         'shopee',
    'ponto':          'ponto',
    'extra':          'extra',
    'fast shop':      'fastshop',
    'fastshop':       'fastshop',
    'submarino':      'submarino',
    'aliexpress':     'aliexpress',
    'kabum':          'kabum',
    'kabum!':         'kabum',
    'pichau':         'pichau',
    'terabyte':       'terabyte',
    'carrefour':      'carrefour',
    'samsung':        'samsung',
    'dell':           'dell',
    'lenovo':         'lenovo',
    'leroy merlin':   'leroy',
    'madeiramadeira': 'madeiramadeira',
    'tok&stok':       'tok_stok',
    'netshoes':       'netshoes',
    'dafiti':         'dafiti',
    'pontofrio':      'pontofrio',
    'ponto frio':     'pontofrio',
    'havan':          'havan',
    'centauro':       'centauro',
    'shein':          'shein',
  }

  // Busca todas as lojas do banco de uma vez (evita N queries)
  const { results: storesRows } = await DB.prepare(
    `SELECT id, slug, name, affiliate_network, affiliate_id FROM stores WHERE is_active = 1`
  ).all<{ id: number; slug: string; name: string; affiliate_network: string; affiliate_id: string | null }>()
  const storesBySlug = new Map(storesRows.map(s => [s.slug, s]))

  // Busca regras de afiliado do banco de uma vez
  const { results: rulesRows } = await DB.prepare(
    `SELECT network, publisher_id, extra_param, link_template FROM affiliate_rules WHERE is_active = 1`
  ).all<{ network: string; publisher_id: string | null; extra_param: string | null; link_template: string | null }>()
  const rulesByNetwork = new Map(rulesRows.map(r => [r.network, r]))

  // ── 7. Upsert de cada oferta ─────────────────────────────────
  let importedCount = 0
  let updatedCount = 0
  const resultOffers: any[] = []

  for (const raw of rawOffers) {
    // Extrai dados da oferta com suporte a formatos variados do JSON-LD
    const storeName: string = (
      typeof raw.offeredBy === 'string' ? raw.offeredBy
      : (raw.offeredBy as any)?.name ?? ''
    ).trim()
    const oid: string = (raw.id ?? '').toString().trim()

    // Parse de preço — Buscapé pode retornar string "261.98" ou número
    let price = 0
    if (typeof (raw as any).price === 'number') {
      price = (raw as any).price
    } else {
      const ps = String((raw as any).price ?? '').replace(/[^\d.,]/g, '').replace(',', '.')
      price = parseFloat(ps) || 0
    }

    if (!storeName || price <= 0) continue

    // Mapeia nome da loja → slug do banco
    const storeSlug = storeNameMap[storeName.toLowerCase()] ?? storeName.toLowerCase().replace(/\s+/g, '')
    const store = storesBySlug.get(storeSlug)
    if (!store) {
      resultOffers.push({ store: storeName, price, oid, status: 'store_not_found', slug_tried: storeSlug })
      continue
    }

    // OID é obrigatório para montar o link de redirect do Buscapé
    const buscapeRedirectUrl = oid
      ? `https://www.buscape.com.br/lead?oid=${oid}&channel=11`
      : (raw.url ?? '')

    // Gera affiliate_url para a rede desta loja
    // URL base = redirect do Buscapé (rastreia o clique)
    let affiliateUrl = buscapeRedirectUrl
    const rule = rulesByNetwork.get(store.affiliate_network)
    const pubId = store.affiliate_id || rule?.publisher_id || ''
    if (rule?.link_template && pubId) {
      affiliateUrl = rule.link_template
        .replace('{url}',   encodeURIComponent(buscapeRedirectUrl))
        .replace('{pub}',   pubId)
        .replace('{extra}', rule.extra_param ?? '')
    }
    // Fallback: se não tem template ou publisher_id, usa o redirect direto do Buscapé
    // (o Buscapé tem seu próprio programa de afiliado que é ativado pelo channel=11)

    // Título = nome do produto + " na " + loja
    const offerTitle = `${productName} na ${store.name}`
    const offerImage = (raw.image ?? productImage ?? '').toString()

    // UPSERT: (product_id, store_id, external_id) é UNIQUE
    // external_id = OID do Buscapé (único por oferta/loja)
    const externalId = oid || `buscape-${store.slug}-${productId}`

    const existing = await DB.prepare(`
      SELECT id FROM offers WHERE product_id = ? AND store_id = ? AND external_id = ?
    `).bind(productId, store.id, externalId).first<{ id: number }>()

    if (existing) {
      // Atualiza preço e affiliate_url
      await DB.prepare(`
        UPDATE offers SET
          price = ?, affiliate_url = ?, product_url = ?, image_url = COALESCE(NULLIF(?, ''), image_url),
          buscape_oid = ?, source = 'buscape',
          last_updated = CURRENT_TIMESTAMP, in_stock = 1, is_active = 1
        WHERE id = ?
      `).bind(price, affiliateUrl, buscapeRedirectUrl, offerImage, oid || null, existing.id).run()
      updatedCount++
      resultOffers.push({ store: store.name, price, oid, affiliate_url: affiliateUrl, status: 'updated' })
    } else {
      // Insere nova oferta
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, product_url, affiliate_url,
           image_url, buscape_oid, source, in_stock, is_active, last_updated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'buscape', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        productId, store.id, externalId, offerTitle, price,
        buscapeRedirectUrl, affiliateUrl, offerImage || null, oid || null
      ).run()
      importedCount++
      resultOffers.push({ store: store.name, price, oid, affiliate_url: affiliateUrl, status: 'imported' })
    }
  }

  // ── 8. Atualiza best_price e offer_count do produto ──────────
  await DB.prepare(`
    UPDATE products SET
      best_price   = (SELECT MIN(price) FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1),
      offer_count  = (SELECT COUNT(*) FROM offers WHERE product_id = ? AND is_active = 1),
      updated_at   = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(productId, productId, productId).run()

  // ── 9. Retorna resultado ─────────────────────────────────────
  const totalProcessed = importedCount + updatedCount
  return c.json({
    ok:           true,
    product_id:   productId,
    product_name: productName,
    product_brand: productBrand || null,
    is_new:       isNewProduct,
    buscape_product_id: buscapeProductId,
    imported:     importedCount,
    updated:      updatedCount,
    total:        totalProcessed,
    best_price:   bestPrice,
    offers:       resultOffers,
    tip: totalProcessed > 0
      ? `${importedCount} oferta(s) importada(s) e ${updatedCount} atualizada(s) com sucesso!`
      : 'Nenhuma oferta foi processada — verifique se as lojas estão cadastradas.',
  })
})

// ── POST /admin/api/affiliate-bot/refresh-buscape ────────────
// Reprocessa todos os produtos com buscape_url cadastrado (atualização diária)
// Chama import-buscape para cada um e retorna resumo
admin.post('/api/affiliate-bot/refresh-buscape', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({})) as any
  const limit = Math.min(parseInt(body.limit) || 5, 20)

  // Produtos com URL do Buscapé cadastrada — prioriza os mais antigos
  const { results: products } = await DB.prepare(`
    SELECT id, name, buscape_url FROM products
    WHERE is_active = 1 AND buscape_url IS NOT NULL AND buscape_url != ''
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(limit).all<{ id: number; name: string; buscape_url: string }>()

  if (products.length === 0) {
    return c.json({ ok: true, processed: 0, results: [], tip: 'Nenhum produto com URL do Buscapé cadastrada.' })
  }

  const results: any[] = []
  let totalImported = 0
  let totalUpdated  = 0
  let totalErrors   = 0

  for (const prod of products) {
    try {
      // Reutiliza o handler interno via fetch interno
      const selfUrl = new URL(c.req.url)
      selfUrl.pathname = '/admin/api/affiliate-bot/import-buscape'
      const token = c.req.header('Authorization') || ''

      const resp = await fetch(selfUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: JSON.stringify({ url: prod.buscape_url }),
        signal: AbortSignal.timeout(20000),
      })
      const data: any = await resp.json()
      totalImported += data.imported ?? 0
      totalUpdated  += data.updated  ?? 0
      results.push({ product: prod.name, imported: data.imported, updated: data.updated, ok: data.ok })
    } catch (e: any) {
      totalErrors++
      results.push({ product: prod.name, error: e?.message || 'timeout', ok: false })
    }
  }

  return c.json({
    ok:       true,
    processed: products.length,
    imported: totalImported,
    updated:  totalUpdated,
    errors:   totalErrors,
    results,
    has_more: products.length >= limit,
  })
})

// ============================================================
// LOMADEE — Integração API (136 lojas afiliadas com link automático)
// Base: https://api-beta.lomadee.com.br/affiliate
// Auth: x-api-key header
// ============================================================

const LOMADEE_BASE = 'https://api-beta.lomadee.com.br/affiliate'

// Helper: chama a API Lomadee com autenticação
async function lomadeeGet(path: string, apiKey: string): Promise<{ data: any; error: string | null }> {
  try {
    const r = await fetch(`${LOMADEE_BASE}${path}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(12000),
    })
    const json: any = await r.json()
    if (!r.ok) return { data: null, error: `Lomadee ${r.status}: ${json.message || json.error || r.statusText}` }
    return { data: json, error: null }
  } catch (e: any) {
    return { data: null, error: `Lomadee timeout/erro: ${e?.message || 'unknown'}` }
  }
}

// Helper: gera shortlink afiliado para uma URL + orgId
async function lomadeeShorten(orgId: string, url: string, apiKey: string): Promise<string | null> {
  try {
    const r = await fetch(`${LOMADEE_BASE}/shortener/url`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: orgId, type: 'Custom', url }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const json: any = await r.json()
    // Resposta: array de channels, cada um com shortUrls[]
    const channels = Array.isArray(json) ? json : (json.type ?? json.channels ?? [])
    for (const ch of channels) {
      const urls: string[] = ch.shortUrls ?? []
      if (urls.length > 0) return urls[0]
    }
    return null
  } catch { return null }
}

// ── GET /admin/api/lomadee/brands — Lista e sincroniza lojas ─
admin.get('/api/lomadee/brands', async (c) => {
  const { DB } = c.env
  const apiKey = (c.env as any).LOMADEE_API_KEY as string | undefined
  if (!apiKey) return c.json({ ok: false, error: 'LOMADEE_API_KEY não configurada' }, 400)

  const page  = parseInt(c.req.query('page')  || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 100)
  const sync  = c.req.query('sync') === '1'  // ?sync=1 → salva no banco

  const { data, error } = await lomadeeGet(`/brands?page=${page}&limit=${limit}`, apiKey)
  if (error || !data) return c.json({ ok: false, error }, 502)

  const brands: any[] = data.data ?? []
  const pagination = data.pagination ?? {}
  let synced = 0

  if (sync) {
    for (const b of brands) {
      const slug = 'lom-' + (b.slug || b.id).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40)
      const comm = b.commission?.value ?? 0

      // Upsert: insere se não existe (pelo lomadee_org_id), ou atualiza
      const existing = await DB.prepare(
        `SELECT id FROM stores WHERE lomadee_org_id = ? LIMIT 1`
      ).bind(b.id).first<{ id: number }>()

      if (existing) {
        await DB.prepare(`
          UPDATE stores SET name=?, logo_url=COALESCE(NULLIF(?,  ''), logo_url),
            commission_rate=?, lomadee_org_id=?, is_active=1 WHERE id=?
        `).bind(b.name, b.logo ?? '', comm, b.id, existing.id).run()
      } else {
        await DB.prepare(`
          INSERT OR IGNORE INTO stores
            (slug, name, logo_url, affiliate_network, deeplink_base, commission_rate, lomadee_org_id, is_active)
          VALUES (?, ?, ?, 'lomadee-api', ?, ?, ?, 1)
        `).bind(slug, b.name, b.logo ?? '', b.site ?? '', comm, b.id).run()
      }
      synced++
    }
  }

  // Enriquece com status "já no banco" para o frontend
  const orgIds = brands.map((b: any) => `'${b.id}'`).join(',')
  const inDb = orgIds.length > 0
    ? await DB.prepare(`SELECT lomadee_org_id FROM stores WHERE lomadee_org_id IN (${orgIds})`).all<any>()
    : { results: [] }
  const inDbSet = new Set((inDb.results ?? []).map((r: any) => r.lomadee_org_id))

  return c.json({
    ok: true,
    total: pagination.total ?? brands.length,
    page: pagination.page ?? page,
    totalPages: pagination.totalPages ?? 1,
    synced,
    brands: brands.map((b: any) => ({
      id:        b.id,
      name:      b.name,
      slug:      b.slug,
      logo:      b.logo,
      site:      b.site,
      segment:   b.segment,
      commission: b.commission?.value ?? 0,
      in_db:     inDbSet.has(b.id),
    })),
  })
})

// ── POST /admin/api/lomadee/sync-brands — Salva todas as lojas
// Usa batch INSERT via D1 batch() — uma transação para todas as lojas
// evita o timeout de 30s do Worker (antes: 136 queries sequenciais)
admin.post('/api/lomadee/sync-brands', async (c) => {
  const { DB } = c.env
  const apiKey = (c.env as any).LOMADEE_API_KEY as string | undefined
  if (!apiKey) return c.json({ ok: false, error: 'LOMADEE_API_KEY não configurada' }, 400)

  // Busca todas as páginas de marcas (paralelo: pg1 + pg2)
  const [p1, p2] = await Promise.all([
    lomadeeGet('/brands?page=1&limit=100', apiKey),
    lomadeeGet('/brands?page=2&limit=100', apiKey),
  ])

  const allBrands: any[] = [
    ...(p1.data?.data ?? []),
    ...(p2.data?.data ?? []),
  ]

  if (allBrands.length === 0) {
    return c.json({ ok: false, error: p1.error ?? 'Nenhuma marca retornada' }, 502)
  }

  // Monta statements D1 — INSERT ON CONFLICT para upsert eficiente
  // slug único = 'lom-' + primeiros 40 chars do slug da Lomadee
  const stmts = allBrands.map(b => {
    const slug = ('lom-' + (b.slug || b.id).replace(/[^a-z0-9-]/gi, '-').toLowerCase()).slice(0, 44)
    const comm = b.commission?.value ?? 0
    return DB.prepare(`
      INSERT INTO stores (slug, name, logo_url, affiliate_network, deeplink_base, commission_rate, lomadee_org_id, is_active)
      VALUES (?, ?, ?, 'lomadee-api', ?, ?, ?, 1)
      ON CONFLICT(slug) DO UPDATE SET
        name            = excluded.name,
        logo_url        = COALESCE(NULLIF(excluded.logo_url, ''), stores.logo_url),
        commission_rate = excluded.commission_rate,
        lomadee_org_id  = excluded.lomadee_org_id,
        is_active       = 1
    `).bind(slug, b.name, b.logo ?? '', b.site ?? '', comm, b.id)
  })

  // D1.batch() tem limite de 100 statements por chamada
  // Divide em chunks de 50 e executa em paralelo (2 batches para 136 marcas)
  const CHUNK = 50
  const chunks: typeof stmts[] = []
  for (let i = 0; i < stmts.length; i += CHUNK) chunks.push(stmts.slice(i, i + CHUNK))
  await Promise.all(chunks.map(chunk => DB.batch(chunk)))

  return c.json({ ok: true, synced: allBrands.length })
})

// ── POST /admin/api/lomadee/import — Busca e importa produtos ─
// Body: { search, org_id?, price_min?, price_max?, limit?, dry_run? }
admin.post('/api/lomadee/import', async (c) => {
  const { DB } = c.env
  const apiKey = (c.env as any).LOMADEE_API_KEY as string | undefined
  if (!apiKey) return c.json({ ok: false, error: 'LOMADEE_API_KEY não configurada' }, 400)

  const body    = await c.req.json().catch(() => ({})) as any
  const search  = (body.search  || '').trim()
  const orgId   = (body.org_id  || '').trim()
  const priceMin = body.price_min ? Math.round(body.price_min * 100) : null
  const priceMax = body.price_max ? Math.round(body.price_max * 100) : null
  const limit   = Math.min(parseInt(body.limit) || 20, 100)
  const dryRun  = !!body.dry_run

  if (!search && !orgId) {
    return c.json({ ok: false, error: 'Informe search (nome) ou org_id (loja)' }, 400)
  }

  // Monta query string
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('page',  '1')
  if (search) qs.set('search', search)
  if (orgId)  qs.set('organizationIds', orgId)
  if (priceMin !== null && priceMax !== null) qs.set('price', `${priceMin}:${priceMax}`)

  const { data, error } = await lomadeeGet(`/products?${qs}`, apiKey)
  if (error || !data) return c.json({ ok: false, error }, 502)

  const products: any[] = data.data ?? []
  if (products.length === 0) {
    return c.json({ ok: true, imported: 0, updated: 0, total: 0, products: [],
      tip: 'Nenhum produto encontrado. Tente um termo diferente.' })
  }

  // Busca mapa de stores lomadee no banco de uma vez
  const { results: storesRows } = await DB.prepare(
    `SELECT id, slug, name, lomadee_org_id FROM stores WHERE lomadee_org_id IS NOT NULL AND is_active = 1`
  ).all<{ id: number; slug: string; name: string; lomadee_org_id: string }>()
  const storeByOrgId = new Map(storesRows.map(s => [s.lomadee_org_id, s]))

  let imported = 0, updated = 0
  const resultItems: any[] = []

  for (const prod of products) {
    const orgIdProd = prod.organizationId as string
    const store = storeByOrgId.get(orgIdProd)

    // Pega a primeira opção (variante) com preço disponível
    const option = (prod.options ?? []).find((o: any) =>
      o.available && (o.pricing?.[0]?.price ?? 0) > 0
    ) ?? prod.options?.[0]

    if (!option) {
      resultItems.push({ name: prod.name, status: 'no_option', store: store?.name ?? orgIdProd })
      continue
    }

    const priceCents  = option.pricing?.[0]?.price ?? 0
    const listCents   = option.pricing?.[0]?.listPrice ?? priceCents
    const price       = priceCents / 100
    const listPrice   = listCents  / 100
    const ean         = option.ean ?? ''
    const inStock     = (option.stocks?.[0]?.value ?? 0) > 0 || option.available === true
    const imageUrl    = option.images?.[0]?.url ?? prod.images?.[0]?.url ?? ''
    const productUrl  = prod.url ?? ''
    const externalId  = option.id ?? prod.id

    if (price <= 0) {
      resultItems.push({ name: prod.name, status: 'price_zero', store: store?.name ?? orgIdProd })
      continue
    }

    // Gera link afiliado via Lomadee shortener
    let affiliateUrl = productUrl
    if (!dryRun && productUrl) {
      const short = await lomadeeShorten(orgIdProd, productUrl, apiKey)
      if (short) affiliateUrl = short
    }

    if (dryRun) {
      resultItems.push({
        name: prod.name.slice(0, 60), ean, price,
        store: store?.name ?? `org:${orgIdProd.slice(0,8)}`,
        affiliate_url: affiliateUrl, status: 'dry_run',
      })
      continue
    }

    if (!store) {
      resultItems.push({ name: prod.name.slice(0,50), status: 'store_not_synced', org_id: orgIdProd })
      continue
    }

    // Upsert produto por EAN (se disponível) ou pelo lomadee product id
    let productId: number | null = null
    let isNew = false

    if (ean) {
      const ex = await DB.prepare(`SELECT id FROM products WHERE ean=? LIMIT 1`).bind(ean).first<{id:number}>()
      if (ex) productId = ex.id
    }
    if (!productId) {
      // Tenta pelo external_id + store_id na tabela offers
      const ex = await DB.prepare(
        `SELECT p.id FROM products p JOIN offers o ON o.product_id=p.id WHERE o.lomadee_id=? LIMIT 1`
      ).bind(externalId).first<{id:number}>()
      if (ex) productId = ex.id
    }

    const slugBase = prod.name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)
    const slugSuffix = Math.random().toString(36).slice(2,6)

    if (!productId) {
      isNew = true
      const ins = await DB.prepare(`
        INSERT INTO products
          (name, slug, brand, image_url, ean, best_price, offer_count, is_active, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(prod.name, `${slugBase}-lom-${slugSuffix}`, imageUrl, ean || null, price).run()
      productId = ins.meta.last_row_id as number
    } else {
      await DB.prepare(`
        UPDATE products SET
          name=?, image_url=COALESCE(NULLIF(?,  ''), image_url),
          best_price=COALESCE(?,best_price), updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(prod.name, imageUrl, price, productId).run()
    }

    // Upsert oferta
    const existOffer = await DB.prepare(
      `SELECT id FROM offers WHERE product_id=? AND store_id=? AND external_id=? LIMIT 1`
    ).bind(productId, store.id, externalId).first<{id:number}>()

    if (existOffer) {
      await DB.prepare(`
        UPDATE offers SET price=?, affiliate_url=?, product_url=?,
          image_url=COALESCE(NULLIF(?,  ''), image_url),
          in_stock=?, lomadee_id=?, source='lomadee',
          last_updated=CURRENT_TIMESTAMP, is_active=1
        WHERE id=?
      `).bind(price, affiliateUrl, productUrl, imageUrl, inStock?1:0, externalId, existOffer.id).run()
      updated++
      resultItems.push({ name: prod.name.slice(0,50), price, store: store.name,
        affiliate_url: affiliateUrl, status:'updated' })
    } else {
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, original_price,
           product_url, affiliate_url, image_url, in_stock,
           lomadee_id, source, is_active, last_updated, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'lomadee',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `).bind(productId, store.id, externalId, prod.name, price, listPrice,
              productUrl, affiliateUrl, imageUrl, inStock?1:0, externalId).run()
      imported++
      resultItems.push({ name: prod.name.slice(0,50), price, store: store.name,
        affiliate_url: affiliateUrl, status: isNew ? 'new_product' : 'new_offer' })
    }

    // Atualiza best_price do produto
    await DB.prepare(`
      UPDATE products SET
        best_price=(SELECT MIN(price) FROM offers WHERE product_id=? AND is_active=1 AND in_stock=1),
        offer_count=(SELECT COUNT(*) FROM offers WHERE product_id=? AND is_active=1),
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(productId, productId, productId).run()
  }

  return c.json({
    ok: true, imported, updated, dry_run: dryRun,
    total: imported + updated,
    api_total: data.meta?.total ?? products.length,
    products: resultItems,
    tip: dryRun
      ? `Simulação: ${resultItems.length} produto(s) encontrado(s) — rode sem dry_run para importar`
      : `${imported} importado(s) · ${updated} atualizado(s) com link afiliado Lomadee`,
  })
})

// ── GET /admin/api/lomadee/status — Verifica chave + stats ───
admin.get('/api/lomadee/status', async (c) => {
  const { DB } = c.env
  const apiKey = (c.env as any).LOMADEE_API_KEY as string | undefined
  if (!apiKey) return c.json({ ok: false, configured: false, error: 'LOMADEE_API_KEY não configurada' })

  const { data, error } = await lomadeeGet('/brands?limit=1', apiKey)
  if (error) return c.json({ ok: false, configured: true, error })

  const [lomStores, lomOffers] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as n FROM stores WHERE affiliate_network='lomadee-api'`).first<{n:number}>(),
    DB.prepare(`SELECT COUNT(*) as n FROM offers WHERE source='lomadee'`).first<{n:number}>(),
  ])

  return c.json({
    ok: true,
    configured: true,
    api_total_brands: data.pagination?.total ?? '?',
    db_stores_synced: lomStores?.n ?? 0,
    db_offers_imported: lomOffers?.n ?? 0,
  })
})

// ============================================================
// AFFILIATE RULES — Códigos de afiliado por rede
// ============================================================

// ── GET /admin/api/affiliate-rules ───────────────────────────
admin.get('/api/affiliate-rules', async (c) => {
  const { DB } = c.env

  const rules = await DB.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM stores s WHERE s.affiliate_network = r.network AND s.is_active = 1) AS store_count,
      (SELECT COUNT(*) FROM products p
         JOIN stores s ON s.id = p.best_store_id
         WHERE s.affiliate_network = r.network AND p.affiliate_url IS NOT NULL AND p.affiliate_url != '') AS linked_products,
      (SELECT COUNT(*) FROM products p
         JOIN stores s ON s.id = p.best_store_id
         WHERE s.affiliate_network = r.network) AS total_products
    FROM affiliate_rules r
    ORDER BY r.label
  `).all<any>()

  const mlLinked = await DB.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE affiliate_url IS NOT NULL AND affiliate_url != ''
      AND (ml_item_id IS NOT NULL OR best_store_id = (SELECT id FROM stores WHERE slug='mercadolivre' LIMIT 1))
  `).first<{ n: number }>()

  return c.json({ ok: true, rules: rules.results, ml_linked: mlLinked?.n ?? 0 })
})

// ── GET /admin/api/affiliate-rules/stats ─────────────────────
admin.get('/api/affiliate-rules/stats', async (c) => {
  const { DB } = c.env

  const [total, withAff, withMlId, rules] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as n FROM products WHERE is_active=1`).first<{ n: number }>(),
    DB.prepare(`SELECT COUNT(*) as n FROM products WHERE is_active=1 AND affiliate_url IS NOT NULL AND affiliate_url != ''`).first<{ n: number }>(),
    DB.prepare(`SELECT COUNT(*) as n FROM products WHERE ml_item_id IS NOT NULL AND ml_item_id != ''`).first<{ n: number }>(),
    DB.prepare(`SELECT network, label, publisher_id FROM affiliate_rules WHERE is_active=1 ORDER BY label`).all<any>(),
  ])

  return c.json({
    ok: true,
    total: total?.n ?? 0,
    with_affiliate: withAff?.n ?? 0,
    with_ml_id: withMlId?.n ?? 0,
    pending: (total?.n ?? 0) - (withAff?.n ?? 0),
    rules: rules.results ?? [],
  })
})

// ── PUT /admin/api/affiliate-rules/:network ──────────────────
admin.put('/api/affiliate-rules/:network', async (c) => {
  const { DB } = c.env
  const network = c.req.param('network')
  const body: any = await c.req.json().catch(() => ({}))
  const { publisher_id, extra_param, link_template, label } = body

  if (!publisher_id && publisher_id !== '') {
    return c.json({ error: 'publisher_id obrigatório' }, 400)
  }

  await DB.prepare(`
    UPDATE affiliate_rules
    SET publisher_id = ?, extra_param = COALESCE(?, extra_param),
        link_template = COALESCE(NULLIF(?, ''), link_template),
        label = COALESCE(NULLIF(?, ''), label),
        updated_at = CURRENT_TIMESTAMP
    WHERE network = ?
  `).bind(publisher_id || null, extra_param ?? null, link_template ?? '', label ?? '', network).run()

  return c.json({ ok: true, network, publisher_id })
})

// ── POST /admin/api/affiliate-rules/generate ─────────────────
admin.post('/api/affiliate-rules/generate', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const targetNetwork: string = (body.network || '').trim()
  const dryRun = !!body.dry_run

  const rulesRes = await DB.prepare(`
    SELECT * FROM affiliate_rules
    WHERE is_active = 1 AND publisher_id IS NOT NULL AND publisher_id != ''
    ${targetNetwork ? "AND network = '" + targetNetwork.replace(/'/g, "''") + "'" : ''}
  `).all<any>()

  const rules: any[] = rulesRes.results ?? []
  if (rules.length === 0) {
    return c.json({ ok: false, error: 'Nenhuma regra ativa com publisher_id para processar', network: targetNetwork }, 404)
  }

  function buildAffLink(template: string, url: string, pub: string, extra: string | null): string {
    let link = template.replace('{url}', url).replace('{pub}', pub).replace('{extra}', extra || '')
    link = link.replace(/[?&]{2,}/g, '&').replace(/[?&]$/, '')
    return link
  }

  const summary: Record<string, { updated: number; skipped: number; network: string; label: string }> = {}
  let totalUpdated = 0

  for (const rule of rules) {
    const ruleStats = { updated: 0, skipped: 0, network: rule.network, label: rule.label }
    summary[rule.network] = ruleStats

    if (rule.network === 'meli-api') {
      const mlProds = await DB.prepare(`
        SELECT p.id, p.ml_item_id, p.affiliate_url, o.product_url
        FROM products p
        LEFT JOIN offers o ON o.product_id = p.id
          AND o.store_id = (SELECT id FROM stores WHERE slug='mercadolivre' LIMIT 1)
        WHERE p.ml_item_id IS NOT NULL AND p.ml_item_id != ''
        GROUP BY p.id
      `).all<any>()

      for (const prod of mlProds.results ?? []) {
        let baseUrl = (prod.product_url || prod.affiliate_url || '').split('?')[0].split('#')[0]
        if (!baseUrl || !baseUrl.startsWith('http')) {
          baseUrl = `https://www.mercadolivre.com.br/p/${prod.ml_item_id.toLowerCase()}`
        }
        const newUrl = buildAffLink(rule.link_template, baseUrl, rule.publisher_id, rule.extra_param)
        if (!dryRun) {
          await DB.prepare(`UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(newUrl, prod.id).run()
          await DB.prepare(`UPDATE offers SET affiliate_url = ? WHERE product_id = ? AND store_id = (SELECT id FROM stores WHERE slug='mercadolivre' LIMIT 1)`).bind(newUrl, prod.id).run()
        }
        ruleStats.updated++; totalUpdated++
      }
      continue
    }

    const storesRes = await DB.prepare(`SELECT id FROM stores WHERE affiliate_network = ? AND is_active = 1`).bind(rule.network).all<{ id: number }>()
    const storeIds = (storesRes.results ?? []).map((s) => s.id)
    if (storeIds.length === 0) { ruleStats.skipped++; continue }

    const placeholders = storeIds.map(() => '?').join(',')
    const prodsRes = await DB.prepare(`
      SELECT p.id, o.product_url, o.affiliate_url AS offer_aff_url
      FROM products p
      JOIN offers o ON o.product_id = p.id AND o.store_id IN (${placeholders})
      WHERE p.is_active = 1
      GROUP BY p.id
    `).bind(...storeIds).all<any>()

    for (const prod of prodsRes.results ?? []) {
      let baseUrl = (prod.product_url || prod.offer_aff_url || '').split('?')[0].split('#')[0]
      if (!baseUrl || !baseUrl.startsWith('http')) { ruleStats.skipped++; continue }
      const newUrl = buildAffLink(rule.link_template, baseUrl, rule.publisher_id, rule.extra_param)
      if (!dryRun) {
        await DB.prepare(`UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(newUrl, prod.id).run()
      }
      ruleStats.updated++; totalUpdated++
    }
  }

  return c.json({
    ok: true, dry_run: dryRun, total_updated: totalUpdated, summary,
    tip: dryRun ? 'dry_run=true — nada foi salvo.' : `${totalUpdated} link(s) regenerado(s) com sucesso!`,
  })
})

//
admin.get('/api/ml-linkbuilder/status', async (c) => {
  const { DB } = c.env
  const CACHE = c.env.CACHE as KVNamespace | undefined

  // Status OAuth (tokens salvos manualmente via PKCE)
  const accessToken  = await CACHE?.get('ml_access_token').catch(() => null)
  const refreshToken = await CACHE?.get('ml_refresh_token').catch(() => null)
  const userId       = await CACHE?.get('ml_user_id').catch(() => null)
  const tokenSource  = await CACHE?.get('ml_token_source').catch(() => null)

  // ── Resolve token_source e auto_connected ──────────────────
  // Prioridade: KV cache → refresh_token → client_credentials
  const appId  = (c.env as any).ML_APP_ID || '3098423019766450'
  const secret = (c.env as any).ML_SECRET  || ''
  let autoConnected = false
  let resolvedTokenSource: string = tokenSource || 'none'

  if (accessToken) {
    // Temos access_token no KV — origem já registrada em ml_token_source
    resolvedTokenSource = tokenSource || 'oauth'
    autoConnected       = tokenSource === 'client_credentials'
  } else if (refreshToken) {
    // Temos refresh_token OAuth — conexão via OAuth (usuário autorizou)
    resolvedTokenSource = 'refresh'
    autoConnected       = false
  } else if (secret) {
    // Sem token no KV → tenta client_credentials agora
    try {
      const res = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     appId,
          client_secret: secret,
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const td: any = await res.json()
        if (td.access_token) {
          autoConnected       = true
          resolvedTokenSource = 'client_credentials'
          if (CACHE) {
            await CACHE.put('ml_access_token', td.access_token, { expirationTtl: td.expires_in || 21600 }).catch(() => {})
            await CACHE.put('ml_token_source',  'client_credentials', { expirationTtl: td.expires_in || 21600 }).catch(() => {})
          }
        }
      }
    } catch { /* sem auto-connect */ }
  }

  const isConnected = !!accessToken || !!refreshToken || autoConnected

  // ── Contadores ──────────────────────────────────────────────
  const [total, withAff, withMlId, withMeliLa] = await Promise.all([
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1").first<any>(),
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1 AND affiliate_url IS NOT NULL AND affiliate_url != ''").first<any>(),
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1 AND ml_item_id IS NOT NULL AND ml_item_id != ''").first<any>(),
    DB.prepare("SELECT COUNT(*) as n FROM products WHERE is_active = 1 AND affiliate_url LIKE '%matt_word%'").first<any>(),
  ])

  const withMlIdN   = withMlId?.n   || 0
  const withMeliLaN = withMeliLa?.n || 0
  // pending: produtos com ml_item_id que ainda não têm link afiliado rastreável
  // Nunca negativo — produtos com affiliate_url mas sem ml_item_id não são "pendentes"
  const pending = Math.max(0, withMlIdN - withMeliLaN)

  return c.json({
    oauth: {
      connected:      isConnected,
      has_access:     !!accessToken || autoConnected,
      has_refresh:    !!refreshToken,
      user_id:        userId,
      auth_url:       '/api/ml/auth',
      token_source:   resolvedTokenSource,
      auto_connected: autoConnected,
    },
    products: {
      total:          total?.n  || 0,
      with_ml_id:     withMlIdN,
      with_affiliate: withAff?.n || 0,
      with_tracking:  withMeliLaN,
      pending,
    },
  })
})

// GET /admin/api/ml-linkbuilder/products
admin.get('/api/ml-linkbuilder/products', async (c) => {
  const { DB } = c.env
  const filter  = c.req.query('filter') || 'missing'
  const page    = Math.max(1, parseInt(c.req.query('page') || '1'))
  const perPage = 30
  const offset  = (page - 1) * perPage

  let where = "WHERE p.is_active = 1 AND p.ml_item_id IS NOT NULL AND p.ml_item_id != ''"
  if (filter === 'missing') where += " AND (p.affiliate_url IS NULL OR p.affiliate_url = '' OR p.affiliate_url NOT LIKE '%matt_word%')"
  if (filter === 'done')    where += " AND p.affiliate_url LIKE '%matt_word%'"

  const { results } = await DB.prepare(`
    SELECT p.id, p.name, p.ml_item_id, p.affiliate_url, p.best_price, p.category, p.image_url
    FROM products p ${where}
    ORDER BY p.id ASC LIMIT ? OFFSET ?
  `).bind(perPage, offset).all<any>()

  const count = await DB.prepare(`SELECT COUNT(*) as n FROM products p ${where}`).first<any>()

  const products = results.map((p: any) => ({
    ...p,
    ml_url: `https://produto.mercadolivre.com.br/${p.ml_item_id.replace('MLB', 'MLB-')}`,
  }))

  return c.json({ results: products, total: count?.n || 0, page, per_page: perPage })
})

// POST /admin/api/ml-linkbuilder/generate-all
// Geração server-side em lote: busca permalink via /items/{id} → monta link afiliado → salva
// Processa até `limit` produtos por chamada (evita timeout do Worker)
admin.post('/api/ml-linkbuilder/generate-all', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const limit  = Math.min(parseInt(body.limit  || '30'), 50)
  const offset = Math.max(parseInt(body.offset || '0'),  0)

  const token = await getLBToken(c.env)
  if (!token) {
    return c.json({ ok: false, error: 'Sem token OAuth ML. Conecte via "Login no ML" primeiro.' }, 401)
  }

  // Busca produtos sem affiliate_url rastreável
  const { results: products } = await DB.prepare(`
    SELECT id, name, ml_item_id, affiliate_url
    FROM products
    WHERE is_active = 1
      AND ml_item_id IS NOT NULL AND ml_item_id != ''
      AND (affiliate_url IS NULL OR affiliate_url = '' OR affiliate_url NOT LIKE '%matt_word%')
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<any>()

  if (!products.length) {
    return c.json({ ok: true, processed: 0, saved: 0, errors: 0, done: true })
  }

  let saved = 0, errors = 0
  const log: string[] = []

  for (const p of products) {
    const mlId = p.ml_item_id as string
    try {
      // Tenta /products/{id}/items primeiro (catalog ID — funciona de IPs externos)
      const isShort = mlId.replace('MLB', '').length <= 8
      let permalink: string | null = null

      if (isShort) {
        const r = await fetch(`${LB_ML_API}/products/${mlId}/items?limit=1`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        })
        if (r.ok) {
          const d: any = await r.json()
          const item = (d.results || [])[0]
          permalink = item?.permalink || null
        }
      }

      // Fallback: /items/{id} direto
      if (!permalink) {
        const r = await fetch(`${LB_ML_API}/items/${mlId}?attributes=id,permalink,price`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        })
        if (r.ok) {
          const d: any = await r.json()
          permalink = d?.permalink || null
        }
      }

      if (permalink) {
        const affUrl = buildMLAffUrl(permalink)
        await DB.prepare(`
          UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(affUrl, p.id).run()
        saved++
        log.push(`✅ ${mlId} → ${affUrl.substring(0, 80)}`)
      } else {
        errors++
        log.push(`⚠️ ${mlId} → permalink não encontrado`)
      }
    } catch (e: any) {
      errors++
      log.push(`❌ ${mlId} → ${e.message || 'erro'}`)
    }
  }

  // Verifica se ainda há pendentes
  const remaining = await DB.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE is_active = 1 AND ml_item_id IS NOT NULL AND ml_item_id != ''
      AND (affiliate_url IS NULL OR affiliate_url = '' OR affiliate_url NOT LIKE '%matt_word%')
  `).first<any>()

  return c.json({
    ok: true,
    processed: products.length,
    saved,
    errors,
    done: (remaining?.n || 0) === 0,
    remaining: remaining?.n || 0,
    next_offset: offset + limit,
    log: log.slice(0, 30),
  })
})

// ══════════════════════════════════════════════════════════
// ROADMAP API ML — Sync Categorias + Importação por Categoria
// ══════════════════════════════════════════════════════════

// POST /admin/api/ml/sync-categories
// Busca /sites/MLB/categories → popula tabela categories do D1
admin.post('/api/ml/sync-categories', async (c) => {
  const { DB, CACHE } = c.env
  const ML_API       = 'https://api.mercadolibre.com'
  const token        = await getLBToken(c.env)
  const headers: Record<string, string> = {
    'Accept': 'application/json', 'User-Agent': 'KainowRadar/1.0',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const res = await fetch(`${ML_API}/sites/MLB/categories`, { headers })
    if (!res.ok) return c.json({ error: `ML API HTTP ${res.status}` }, res.status as any)
    const mlCats: any[] = await res.json()

    const CAT_ICONS: Record<string, string> = {
      MLB5672:'📱', MLB1051:'📱', MLB1648:'💻', MLB1000:'📺',
      MLB1144:'🎮', MLB1003:'🎵', MLB1008:'📷', MLB1574:'🏠',
      MLB1009:'📟', MLB1649:'🖥️', MLB1430:'👗', MLB1499:'🏋️',
      MLB1500:'🐾', MLB218519:'🧴', MLB1132:'🚗', MLB1459:'🧸',
      MLB1540:'🔧', MLB86:'🏡', MLB1276:'📚', MLB1367:'⚽',
      MLB407134:'🍔', MLB3937:'🎵', MLB1953:'✈️', MLB4357:'💊',
      MLB3633:'🎨', MLB1743:'💼',
    }

    function slugify(text: string): string {
      return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').substring(0, 80)
    }

    let upserted = 0, skipped = 0
    for (const cat of mlCats) {
      const slug = slugify(cat.name)
      const icon = CAT_ICONS[cat.id] || '🛍️'
      try {
        // Tenta INSERT; em conflito de slug faz UPDATE
        const r = await DB.prepare(`
          INSERT INTO categories (name, slug, icon, ml_category_id, is_active, product_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(slug) DO UPDATE SET
            name = excluded.name,
            icon = excluded.icon,
            ml_category_id = excluded.ml_category_id,
            updated_at = CURRENT_TIMESTAMP
        `).bind(cat.name, slug, icon, cat.id).run()
        upserted++
      } catch {
        // Tenta upsert por ml_category_id
        try {
          await DB.prepare(`
            UPDATE categories SET name=?, icon=?, updated_at=CURRENT_TIMESTAMP
            WHERE ml_category_id=?
          `).bind(cat.name, icon, cat.id).run()
          upserted++
        } catch { skipped++ }
      }
    }

    // Invalida cache de categorias no KV
    if (CACHE) {
      await CACHE.delete('ml_categories_tree').catch(() => {})
    }

    return c.json({
      ok: true, total: mlCats.length, upserted, skipped,
      message: `${upserted} categorias sincronizadas com sucesso`,
      categories: mlCats.map(c => ({ id: c.id, name: c.name })),
    })
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro ao sincronizar' }, 500)
  }
})

// GET /admin/api/ml/sync-categories — Visualiza status atual das categorias
admin.get('/api/ml/sync-categories', async (c) => {
  const { DB } = c.env
  try {
    const { results } = await DB.prepare(`
      SELECT id, name, slug, icon, ml_category_id, product_count, is_active, updated_at
      FROM categories ORDER BY name ASC LIMIT 100
    `).all()
    const total = results.length
    const withMlId  = results.filter((r: any) => r.ml_category_id).length
    const withProds = results.filter((r: any) => (r as any).product_count > 0).length
    return c.json({ total, with_ml_id: withMlId, with_products: withProds, categories: results })
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro ao listar categorias' }, 500)
  }
})

// POST /admin/api/ml/import-by-category — Importa produtos de uma categoria via /sites/MLB/search
// Body: { category_id: "MLB1051", slug: "smartphones", limit: 50, offset: 0 }
admin.post('/api/ml/import-by-category', async (c) => {
  const { DB, CACHE }  = c.env
  const ML_API         = 'https://api.mercadolibre.com'
  const PUBLISHER_ID   = 'cfegdhabc31955'
  const MATT_TOOL      = '61674414'

  const body = await c.req.json().catch(() => ({}) as any)
  const categoryId: string = body.category_id || ''
  const categorySlug: string = body.slug || 'outros'
  const limit    = Math.min(50, parseInt(body.limit || '50'))
  const offset   = Math.max(0, parseInt(body.offset || '0'))
  const saveDb   = body.save !== false // padrão: salva no banco

  if (!categoryId) return c.json({ error: 'category_id obrigatório (ex: MLB1051)' }, 400)

  const token = await getLBToken(c.env)
  if (!token) return c.json({ error: 'Token ML não disponível' }, 503)

  try {
    const params = new URLSearchParams({
      category: categoryId,
      limit:    String(limit),
      offset:   String(offset),
      sort:     'relevance',
    })

    const res = await fetch(`${ML_API}/sites/MLB/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'KainowRadar/1.0',
      },
    })

    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      return c.json({ error: `ML API HTTP ${res.status}: ${err.message || err.error || ''}` }, res.status as any)
    }

    const data: any = await res.json()
    const items: any[] = data.results || []

    if (!saveDb) {
      // Preview sem salvar
      return c.json({
        ok: true, preview: true,
        total: data.paging?.total || items.length,
        count: items.length,
        items: items.slice(0, 10).map((item: any) => ({
          id: item.id, title: item.title?.slice(0, 80),
          price: item.price, thumbnail: item.thumbnail,
        })),
      })
    }

    let created = 0, updated = 0, skipped = 0
    const details: any[] = []

    for (const item of items) {
      if (!item.id || !item.title) { skipped++; continue }

      const mlId     = item.id
      const name     = item.title.trim()
      const price    = item.price || 0
      const image    = (item.thumbnail || '').replace('-I.jpg', '-O.jpg')
      const permalink = item.permalink || `https://www.mercadolivre.com.br/p/${mlId}`
      const affUrl   = `${permalink.split('?')[0]}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

      const existing = await DB.prepare('SELECT id FROM products WHERE ml_item_id = ?').bind(mlId).first<any>()

      if (existing) {
        await DB.prepare(`
          UPDATE products
          SET best_price=?, affiliate_url=?, image_url=COALESCE(NULLIF(?,''), image_url),
              affiliate_updated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE ml_item_id=?
        `).bind(price, affUrl, image, mlId).run()
        updated++
        details.push({ ml_id: mlId, action: 'updated', name: name.slice(0, 60) })
      } else {
        // Slug único
        function slugifyLocal(text: string): string {
          return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').substring(0, 80)
        }
        const rawSlug = slugifyLocal(name)
        const slugExists = await DB.prepare('SELECT id FROM products WHERE slug=?').bind(rawSlug).first()
        const finalSlug  = slugExists ? `${rawSlug}-${mlId.toLowerCase()}` : rawSlug

        try {
          const ins = await DB.prepare(`
            INSERT INTO products
              (name, slug, ml_item_id, affiliate_url, affiliate_updated_at,
               image_url, best_price, offer_count, is_active, source, category,
               description, created_at, updated_at)
            VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,1,1,'mercadolivre',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          `).bind(
            name, finalSlug, mlId, affUrl, image || null, price,
            categorySlug,
            `${name}. Encontrado no Mercado Livre.`,
          ).run()

          const newId = ins.meta?.last_row_id as number

          // Offer placeholder
          await DB.prepare(`
            INSERT INTO offers (product_id, store_id, external_id, title, price, affiliate_url, is_active, in_stock, source, last_updated)
            VALUES (?,3,?,?,?,?,1,1,'mercadolivre',CURRENT_TIMESTAMP)
          `).bind(newId, mlId, name, price, affUrl).run()

          await DB.prepare('UPDATE products SET offer_count=1, best_store_id=3 WHERE id=?').bind(newId).run()

          created++
          details.push({ ml_id: mlId, action: 'created', name: name.slice(0, 60), id: newId })
        } catch (e: any) {
          skipped++
        }
      }

      await new Promise(r => setTimeout(r, 20)) // rate limit gentil
    }

    // Recalcula product_count na categoria
    await DB.prepare(`
      UPDATE categories SET
        product_count = (SELECT COUNT(*) FROM products WHERE category=? AND is_active=1),
        updated_at = CURRENT_TIMESTAMP
      WHERE slug=?
    `).bind(categorySlug, categorySlug).run().catch(() => {})

    return c.json({
      ok: true, created, updated, skipped,
      total_from_ml: data.paging?.total || items.length,
      fetched: items.length,
      message: `${created} criados, ${updated} atualizados, ${skipped} ignorados`,
      details: details.slice(0, 20),
    })
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro interno' }, 500)
  }
})

// ══════════════════════════════════════════════════════════
// CRAWLER EM MASSA — paginação automática por categoria
// POST /admin/api/ml/crawl-category
// Body: {
//   category_id: "MLB1051",   — ID da categoria ML (obrigatório)
//   slug: "smartphones",      — slug para salvar no D1 (obrigatório)
//   max_items: 200,           — limite total (padrão 200, máx 1000)
//   sort: "relevance",        — relevance | price_asc | price_desc | sold_quantity
//   dry_run: false            — se true, só conta sem salvar
// }
// Retorna: { ok, total_available, fetched, created, updated, skipped, pages, duration_ms }
// ══════════════════════════════════════════════════════════
admin.post('/api/ml/crawl-category', async (c) => {
  const { DB, CACHE } = c.env
  const ML_API_URL    = 'https://api.mercadolibre.com'
  const PUB_ID        = 'cfegdhabc31955'
  const M_TOOL        = '61674414'
  const LIMIT         = 50  // máximo permitido pela API ML

  const body = await c.req.json().catch(() => ({}) as any)
  const categoryId: string   = (body.category_id || '').trim()
  const categorySlug: string = (body.slug || 'outros').trim()
  const maxItems: number     = Math.min(1000, Math.max(1, parseInt(body.max_items || '200')))
  const sortParam: string    = body.sort || 'relevance'
  const dryRun: boolean      = body.dry_run === true

  if (!categoryId) {
    return c.json({ error: 'category_id obrigatório (ex: MLB1051)' }, 400)
  }

  // Mapeia parâmetro sort → string aceita pela ML API
  const sortMap: Record<string, string> = {
    relevance:   'relevance',
    price_asc:   'price_asc',
    price_desc:  'price_desc',
    sales_high:  'sold_quantity',
    sold_quantity: 'sold_quantity',
  }
  const mlSort = sortMap[sortParam] || 'relevance'

  const token = await getLBToken(c.env)
  if (!token) {
    return c.json({
      error: 'Token ML não disponível — acesse /api/ml/auth para autenticar',
    }, 503)
  }

  const startTime = Date.now()
  let totalAvailable = 0
  let fetched  = 0
  let created  = 0
  let updated  = 0
  let skipped  = 0
  let pages    = 0
  const errors: string[] = []

  // Helper inline: slugify
  function _slug(text: string): string {
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').trim()
      .replace(/\s+/g, '-').substring(0, 80)
  }

  // ── Loop de paginação ─────────────────────────────────
  for (let offset = 0; offset < maxItems; offset += LIMIT) {
    const pageLimit = Math.min(LIMIT, maxItems - offset)

    const params = new URLSearchParams({
      category: categoryId,
      limit:    String(pageLimit),
      offset:   String(offset),
      sort:     mlSort,
    })

    let res: Response
    try {
      res = await fetch(`${ML_API_URL}/sites/MLB/search?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json',
          'User-Agent':    'KainowRadar/1.0',
        },
      })
    } catch (e: any) {
      errors.push(`offset ${offset}: fetch error — ${e.message}`)
      break
    }

    if (!res.ok) {
      const errBody: any = await res.json().catch(() => ({}))
      const msg = errBody.message || errBody.error || `HTTP ${res.status}`
      // 403 = app em modo test → para o loop mas retorna o que já foi coletado
      if (res.status === 403) {
        errors.push(`403 — app em modo test: ${msg}`)
        break
      }
      errors.push(`offset ${offset}: ${msg}`)
      break
    }

    const data: any = await res.json()
    const items: any[] = data.results || []
    pages++

    // Captura total disponível na primeira página
    if (offset === 0) {
      totalAvailable = data.paging?.total || items.length
    }

    // Sem resultados → fim da paginação
    if (!items.length) break

    fetched += items.length

    // ── Salva no D1 ─────────────────────────────────────
    if (!dryRun) {
      for (const item of items) {
        if (!item.id || !item.title) { skipped++; continue }

        const mlId      = item.id as string
        const name      = (item.title as string).trim()
        const price     = (item.price as number) || 0
        const image     = ((item.thumbnail as string) || '').replace('-I.jpg', '-O.jpg')
        const permalink = (item.permalink as string) || `https://www.mercadolivre.com.br/p/${mlId}`
        const affUrl    = `${permalink.split('?')[0]}?matt_word=${PUB_ID}&matt_tool=${M_TOOL}&forceInApp=true`
        const discountPct = item.original_price
          ? Math.round((1 - price / item.original_price) * 100)
          : 0

        try {
          const existing = await DB.prepare(
            'SELECT id FROM products WHERE ml_item_id = ?'
          ).bind(mlId).first<{ id: number }>()

          if (existing) {
            await DB.prepare(`
              UPDATE products
              SET best_price = ?, affiliate_url = ?,
                  image_url = COALESCE(NULLIF(?, ''), image_url),
                  affiliate_updated_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE ml_item_id = ?
            `).bind(price, affUrl, image, mlId).run()
            updated++
          } else {
            const rawSlug   = _slug(name)
            const conflict  = await DB.prepare(
              'SELECT id FROM products WHERE slug = ?'
            ).bind(rawSlug).first()
            const finalSlug = conflict ? `${rawSlug}-${mlId.toLowerCase()}` : rawSlug

            const ins = await DB.prepare(`
              INSERT INTO products
                (name, slug, ml_item_id, affiliate_url, affiliate_updated_at,
                 image_url, best_price, offer_count, is_active, source,
                 category, description, created_at, updated_at)
              VALUES
                (?,?,?,?,CURRENT_TIMESTAMP,?,?,1,1,'mercadolivre',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            `).bind(
              name, finalSlug, mlId, affUrl,
              image || null, price,
              categorySlug,
              `${name}. Encontrado no Mercado Livre.`,
            ).run()

            const newId = ins.meta?.last_row_id as number

            // Offer placeholder
            await DB.prepare(`
              INSERT INTO offers
                (product_id, store_id, external_id, title, price,
                 original_price, discount_percent, affiliate_url,
                 is_active, in_stock, source, last_updated)
              VALUES (?,3,?,?,?,?,?,?,1,1,'mercadolivre',CURRENT_TIMESTAMP)
            `).bind(
              newId, mlId, name, price,
              item.original_price || null,
              discountPct || null,
              affUrl,
            ).run()

            await DB.prepare(
              'UPDATE products SET offer_count = 1, best_store_id = 3 WHERE id = ?'
            ).bind(newId).run()

            created++
          }
        } catch (e: any) {
          skipped++
          if (errors.length < 5) errors.push(`${mlId}: ${e.message}`)
        }
      }
    }

    // ML API: máximo real é offset + limit ≤ 1000
    if (offset + LIMIT >= Math.min(totalAvailable, 1000)) break

    // Pausa gentil entre páginas (evita rate-limit)
    if (offset + LIMIT < maxItems) {
      await new Promise(r => setTimeout(r, 300))
    }
  }

  // Atualiza product_count na categoria (se não for dry_run)
  if (!dryRun && created > 0) {
    await DB.prepare(`
      UPDATE categories
      SET product_count = (
            SELECT COUNT(*) FROM products WHERE category = ? AND is_active = 1
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE slug = ?
    `).bind(categorySlug, categorySlug).run().catch(() => {})

    // Invalida cache KV de categorias
    if (CACHE) {
      await CACHE.delete('ml_categories_tree').catch(() => {})
    }
  }

  return c.json({
    ok:              !errors.length || fetched > 0,
    dry_run:         dryRun,
    category_id:     categoryId,
    category_slug:   categorySlug,
    sort:            mlSort,
    max_items:       maxItems,
    total_available: totalAvailable,
    fetched,
    pages,
    created:         dryRun ? 0 : created,
    updated:         dryRun ? 0 : updated,
    skipped:         dryRun ? 0 : skipped,
    duration_ms:     Date.now() - startTime,
    errors:          errors.length ? errors : undefined,
    message:         dryRun
      ? `Dry run: ${fetched} itens encontrados em ${pages} páginas (${totalAvailable} disponíveis na categoria)`
      : `${created} criados, ${updated} atualizados, ${skipped} ignorados em ${pages} páginas`,
  })
})

// ══════════════════════════════════════════════════════════
// SISTEMA DE API KEYS — Gerenciamento de acesso externo
// ══════════════════════════════════════════════════════════

// ── Helper: gera token seguro ─────────────────────────────
async function generateApiKey(): Promise<{ raw: string; hash: string; prefix: string }> {
  const bytes  = crypto.getRandomValues(new Uint8Array(32))
  const hex    = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const raw    = `kr_live_${hex}`
  const prefix = raw.substring(0, 16)
  const buf    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hash   = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  return { raw, hash, prefix }
}

// ── GET /admin/api/api-keys ───────────────────────────────
admin.get('/api/api-keys', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT id, name, key_prefix, owner_email, plan, scopes,
           rate_limit, is_active, last_used_at, expires_at,
           total_calls, notes, created_at
    FROM api_keys
    ORDER BY created_at DESC
  `).all()
  return c.json(results || [])
})

// ── POST /admin/api/api-keys ── Cria nova chave ────────────
admin.post('/api/api-keys', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({}) as any)
  const { name, owner_email, plan, scopes, rate_limit, expires_at, notes } = body

  if (!name?.trim()) return c.json({ error: 'Nome obrigatório' }, 400)

  const { raw, hash, prefix } = await generateApiKey()

  await DB.prepare(`
    INSERT INTO api_keys
      (name, key_hash, key_prefix, owner_email, plan, scopes,
       rate_limit, is_active, expires_at, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(
    name.trim(),
    hash,
    prefix,
    owner_email || null,
    plan        || 'free',
    scopes      || 'read',
    rate_limit  || 100,
    expires_at  || null,
    notes       || null,
  ).run()

  // Retorna a chave RAW apenas uma vez — não fica armazenada em texto puro
  return c.json({
    ok:      true,
    api_key: raw,
    prefix,
    message: '⚠️ Guarde esta chave agora! Ela não será exibida novamente.',
  })
})

// ── PATCH /admin/api/api-keys/:id ── Edita chave ──────────
admin.patch('/api/api-keys/:id', async (c) => {
  const { DB } = c.env
  const id   = c.req.param('id')
  const body = await c.req.json().catch(() => ({}) as any)
  const { name, owner_email, plan, scopes, rate_limit, is_active, expires_at, notes } = body

  await DB.prepare(`
    UPDATE api_keys SET
      name        = COALESCE(?, name),
      owner_email = COALESCE(?, owner_email),
      plan        = COALESCE(?, plan),
      scopes      = COALESCE(?, scopes),
      rate_limit  = COALESCE(?, rate_limit),
      is_active   = COALESCE(?, is_active),
      expires_at  = COALESCE(?, expires_at),
      notes       = COALESCE(?, notes),
      updated_at  = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    name ?? null, owner_email ?? null, plan ?? null,
    scopes ?? null, rate_limit ?? null, is_active ?? null,
    expires_at ?? null, notes ?? null, id,
  ).run()

  return c.json({ ok: true })
})

// ── DELETE /admin/api/api-keys/:id ── Revoga chave ────────
admin.delete('/api/api-keys/:id', async (c) => {
  const { DB, CACHE } = c.env
  const id = c.req.param('id')
  await DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run()
  // Limpa contadores de rate limit no KV
  if (CACHE) {
    const slot = Math.floor(Date.now() / 3_600_000)
    await CACHE.delete(`rl:${id}:${slot}`).catch(() => {})
  }
  return c.json({ ok: true })
})

// ── PATCH /admin/api/api-keys/:id/toggle ── Ativa/desativa ─
admin.patch('/api/api-keys/:id/toggle', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const cur = await DB.prepare('SELECT is_active FROM api_keys WHERE id = ?')
    .bind(id).first<{ is_active: number }>()
  if (!cur) return c.json({ error: 'Não encontrado' }, 404)
  const newActive = cur.is_active === 1 ? 0 : 1
  await DB.prepare('UPDATE api_keys SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(newActive, id).run()
  return c.json({ ok: true, is_active: newActive })
})

// ── POST /admin/api/api-keys/:id/rotate ── Gera nova chave (mantém config) ─
admin.post('/api/api-keys/:id/rotate', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const exists = await DB.prepare('SELECT id FROM api_keys WHERE id = ?')
    .bind(id).first()
  if (!exists) return c.json({ error: 'Não encontrado' }, 404)

  const { raw, hash, prefix } = await generateApiKey()
  await DB.prepare(`
    UPDATE api_keys SET key_hash = ?, key_prefix = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(hash, prefix, id).run()

  return c.json({
    ok:      true,
    api_key: raw,
    prefix,
    message: '⚠️ Nova chave gerada! Atualize em todos os seus sistemas.',
  })
})

// ── GET /admin/api/api-keys/:id/usage ── Histórico de uso ─
admin.get('/api/api-keys/:id/usage', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')

  const [summary, recent] = await Promise.all([
    DB.prepare(`
      SELECT
        COUNT(*) AS total_calls,
        COUNT(CASE WHEN status_code < 400 THEN 1 END) AS success_calls,
        COUNT(CASE WHEN status_code >= 400 THEN 1 END) AS error_calls,
        AVG(duration_ms) AS avg_duration_ms,
        MIN(called_at) AS first_call,
        MAX(called_at) AS last_call
      FROM api_usage_log
      WHERE key_id = ?
        AND called_at >= datetime('now', '-30 days')
    `).bind(id).first<any>(),

    DB.prepare(`
      SELECT endpoint, method, status_code, duration_ms, called_at
      FROM api_usage_log
      WHERE key_id = ?
      ORDER BY called_at DESC
      LIMIT 50
    `).bind(id).all<any>(),
  ])

  // Chamadas por dia (últimos 7 dias)
  const { results: byDay } = await DB.prepare(`
    SELECT date(called_at) AS day, COUNT(*) AS calls
    FROM api_usage_log
    WHERE key_id = ? AND called_at >= datetime('now', '-7 days')
    GROUP BY day ORDER BY day ASC
  `).bind(id).all<any>()

  return c.json({
    summary,
    by_day:  byDay  || [],
    recent:  recent.results || [],
  })
})

// PUT /admin/api/ml-linkbuilder/products/:id — salva link manualmente
admin.put('/api/ml-linkbuilder/products/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ error: 'ID inválido' }, 400)
  const { affiliate_url } = await c.req.json().catch(() => ({} as any))
  if (!affiliate_url) return c.json({ error: 'affiliate_url obrigatória' }, 400)
  await DB.prepare(`
    UPDATE products SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(affiliate_url, id).run()
  return c.json({ ok: true, id, affiliate_url })
})

// ============================================================
// FEED INGESTION — Buffer raw_links + matching engine
// ============================================================

// ── POST /api/feed/ingest ─────────────────────────────────
// Recebe array de links (JSON) ou texto CSV, insere em raw_links
// e cria o registro feed_batches.
// Body: { store_id, network?, notes?, items: [...] }
// items: { name, affiliate_url, price?, original_price?,
//          external_id?, ean?, image_url?, product_url?,
//          category?, brand?, description? }
admin.post('/api/feed/ingest', async (c) => {
  const db = c.env.DB
  let body: any
  const ct = c.req.header('content-type') || ''

  if (ct.includes('application/json')) {
    body = await c.req.json()
  } else {
    // Aceita texto/CSV simples: name,affiliate_url,price,external_id
    const text = await c.req.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const isHeader = (l: string) => /name|titulo|produto/i.test(l.split(',')[0])
    const dataLines = isHeader(lines[0]) ? lines.slice(1) : lines
    body = {
      store_id: Number(c.req.query('store_id') || 0),
      network: c.req.query('network') || 'manual',
      items: dataLines.map(line => {
        const [name, affiliate_url, price, external_id, ean, brand, category] = line.split(',').map(s => s.trim())
        return { name, affiliate_url, price: price ? parseFloat(price) : undefined, external_id, ean, brand, category }
      }).filter(i => i.name && i.affiliate_url)
    }
  }

  const { store_id, network = 'manual', notes = null, items } = body

  if (!store_id) return c.json({ error: 'store_id obrigatório' }, 400)
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'items[] não pode ser vazio' }, 400)
  if (items.length > 10000) return c.json({ error: 'Máximo 10000 itens por lote' }, 400)

  // Valida que a loja existe
  const store = await db.prepare('SELECT id FROM stores WHERE id = ?').bind(store_id).first<{ id: number }>()
  if (!store) return c.json({ error: 'Loja não encontrada' }, 404)

  // Gera ID do lote (timestamp + random)
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`

  // Insere registro do lote
  await db.prepare(`
    INSERT INTO feed_batches (id, store_id, network, source, total_links, status, notes)
    VALUES (?, ?, ?, 'manual', ?, 'processing', ?)
  `).bind(batchId, store_id, network, items.length, notes).run()

  // Insere raw_links em chunks de 100 (D1 suporta ~100 statements por batch)
  let insertedCount = 0
  const chunkSize = 100

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    const stmts = chunk.map(item =>
      db.prepare(`
        INSERT INTO raw_links
          (batch_id, store_id, network, external_id, ean, name, price,
           original_price, image_url, affiliate_url, product_url,
           category, brand, description, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).bind(
        batchId,
        store_id,
        network,
        item.external_id || null,
        item.ean || null,
        item.name,
        item.price || null,
        item.original_price || null,
        item.image_url || null,
        item.affiliate_url,
        item.product_url || null,
        item.category || null,
        item.brand || null,
        item.description || null
      )
    )
    await db.batch(stmts)
    insertedCount += chunk.length
  }

  return c.json({
    ok: true,
    batch_id: batchId,
    total_queued: insertedCount,
    message: `${insertedCount} links enfileirados. Use POST /api/feed/process?batch_id=${batchId} para processar.`
  })
})

// ── POST /api/feed/process ────────────────────────────────
// Processa raw_links pendentes: matching → cria/atualiza products + offers
// Query params: batch_id (opcional), limit (default 200)
admin.post('/api/feed/process', async (c) => {
  const db = c.env.DB
  const batchId = c.req.query('batch_id') || null
  const limit = Math.min(parseInt(c.req.query('limit') || '200'), 500)

  const started = Date.now()

  // Busca raw_links pendentes
  const query = batchId
    ? `SELECT * FROM raw_links WHERE batch_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?`
    : `SELECT * FROM raw_links WHERE status = 'pending' ORDER BY imported_at ASC LIMIT ?`

  const { results: pending } = batchId
    ? await db.prepare(query).bind(batchId, limit).all<any>()
    : await db.prepare(query).bind(limit).all<any>()

  if (pending.length === 0) {
    // Se batch_id, atualiza status do lote para 'done'
    if (batchId) {
      await db.prepare(`UPDATE feed_batches SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(batchId).run()
    }
    return c.json({ ok: true, processed: 0, message: 'Nenhum link pendente' })
  }

  // Contadores por lote
  const batchStats: Record<string, { matched: number; created: number; updated: number; skipped: number; errors: number }> = {}

  const getStats = (bid: string) => {
    if (!batchStats[bid]) batchStats[bid] = { matched: 0, created: 0, updated: 0, skipped: 0, errors: 0 }
    return batchStats[bid]
  }

  // Cache de produtos por EAN e external_id
  const eanCache: Record<string, number> = {}
  const extIdCache: Record<string, number> = {}

  for (const link of pending) {
    try {
      let productId: number | null = null
      let matchMethod: string | null = null
      let matchScore = 0

      // ── 1. Match por EAN ──────────────────────────────
      if (link.ean && !eanCache[link.ean]) {
        const prod = await db.prepare(`SELECT id FROM products WHERE ean = ? AND is_active = 1 LIMIT 1`)
          .bind(link.ean).first<{ id: number }>()
        if (prod) eanCache[link.ean] = prod.id
      }
      if (link.ean && eanCache[link.ean]) {
        productId = eanCache[link.ean]
        matchMethod = 'ean'
        matchScore = 1.0
      }

      // ── 2. Match por external_id (mesma loja) ─────────
      if (!productId && link.external_id) {
        const cacheKey = `${link.store_id}:${link.external_id}`
        if (!extIdCache[cacheKey]) {
          const prod = await db.prepare(`
            SELECT p.id FROM products p
            JOIN offers o ON o.product_id = p.id
            WHERE o.external_id = ? AND o.store_id = ? AND p.is_active = 1
            LIMIT 1
          `).bind(link.external_id, link.store_id).first<{ id: number }>()
          if (prod) extIdCache[cacheKey] = prod.id
        }
        if (extIdCache[cacheKey]) {
          productId = extIdCache[cacheKey]
          matchMethod = 'external_id'
          matchScore = 0.95
        }
      }

      // ── 3. Match por ml_item_id no campo offers ───────
      if (!productId && link.external_id && link.network === 'meli-api') {
        const prod = await db.prepare(`
          SELECT p.id FROM products p
          WHERE p.ml_item_id = ? AND p.is_active = 1
          LIMIT 1
        `).bind(link.external_id).first<{ id: number }>()
        if (prod) {
          productId = prod.id
          matchMethod = 'ml_item_id'
          matchScore = 0.98
        }
      }

      // ── 4. Match por nome (similaridade cross-plataforma) ────
      if (!productId && link.name) {
        const normStr = (s: string) => s.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()

        // Palavras irrelevantes para o match
        const STOP = new Set([
          'de','do','da','dos','das','com','para','por','em','no','na','nos','nas',
          'the','with','for','and','or','in','um','uma','os','as','e','a','o',
          'kit','combo','pack','leve','mais','frete','gratis','oferta','promo',
          'original','lacrado','novo','semi','usado','importado','nacional',
        ])

        // Palavras de COR: ficam FORA do fingerprint (modelo base não tem cor)
        // MAS se ambos os nomes têm cor e são DIFERENTES → variante separada
        const COLOR_SET = new Set([
          'preto','preta','pretos','pretas',
          'branco','branca',
          'prata','prateado','prateada',
          'dourado','dourada','gold',
          'rosa','pink',
          'azul','blue',
          'verde','green',
          'vermelho','vermelha','red',
          'cinza','grey','gray',
          'laranja','orange',
          'roxo','roxa','purple','violeta','lilas',
          'amarelo','amarela','yellow',
          'bege','creme',
          'chumbo','grafite',
          'champagne','champanhe',
          'titanio','titanium',
          'coral','midnight','starlight','navy',
          'cobre','bronze',
          'black','white','silver',
        ])

        // Palavras de variante (memória, conectividade) — fora do fingerprint mas não causam separação
        const VARIANTS = new Set([
          ...COLOR_SET,
          '128gb','256gb','512gb','1tb','2tb','4gb','6gb','8gb','12gb','16gb',
          '32gb','64gb','wi-fi','4g','5g','wifi',
        ])

        // Extrai cor de um nome (primeira cor encontrada)
        const extractColor = (name: string): string | null => {
          const tokens = normStr(name).split(' ')
          for (const t of tokens) {
            if (COLOR_SET.has(t)) return t
          }
          return null
        }

        // Dois nomes têm cores DIFERENTES? (ambos com cor e cores distintas)
        const hasDifferentColor = (nameA: string, nameB: string): boolean => {
          const cA = extractColor(nameA)
          const cB = extractColor(nameB)
          if (!cA || !cB) return false  // sem conflito se algum não tem cor
          return cA !== cB
        }

        // ── Extrai "modelo fingerprint" ─────────────────────────
        // Retém marca + modelo + spec chave, ignorando marketing e variantes de cor
        const extractFingerprint = (name: string): string[] => {
          const norm = normStr(name)
          return norm.split(' ')
            .filter(t => t.length > 1 && !STOP.has(t) && !VARIANTS.has(t))
        }

        const linkNorm    = normStr(link.name)
        const linkTokens  = linkNorm.split(' ').filter(t => t.length > 1 && !STOP.has(t))
        const linkFP      = extractFingerprint(link.name)

        if (linkFP.length > 0) {
          // ── GUARD: nomes genéricos nunca devem fazer fuzzy match ──────────
          // Nomes como 'Produto Importado', 'Cfegdhabc31955' têm tokens únicos
          // que dariam score=1.0 por acidente (único candidato com aquele token)
          const isGenericName = /^(Produto\s+Importado|Produto\s+MLB|Cfegdhabc|MLBU?\d{6,12})/i.test(link.name)
          if (isGenericName) {
            // Nome genérico → nunca fazer match, sempre criar produto novo
            // (o enrich-offers vai corrigir nome/preço/imagem depois)
          } else {

          // Busca candidatos: prioriza mesma marca/categoria
          let candidates: { id: number; name: string; brand: string | null }[] = []

          if (link.brand) {
            // 1ª tentativa: mesma marca (mais preciso)
            const r1 = await db.prepare(
              `SELECT id, name, brand FROM products WHERE brand = ? AND is_active = 1 LIMIT 400`
            ).bind(link.brand).all<{ id: number; name: string; brand: string | null }>()
            candidates = r1.results

            // 2ª tentativa: mesma categoria (fallback)
            if (candidates.length === 0 && link.category) {
              const r2 = await db.prepare(
                `SELECT id, name, brand FROM products WHERE category = ? AND is_active = 1 LIMIT 400`
              ).bind(link.category).all<{ id: number; name: string; brand: string | null }>()
              candidates = r2.results
            }
          } else {
            const r = await db.prepare(
              `SELECT id, name, brand FROM products WHERE is_active = 1 LIMIT 600`
            ).all<{ id: number; name: string; brand: string | null }>()
            candidates = r.results
          }

          let bestId: number | null = null
          let bestScore = 0
          let bestMethod = 'name_fuzzy'

          for (const cand of candidates) {
            // Pula candidatos com nome gen\u00e9rico no banco (evita match acidental por score=1.0)
            if (/^(Produto\s+Importado|Produto\s+MLB|Cfegdhabc|MLBU?\d{6,12})/i.test(cand.name)) continue

            const candFP     = extractFingerprint(cand.name)
            const candFPSet  = new Set(candFP)
            const linkFPSet  = new Set(linkFP)

            // ── Score 1: Jaccard sobre fingerprint (marca+modelo, sem cor/variante)
            const fpInter  = linkFP.filter(t => candFPSet.has(t)).length
            const fpUnion  = new Set([...linkFP, ...candFP]).size
            const fpJacc   = fpUnion > 0 ? fpInter / fpUnion : 0

            // ── Score 2: Jaccard sobre tokens completos (inclui variantes)
            const candNorm    = normStr(cand.name)
            const candTokens  = new Set(candNorm.split(' ').filter(t => t.length > 1 && !STOP.has(t)))
            const fullInter   = linkTokens.filter(t => candTokens.has(t)).length
            const fullUnion   = new Set([...linkTokens, ...candTokens]).size
            const fullJacc    = fullUnion > 0 ? fullInter / fullUnion : 0

            // ── Score 3: Cobertura dos tokens do input no candidato ───────────
            // "Quantos dos meus tokens existem no candidato?"
            // Ex: input tem [s11, mini, gps] e candidato tem todos → cobertura = 1.0
            // Mais robusto que Jaccard quando candidato tem tokens extras (Series 11, Whatsapp, 2026)
            const coverageInter = linkFP.filter(t => candFPSet.has(t)).length
            const inputCoverage = linkFP.length > 0 ? coverageInter / linkFP.length : 0

            // ── Bônus: mesma marca explícita
            const brandBonus = (link.brand && cand.brand &&
              normStr(link.brand) === normStr(cand.brand)) ? 0.08 : 0

            // ── Bônus: token de modelo alfanumérico coincide (S11, X100, Tab5, etc.)
            // Token que começa com letra e tem número — muito específico de produto
            const modelTokens = linkFP.filter(t => /^[a-z]+\d+/.test(t) || /^\d+[a-z]+/.test(t))
            const modelMatch  = modelTokens.length > 0 && modelTokens.every(t => candFPSet.has(t))
            const modelBonus  = modelMatch ? 0.10 : 0

            // Score final: melhor entre os 3 métodos + bônus
            const score = Math.min(1.0, Math.max(fpJacc, fullJacc, inputCoverage) + brandBonus + modelBonus)

            // ── Limiares adaptativos ──────────────────────────────
            // - Se mesma marca: 0.60 (nomes podem variar entre plataformas)
            // - Se modelo alfanumérico coincide (S11): 0.65 (token muito específico)
            // - Se sem marca nem modelo: 0.72 (mais conservador)
            const threshold = brandBonus > 0 ? 0.60 : modelMatch ? 0.65 : 0.72

            if (score >= threshold) {
              // ── REGRA DE COR: cores diferentes = variante separada ──
              // Ex: "S11 Preto" (Shopee) vs "S11 Prateado" (ML) → NÃO agrupa
              // Ex: "S11 Prateado" (Shopee) vs "S11 Prateado" (ML) → agrupa ✅
              // Ex: "S11" (sem cor) vs "S11 Prateado" (ML) → agrupa ✅
              if (hasDifferentColor(link.name, cand.name)) continue

              // ── Bônus de cor: prefere candidato com mesma cor explícita ──
              // Quando há empate de score (vários S11), o com mesma cor vence
              const myColor   = extractColor(link.name)
              const candColor = extractColor(cand.name)
              const sameColor = myColor && candColor && myColor === candColor
              const scoreFinal = sameColor ? Math.min(1.0, score + 0.05) : score

              if (scoreFinal > bestScore) {
                bestScore  = scoreFinal
                bestId     = cand.id
                bestMethod = fpJacc >= fullJacc ? 'name_fp' : 'name_fuzzy'
              }
            }
          }

          if (bestId) {
            productId   = bestId
            matchMethod = bestMethod
            matchScore  = bestScore
          }
        }
          } // fim do else (nome não genérico)
      }

      // ── 5. Cria produto novo se não encontrou ─────────
      let status: string
      if (!productId) {
        // Gera slug único
        const slugBase = (link.brand ? `${link.brand} ${link.name}` : link.name)
          .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s]/g, ' ').replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 80)
        const slug = `${slugBase}-${Math.random().toString(36).substring(2, 7)}`

        // Auto-detecta categoria se não informada
        const detectedCategory = detectCategoryWithFallback(
          link.name || '', link.product_url || '', link.category || null
        )

        const res = await db.prepare(`
          INSERT OR IGNORE INTO products (ean, name, slug, brand, category, image_url, best_price, offer_count, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).bind(
          link.ean || null, link.name, slug,
          link.brand || null, detectedCategory || 'outros',
          link.image_url || null, link.price || null, link.network || 'manual'
        ).run()

        productId = res.meta.last_row_id as number
        matchMethod = 'new'
        matchScore = 0
        status = 'created'
        getStats(link.batch_id).created++
      } else {
        status = 'matched'
        getStats(link.batch_id).matched++

        // ── Fix: atualiza categoria se produto existe mas category = null ─
        if (productId) {
          const existingCat = await db.prepare(
            `SELECT category FROM products WHERE id = ? LIMIT 1`
          ).bind(productId).first<{ category: string | null }>()

          if (!existingCat?.category || existingCat.category === 'outros') {
            const newCat = detectCategoryWithFallback(
              link.name || '', link.product_url || '', null
            )
            if (newCat && newCat !== 'outros') {
              await db.prepare(
                `UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
              ).bind(newCat, productId).run()
            }
          }
        }
      }

      // ── 6. Upsert da oferta ───────────────────────────
      // Gera external_id automático se não veio do feed:
      // Prioridade: external_id explícito > MLB do affiliate_url > hash(affiliate_url) > hash(product_url+store)
      let extId: string = link.external_id || ''
      if (!extId) {
        const urlForId = link.affiliate_url || link.product_url || ''
        // Tenta extrair MLB-ID diretamente da URL do produto (MLBU123, /p/MLB123, etc)
        const mlbMatch = urlForId.match(/\b(MLB[U]?)[-]?(\d{6,12})\b/i)
        if (mlbMatch) {
          extId = `MLB-${mlbMatch[2]}`
        } else {
          // Fallback: hash simples da URL para garantir unicidade
          let h = 0
          for (let i = 0; i < urlForId.length; i++) { h = (Math.imul(31, h) + urlForId.charCodeAt(i)) | 0 }
          extId = `feed-${link.store_id}-${Math.abs(h).toString(36)}`
        }
      }

      // SQLite usa IS em vez de IS NOT DISTINCT FROM
      const existingOffer = await db.prepare(`
        SELECT id FROM offers WHERE product_id = ? AND store_id = ? AND external_id = ?
        LIMIT 1
      `).bind(productId, link.store_id, extId).first<{ id: number }>()

      const discount = link.original_price && link.original_price > (link.price || 0)
        ? Math.round(((link.original_price - (link.price || 0)) / link.original_price) * 1000) / 10
        : 0

      let offerId: number

      if (existingOffer) {
        await db.prepare(`
          UPDATE offers SET
            price = ?, original_price = ?, discount_percent = ?,
            image_url = ?, last_updated = CURRENT_TIMESTAMP,
            cache_expires_at = datetime('now', '+2 hours')
          WHERE id = ?
        `).bind(link.price || 0, link.original_price || null, discount, link.image_url || null, existingOffer.id).run()
        offerId = existingOffer.id
        if (status === 'matched') {
          getStats(link.batch_id).matched--
          getStats(link.batch_id).updated++
          status = 'updated'
        }
      } else {
        const offerRes = await db.prepare(`
          INSERT INTO offers
            (product_id, store_id, external_id, title, price, original_price,
             discount_percent, free_shipping, in_stock, product_url, affiliate_url,
             image_url, source, cache_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, datetime('now', '+2 hours'))
        `).bind(
          productId, link.store_id, extId, link.name || 'Produto Importado',
          link.price || 0, link.original_price || null, discount,
          link.product_url || null, link.affiliate_url || null,
          link.image_url || null, link.network || 'manual'
        ).run()
        offerId = offerRes.meta.last_row_id as number
      }

      // ── 7. Atualiza best_price do produto ─────────────
      await db.prepare(`
        UPDATE products SET
          best_price = (SELECT MIN(price) FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1),
          best_store_id = (SELECT store_id FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1 ORDER BY price ASC LIMIT 1),
          offer_count = (SELECT COUNT(*) FROM offers WHERE product_id = ? AND is_active = 1),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(productId, productId, productId, productId).run()

      // ── 8. Atualiza raw_link com resultado ────────────
      await db.prepare(`
        UPDATE raw_links SET
          status = ?, match_method = ?, match_score = ?,
          product_id = ?, offer_id = ?, processed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(status, matchMethod, matchScore, productId, offerId, link.id).run()

    } catch (err: any) {
      // Marca como erro
      await db.prepare(`
        UPDATE raw_links SET status = 'error', error_msg = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(String(err?.message || err).substring(0, 500), link.id).run()
      getStats(link.batch_id).errors++
    }
  }

  // Atualiza contadores de cada feed_batch afetado
  for (const [bid, s] of Object.entries(batchStats)) {
    // Conta o que realmente está no banco para esse batch
    const counts = await db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) as created,
        SUM(CASE WHEN status = 'updated' THEN 1 ELSE 0 END) as updated,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) as errors
      FROM raw_links WHERE batch_id = ?
    `).bind(bid).first<any>()

    const batchStatus = counts.pending > 0 ? 'processing' : (counts.errors > 0 ? 'partial' : 'done')

    await db.prepare(`
      UPDATE feed_batches SET
        matched = ?, created = ?, updated = ?, skipped = ?, errors = ?,
        status = ?, finished_at = CASE WHEN ? = 'done' OR ? = 'partial' THEN CURRENT_TIMESTAMP ELSE finished_at END
      WHERE id = ?
    `).bind(
      counts.matched || 0, counts.created || 0, counts.updated || 0,
      counts.skipped || 0, counts.errors || 0,
      batchStatus, batchStatus, batchStatus, bid
    ).run()
  }

  return c.json({
    ok: true,
    processed: pending.length,
    duration_ms: Date.now() - started,
    // Contadores agregados para o frontend de progresso
    imported:  Object.values(batchStats).reduce((s, b) => s + b.created,  0),
    matched:   Object.values(batchStats).reduce((s, b) => s + b.matched,  0),
    updated:   Object.values(batchStats).reduce((s, b) => s + b.updated,  0),
    skipped:   Object.values(batchStats).reduce((s, b) => s + b.skipped,  0),
    errors:    Object.values(batchStats).reduce((s, b) => s + b.errors,   0),
    // Quantos ainda restam pendentes neste batch (para polling do frontend)
    pending_remaining: batchId
      ? await (async () => {
          const r = await db.prepare(`SELECT COUNT(*) as n FROM raw_links WHERE batch_id = ? AND status = 'pending'`).bind(batchId).first<{n:number}>()
          return r?.n ?? 0
        })()
      : null,
    batches: batchStats
  })
})

// ── POST /api/feed/retry-errors ──────────────────────────────
// Reprocessa raw_links com status='error' — reseta para 'pending' e processa
// Útil para retentar links que falharam por bug (ex: external_id NOT NULL)
admin.post('/api/feed/retry-errors', async (c) => {
  const db = c.env.DB
  const body: any = await c.req.json().catch(() => ({}))
  const batchId: string | null = body.batch_id || null
  const limit = Math.min(parseInt(body.limit) || 200, 500)

  // Conta erros antes de resetar
  const countQ = batchId
    ? `SELECT COUNT(*) as n FROM raw_links WHERE batch_id = ? AND status = 'error'`
    : `SELECT COUNT(*) as n FROM raw_links WHERE status = 'error'`
  const countR = batchId
    ? await db.prepare(countQ).bind(batchId).first<{ n: number }>()
    : await db.prepare(countQ).first<{ n: number }>()
  const total_errors = countR?.n ?? 0

  if (total_errors === 0) return c.json({ ok: true, reset: 0, message: 'Nenhum erro para reprocessar' })

  // Reseta para 'pending' (limpa error_msg)
  const resetQ = batchId
    ? `UPDATE raw_links SET status = 'pending', error_msg = NULL, processed_at = NULL WHERE batch_id = ? AND status = 'error' LIMIT ?`
    : `UPDATE raw_links SET status = 'pending', error_msg = NULL, processed_at = NULL WHERE status = 'error' LIMIT ?`
  const resetR = batchId
    ? await db.prepare(resetQ).bind(batchId, limit).run()
    : await db.prepare(resetQ).bind(limit).run()
  const reset = resetR.meta.changes ?? 0

  return c.json({
    ok: true,
    reset,
    total_errors,
    message: `${reset} links resetados para 'pending'. Acione POST /api/feed/process para processar.`,
  })
})

// ── GET /api/feed/batches ─────────────────────────────────
// Lista histórico de lotes com paginação
admin.get('/api/feed/batches', async (c) => {
  const db = c.env.DB
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = (page - 1) * limit
  const storeFilter = c.req.query('store_id')

  const where = storeFilter ? 'WHERE fb.store_id = ?' : ''
  const binds = storeFilter ? [parseInt(storeFilter), limit, offset] : [limit, offset]

  const { results } = await db.prepare(`
    SELECT
      fb.*,
      s.name as store_name,
      s.logo_url as store_logo,
      (fb.matched + fb.created + fb.updated) as total_processed
    FROM feed_batches fb
    LEFT JOIN stores s ON s.id = fb.store_id
    ${where}
    ORDER BY fb.started_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds).all<any>()

  const total = await db.prepare(`SELECT COUNT(*) as n FROM feed_batches ${where}`)
    .bind(...binds.slice(0, storeFilter ? 1 : 0)).first<{ n: number }>()

  // Conta pendentes globais
  const pending = await db.prepare(
    `SELECT COUNT(*) as n FROM raw_links WHERE status = 'pending'`
  ).first<{ n: number }>()

  return c.json({
    batches: results,
    total: total?.n || 0,
    page,
    limit,
    pending_links: pending?.n || 0
  })
})

// ── GET /api/feed/batches/:id ─────────────────────────────
// Detalhe de um lote com amostras de resultados
admin.get('/api/feed/batches/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  const batch = await db.prepare(`
    SELECT fb.*, s.name as store_name
    FROM feed_batches fb
    LEFT JOIN stores s ON s.id = fb.store_id
    WHERE fb.id = ?
  `).bind(id).first<any>()

  if (!batch) return c.json({ error: 'Lote não encontrado' }, 404)

  // Distribuição de status
  const { results: statusDist } = await db.prepare(`
    SELECT status, COUNT(*) as count FROM raw_links WHERE batch_id = ? GROUP BY status
  `).bind(id).all<{ status: string; count: number }>()

  // Últimos 50 links com detalhes
  const { results: links } = await db.prepare(`
    SELECT
      rl.id, rl.name, rl.price, rl.status,
      rl.match_method, rl.match_score, rl.error_msg,
      rl.external_id, rl.ean, rl.network,
      p.name as product_name, p.id as product_id
    FROM raw_links rl
    LEFT JOIN products p ON p.id = rl.product_id
    WHERE rl.batch_id = ?
    ORDER BY rl.id DESC
    LIMIT 50
  `).bind(id).all<any>()

  // Amostra de erros
  const { results: errors } = await db.prepare(`
    SELECT id, name, error_msg FROM raw_links WHERE batch_id = ? AND status = 'error' LIMIT 10
  `).bind(id).all<any>()

  return c.json({ batch, status_distribution: statusDist, links, errors })
})

// ── DELETE /api/feed/batches/:id ──────────────────────────
// Remove lote + seus raw_links (cleanup de testes)
admin.delete('/api/feed/batches/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM raw_links WHERE batch_id = ?').bind(id).run()
  await db.prepare('DELETE FROM feed_batches WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ── GET /api/feed/pending ─────────────────────────────────
// Conta quantos raw_links estão pendentes (para polling do SPA)
admin.get('/api/feed/pending', async (c) => {
  const db = c.env.DB
  const batchId = c.req.query('batch_id')
  const where = batchId ? 'WHERE batch_id = ?' : ''
  const row = await db.prepare(`SELECT COUNT(*) as n FROM raw_links WHERE status = 'pending' ${where}`)
    .bind(...(batchId ? [batchId] : [])).first<{ n: number }>()
  return c.json({ pending: row?.n || 0 })
})

// ── GET /admin/api/categories — Lista com COUNT real ─────
// Retorna todas as categorias com contagem real de produtos
// (ignora product_count estático, que pode estar desatualizado)
admin.get('/api/categories', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT
      c.id, c.slug, c.name, c.icon, c.is_active, c.sort_order,
      c.product_count AS stored_count,
      COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p
      ON p.category = c.slug
      AND p.is_active = 1
    GROUP BY c.id
    ORDER BY c.sort_order ASC, COUNT(p.id) DESC
  `).all<any>()

  // Conta produtos sem categoria (não vinculados a nenhuma cat)
  const uncategorized = await DB.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE is_active = 1
      AND (category IS NULL OR category = '' OR category = 'outros')
  `).first<{ n: number }>()

  // Total real de produtos ativos no banco
  const totalReal = await DB.prepare(`
    SELECT COUNT(*) as n FROM products WHERE is_active = 1
  `).first<{ n: number }>()

  return c.json({
    categories: results,
    uncategorized: uncategorized?.n || 0,
    total_products: totalReal?.n || 0,
  })
})

// ── POST /admin/api/categories/recategorize ───────────────
// Roda detectCategory() em TODOS os produtos sem categoria (ou com 'outros')
// e atualiza o campo category no banco.
// Util para backfill de produtos importados antes da auto-cat existir.
admin.post('/api/categories/recategorize', async (c) => {
  const { DB } = c.env
  const force = c.req.query('force') === '1'  // se force=1, recategoriza TODOS (mesmo os que já têm cat)

  // Busca produtos sem categoria (ou forçado = todos)
  const where = force
    ? `WHERE is_active = 1`
    : `WHERE is_active = 1 AND (category IS NULL OR category = '' OR category = 'outros')`

  const { results: products } = await DB.prepare(
    `SELECT id, name, best_price FROM products ${where} ORDER BY id ASC LIMIT 500`
  ).all<{ id: number; name: string; best_price: number | null }>()

  if (products.length === 0) {
    return c.json({ ok: true, updated: 0, message: 'Nenhum produto para recategorizar' })
  }

  // Aplica detectCategory inline (sem import dinâmico — reusa a lógica diretamente)
  // ─── mapa de palavras-chave inline ────────────────────────────────────────────
  type CatRule = { slug: string; keywords: string[] }
  const RULES: CatRule[] = [
    // saúde sexual ANTES de beleza — 'gel lubrificante' não vai para beleza
    { slug: 'saude',            keywords: ['sex shop','sexshop','gel lubrificante','lubrificante intimo','lubrificante sexual','gel intimo','gel sexual','preservativo','camisinha','vibrador','massageador intimo','estimulante sexual','kit intimo','kit sex','produtos intimos','produto intimo','excitante','calcinha comestivel','fantasia erotica','acessorio intimo','lubrificante','saude sexual','saude intima','higiene intima'] },
    // beleza ANTES de eletro para 'chapinha','prancha' não conflitar
    { slug: 'beleza',           keywords: ['shampoo','condicionador','mascara capilar','leave-in','leave in','finalizador capilar','oleo capilar','tratamento capilar','reconstrucao capilar','hidratacao capilar','tanino','escova progressiva','chapinha','prancha de cabelo','prancha cabelo','prancha titanium','prancha ceramica','chapa titanium','chapa ceramica','prancha mq','mq pro','prancha turbo','prancha led','escova secadora','secador de cabelo','babyliss','taiff','mq professional','gama italy','lizze','creme facial','serum facial','hidratante facial','hidratante corporal','protetor solar','retinol','acido hialuronico','hyaluronic','esfoliante','mascara facial','base maquiagem','batom','demaquilante','isdin','la roche','vichy','eucerin','cetaphil','neutrogena','olay','loreal','maybelline','natura una','natura ekos','natura chronos','o boticario','eudora','oleo de amendoas','oleo de ricino','creme dental','pasta de dente','palito de dente','palito dente','don alcides','fit cosmetics','grandha','wella','schwarzkopf','tresemme','pantene','keune','ampola capilar','soro capilar','serum capilar','keratina','queratina','botox capilar','selante','antifrizz','branqueamento','rolo facial','rolos faciais','massageador facial','rolo de jade','rolo led','mascara led','aparelho led facial','led facial','dermapen','aparelho de beleza','aparelho facial','depilador','depiladora','epilador','epiladora','creme para massagem','cuidados pessoais'] },
    { slug: 'perfumes',         keywords: ['perfume','colonia','eau de parfum','eau de toilette','edp ','edt ','deo parfum','deo colonia','body splash','body mist','desodorante','antitranspirante','roll-on','al wataniah','arabian oud','lattafa','armaf','oud intense','oud wood','musk ','natura una celebrar','o.u.i parfum'] },
    { slug: 'saude',            keywords: ['whey protein','proteina whey','creatina','bcaa','pre-treino','pre treino','vitamina d','vitamina b12','acido folico','omega 3','omega-3','multivitaminico','suplemento alimentar','termogenico','aminoacido','glutamina','maltodextrina','dextrose','bebida de eletrolitos','eletrolitos em po','bebida isotonica','bebida vegetal','leite vegetal','leite de amendoas','leite de aveia','leite de coco','liquidz','aparelho de pressao','oximetro','glicosimetro','termometro','nebulizador','almofada ortopedica','elimine verrugas','crioterapia','dermafreeze','ampola de soro'] },
    { slug: 'alimentos',        keywords: ['chocolate ','biscoito','bolacha','snack','barra de cereal','granola','aveia em flocos','farinha de aveia','azeite de oliva','molho de tomate','macarrao','cafe em grao','cafe solúvel','capsula de cafe','cha verde','cha preto','erva-mate','kit compre','kit leve','fardo de','cx de','leite de coco tradicional'] },
    { slug: 'smartphones',      keywords: ['smartphone','celular','iphone','galaxy s','galaxy a','galaxy m','moto g','moto e','motorola edge','redmi','xiaomi','poco','realme','oppo','pixel ','oneplus','asus zenfone','android phone','telefone celular'] },
    { slug: 'notebooks',        keywords: ['notebook','laptop','macbook','ultrabook','chromebook','thinkpad','ideapad','legion ','yoga book','dell xps','dell inspiron','hp pavilion','hp envy','hp victus','acer aspire','acer nitro','acer swift','asus vivobook','asus zenbook','asus rog','asus tuf','surface laptop','surface book','surface pro'] },
    { slug: 'tv',               keywords: ['smart tv','televisao','televisor','tv led','tv oled','tv qled','tv uhd','tv 4k','tv 8k','tv 32','tv 40','tv 43','tv 50','tv 55','tv 65','tv 75','tv 85','tv samsung','tv lg','tv sony','tv philips','tv tcl','tv hisense','tv xiaomi','bravia','qled tv','neo qled','oled tv','crystal uhd','nanocell','4k tv','8k tv','android tv','google tv','webos','tizen tv'] },
    { slug: 'tablets',          keywords: ['tablet','ipad','ipad air','ipad pro','ipad mini','galaxy tab','tab s','tab a','lenovo tab','fire hd','fire tablet','kindle fire'] },
    { slug: 'games',            keywords: ['playstation','ps5','ps4','xbox series','xbox one','nintendo switch','switch oled','switch lite','steam deck','controle gamer','joystick','jogo ps5','jogo ps4','jogo xbox','jogo nintendo','headset gamer','cadeira gamer','mouse gamer','teclado gamer','placa de video','gpu rtx','gpu rx','rtx 3060','rtx 3070','rtx 3080','rtx 4060','rtx 4070','rtx 4080','rx 6600','rx 6700','rx 7600','rx 7700','geforce','radeon rx','gaming chair'] },
    { slug: 'audio',            keywords: ['fone de ouvido','headphone','headset','earphone','earbuds','airpods','galaxy buds','jabra','beats headphones','jbl headphone','bose headphone','sony headphone','sennheiser','skullcandy','caixa de som','caixa bluetooth','speaker bluetooth','alto-falante','soundbar','subwoofer','home theater','sistema de som','amplificador','microfone','toca-discos','vitrola','aparelho de som'] },
    { slug: 'cameras',          keywords: ['camera digital','camera fotografica','camera mirrorless','camera reflex','dslr','mirrorless','gopro','action camera','camera de acao','drone','dji','dji mini','dji air','phantom','mavic','canon eos','nikon d','nikon z','sony alpha','fujifilm x','lente camera','objetiva','flash fotografico','camera instantanea','instax'] },
    { slug: 'eletrodomesticos', keywords: ['geladeira','refrigerador','freezer','lavadora','maquina de lavar','secadora','lava-loucas','lava-roupas','fogao','cooktop','forno eletrico','microondas','ar condicionado','ar-condicionado','split ','ventilador','purificador de agua','filtro de agua','maquina de cafe','cafeteira','batedeira','liquidificador','fritadeira','airfryer','air fryer','panela eletrica','panela de pressao','sanduicheira','torradeira','espremedor','multiprocessador','aspirador de po','aspirador robo','ferro de passar'] },
    { slug: 'computadores',     keywords: ['desktop','computador','pc gamer','pc gaming','all in one','mini pc','workstation','imac','processador intel','processador amd','core i3','core i5','core i7','core i9','ryzen 3','ryzen 5','ryzen 7','ryzen 9','placa mae','motherboard','memoria ram','pente de ram','ram ddr4','ram ddr5','fonte de alimentacao','gabinete pc','case atx','case mid-tower'] },
    { slug: 'monitores',        keywords: ['monitor 4k','monitor gamer','monitor led','monitor ips','monitor curvo','monitor ultrawide','dell monitor','lg monitor','samsung monitor','aoc monitor','asus monitor','monitor 24','monitor 27','monitor 32','144hz','165hz','240hz','freesync','gsync'] },
    { slug: 'impressoras',      keywords: ['impressora','multifuncional','scanner','plotter','cartucho de tinta','toner','epson l','epson ecotank','hp deskjet','hp laserjet','canon pixma','brother mfc','brother dcp'] },
    // FIXO: slug correto é 'componentes-pc' na tabela categories
    { slug: 'componentes-pc',   keywords: ['ssd m.2','ssd nvme','hd ssd','ssd 250','ssd 500','ssd 1tb','ssd 2tb','placa de video','placa-de-video','placa mae','placa-mae','cooler cpu','pasta termica','cabo sata','fonte 500w','fonte 600w','fonte 700w','fonte 750w','fonte 800w','gabinete ','dissipador'] },
    { slug: 'armazenamento',    keywords: ['hd externo','hd interno','hard disk','hard drive','pendrive','pen drive','flash drive','memoria flash','cartao de memoria','cartao sd','microsd','sdxc','sdhc','ssd externo','ssd portatil','nvme externo','nas storage','wd red','wd blue','seagate barracuda','seagate ironwolf'] },
    { slug: 'redes',            keywords: ['roteador','router','modem','access point','ponto de acesso','switch de rede','cabo de rede','cabo ethernet','cabo rj45','placa de rede','adaptador wifi','repetidor wifi','extensor wifi','mesh wifi','sistema mesh','tp-link','intelbras roteador','asus roteador','netgear','ubiquiti','mikrotik'] },
    { slug: 'moda',             keywords: ['tenis ','sapato','sandalia','bota ','mocassim','chinelo','camiseta','camisa ','calca jeans','vestido','saia ','blusa ','casaco','jaqueta','moletom','shorts ','bermuda ','cueca','calcinha','sutiã','meia ','cinto ','bolsa ','mochila ','carteira couro','oculos ','relogio ','nike','adidas','puma','vans','converse','new balance','havaianas','melissa','zara','lacoste'] },
    // Automotivo — cobre tapetes, lâmpadas, apliques, suportes veiculares, etc.
    { slug: 'automotivo',       keywords: [
      // capas e proteção de carro
      'capa carro','capa cobrir carro','capa de cobrir','cobrir carro','capa impermeavel carro','capa protetora carro','capa automotiva',
      'capa fiat','capa gol','capa civic','capa corolla','capa hb20','capa onix','capa palio','capa siena','capa uno','capa sandero','capa kwid','capa polo','capa voyage','capa tracker','capa t-cross',
      // bancos e interiores
      'capa banco carro','capa banco auto','banco carro','capa banco automotivo','bobina capa banco','capa plastica banco','capa descartavel banco','capa banco descartavel','capa couro carro','capas banco couro','capa banco couro',
      'capa automotivo','tapete carro','tapete borracha','tapete emborrachado','tapete cacamba','tapete caçamba','tapete pvc','jogo de tapete','jogo tapete','tapete inteiriço','tapete traseiro','tapete dianteiro',
      // organizadores e acessórios internos
      'organizador carro','caixa porta malas','organizador porta malas','porta malas carro','gancho carro','gancho banco carro','gancho sacola carro','suporte sacola carro',
      // tags e pedágios
      'tag sem parar','tag veloe','tag automática','tag autoviagem','tag condutor','tag veicular','tag pedágio','tag pedagio','sem parar','veloe',
      // uber / apps / motoristas
      'placa uber','placa 99','placa ifood motorista','placa motorista','identificador uber','identificador motorista','adesivo uber','adesivo motorista aplicativo',
      // decoração e tuning
      'lagartixa carro','lagartixa gecko','gecko carro','acessorio decorativo carro','enfeite carro','enfeite retrovisor',
      // elétrica / iluminação
      'aplique cromado','aplique moldura','friso lateral','friso cromado','parachoque','grade dianteira','spoiler','moldura',
      'lampada led carro','lampada led moto','lampada farol','lampada t10','lampada ba9s','lampada t15','placa led cob','kit lampadas','kit farol',
      // suportes veiculares
      'suporte starlink','case starlink','suporte veicular','suporte magnetico carro','suporte ima carro','ventosa veicular','cabo 3m starlink',
      // reboque / segurança
      'correia reboque','correia de reboque','fita reboque','cabo reboque','parafuso tuning','parafuso m6 allen','parafuso inox placa',
      'aplique roda','aplique liga leve','kit aplique',
      // som automotivo
      'coelho caveira caminhao','bravox','auto falante','falante auto','subwoofer automotivo','modulo amplificador auto','modulo auto','caixa som carro','caixa de som automotivo',
      // terminais e conectores
      'terminal conector carro','removedor terminal','extrator terminal','chave terminal','conector automotivo',
      // modelos de carro
      'caminhao','caminhonete','saveiro','hilux','strada','fiorino','corolla','civic ','gol g','hb20','versa ','palio','siena','sandero','rampage rebel','reboque','caçamba','cacamba',
    ] },
    // Esportes & Fitness
    { slug: 'esportes',         keywords: ['estacao de musculacao','estação de musculação','aparelho de ginastica','aparelho ginastica','aparelho de academia','aparelho academia','estacao musculacao','kit musculacao','barra de musculacao','halter ','halteres','anilha ','anilhas','kettlebell','dumbell','dumbbell','banco de supino','banco supino','rack de musculacao','polia fitness','corda de pular','corda battle','battle rope','bola medicinal','medicine ball','prancha abdominal','roda abdominal','rolo abdominal','colchonete','tapete yoga','yoga mat','esteira eletrica','esteira elétrica','bicicleta ergometrica','bicicleta ergométrica','bicicleta spinning','eliptico','elíptico','step fitness','step aerobico','resistance band','faixa elastica','bola de futebol','bola de basquete','bola de volei','bola de tenis','raquete de tenis','raquete de padel','luva de boxe','saco de boxe','chuteira ','prancheta natacao','oculos de natacao','capacete bike','capacete ciclismo','tenis de corrida','roupa de academia','bermuda academia','legging ','top fitness'] },
  ]

  const norm = (t: string) => t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()

  const detectCat = (name: string): string => {
    const h = norm(name)
    for (const rule of RULES) {
      for (const kw of rule.keywords) {
        if (h.includes(norm(kw))) return rule.slug
      }
    }
    return 'outros'
  }

  // Atualiza produto por produto (D1 não suporta batch UPDATE com CASE)
  let updated = 0
  let skipped = 0
  const results: { id: number; name: string; category: string; detected: string }[] = []

  for (const prod of products) {
    const detected = detectCat(prod.name || '')
    if (detected === 'outros') { skipped++; continue }

    await DB.prepare(
      `UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(detected, prod.id).run()

    updated++
    results.push({ id: prod.id, name: (prod.name || '').substring(0, 50), category: detected, detected })
  }

  return c.json({
    ok: true,
    total_candidates: products.length,
    updated,
    skipped,
    results,
  })
})

// ── POST /admin/api/categories/sync — Sincroniza product_count ──
// Atualiza categories.product_count com a contagem real de produtos ativos
admin.post('/api/categories/sync', async (c) => {
  const { DB } = c.env

  // Busca contagens reais por slug
  const { results: counts } = await DB.prepare(`
    SELECT category as slug, COUNT(*) as cnt
    FROM products
    WHERE is_active = 1 AND category IS NOT NULL AND category != '' AND category != 'outros'
    GROUP BY category
  `).all<{ slug: string; cnt: number }>()

  if (counts.length === 0) {
    return c.json({ ok: true, updated: 0, message: 'Nenhum produto com categoria' })
  }

  // Atualiza cada categoria individualmente (D1 não suporta UPDATE com VALUES clause)
  let updated = 0
  for (const row of counts) {
    const res = await DB.prepare(
      `UPDATE categories SET product_count = ? WHERE slug = ?`
    ).bind(row.cnt, row.slug).run()
    if (res.meta.changes > 0) updated++
  }

  // Zera categorias sem produtos
  await DB.prepare(`
    UPDATE categories SET product_count = 0
    WHERE slug NOT IN (
      SELECT DISTINCT category FROM products
      WHERE is_active = 1 AND category IS NOT NULL AND category != '' AND category != 'outros'
    )
  `).run()

  return c.json({
    ok: true,
    updated,
    total_slugs: counts.length,
    message: `${updated} categorias atualizadas`,
  })
})

// ── PATCH /admin/api/categories/:id — Editar categoria ───
admin.patch('/api/categories/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any
  const { name, icon, is_active, sort_order } = body

  await DB.prepare(`
    UPDATE categories SET
      name       = COALESCE(?, name),
      icon       = COALESCE(?, icon),
      is_active  = COALESCE(?, is_active),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).bind(name ?? null, icon ?? null, is_active ?? null, sort_order ?? null, id).run()

  return c.json({ ok: true })
})

// ── Página HTML do Admin (SPA) ────────────────────────────
admin.get('*', async (c) => {
  const path = new URL(c.req.url).pathname
  return c.html(renderAdminSPA())
})

// ── Helpers ───────────────────────────────────────────────
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(ip + 'salt_admin')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
}

function renderAdminSPA(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — KainowRadar</title>
  <link href="/static/tailwind.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
  <style>
    body { font-family: 'Inter', sans-serif; }
    .sidebar-link { @apply flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-100 hover:bg-white/15 hover:text-white transition-all cursor-pointer; }
    .sidebar-link.active { @apply bg-blue-600/90 text-white shadow-sm; }
    .stat-card { @apply bg-white rounded-2xl p-5 border border-slate-100 shadow-sm; }
    .table-th { @apply px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide bg-slate-50; }
    .table-td { @apply px-4 py-3 text-sm text-slate-700 border-b border-slate-50; }
    .badge-green { @apply inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700; }
    .badge-red   { @apply inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700; }
    .badge-yellow{ @apply inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700; }
    .badge-blue  { @apply inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700; }
    .btn-primary { @apply bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all; }
    .btn-secondary { @apply bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-xl transition-all; }
    .btn-danger { @apply bg-red-50 hover:bg-red-100 text-red-600 text-sm font-medium px-3 py-1.5 rounded-lg transition-all; }
    .btn-success { @apply bg-green-50 hover:bg-green-100 text-green-600 text-sm font-medium px-3 py-1.5 rounded-lg transition-all; }
    .input { @apply w-full px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent; }
    .section { @apply space-y-6; }
    #toast { position:fixed;bottom:1.5rem;right:1.5rem;padding:.75rem 1.25rem;background:#1e293b;color:white;border-radius:.75rem;font-size:.875rem;font-weight:500;z-index:9999;opacity:0;transform:translateY(8px);transition:all .25s;pointer-events:none; }
    #toast.show { opacity:1;transform:translateY(0); }
    .skeleton { background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:.5rem; }
    @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    .toggle-switch { position:relative;display:inline-block;width:44px;height:24px; }
    .toggle-switch input { opacity:0;width:0;height:0; }
    .toggle-slider { position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:24px;transition:.3s; }
    .toggle-slider:before { position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s; }
    input:checked + .toggle-slider { background:#2563eb; }
    input:checked + .toggle-slider:before { transform:translateX(20px); }
    .modal-backdrop { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50;display:flex;align-items:center;justify-content:center; }
    .modal { background:white;border-radius:1.25rem;padding:1.5rem;width:100%;max-width:500px;box-shadow:0 25px 60px rgba(0,0,0,.2); }
  </style>
</head>
<body class="bg-slate-50 antialiased">

<!-- ── Login Screen ─────────────────────────────────────── -->
<div id="login-screen" class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-blue-900 p-4">
  <div class="w-full max-w-sm">
    <div class="text-center mb-8">
      <div class="flex items-center justify-center gap-3 mb-3">
        <div class="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl flex items-center justify-center shadow-xl">
          <svg viewBox="0 0 24 24" class="w-9 h-9" fill="white" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 3h3v7.5l7-7.5h4L11 11l8.5 10H15l-7-8.5V21H5V3z"/>
          </svg>
        </div>
      </div>
      <h1 class="text-2xl font-black text-white tracking-tight"><span class="text-white">Kainow</span><span class="text-yellow-300">Radar</span></h1>
      <p class="text-slate-400 text-sm mt-1">Painel Administrativo</p>
    </div>
    <div class="bg-white rounded-2xl p-6 shadow-2xl">
      <h2 class="text-lg font-bold text-slate-800 mb-5">Entrar no painel</h2>
      <div class="space-y-4">

        <!-- Login (email + senha) -->
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1.5">Email</label>
            <input type="email" id="login-email" class="input" placeholder="seu@email.com"
              onkeydown="if(event.key==='Enter') doLogin()">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1.5">Senha</label>
            <div class="relative">
              <input type="password" id="login-password" class="input pr-10" placeholder="••••••••"
                onkeydown="if(event.key==='Enter') doLogin()">
              <button type="button" onclick="togglePwdVisibility('login-password', this)"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors focus:outline-none" tabindex="-1">
                <svg id="eye-login-password" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div id="login-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"></div>
        <button onclick="doLogin()" id="login-btn"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-all text-sm">
          Entrar
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── Admin App ─────────────────────────────────────────── -->
<div id="admin-app" class="hidden min-h-screen flex">

  <!-- Sidebar -->
  <aside id="sidebar" class="w-64 bg-slate-800 min-h-screen flex flex-col fixed left-0 top-0 bottom-0 z-40">
    <!-- Logo -->
    <div class="p-5 border-b border-white/10">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center shadow-lg shrink-0">
          <svg viewBox="0 0 24 24" class="w-6 h-6" fill="white" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 3h3v7.5l7-7.5h4L11 11l8.5 10H15l-7-8.5V21H5V3z"/>
          </svg>
        </div>
        <div>
          <div class="font-black text-sm tracking-tight"><span class="text-white">Kainow</span><span class="text-yellow-300">Radar</span></div>
          <div class="text-slate-400 text-xs">Painel Admin</div>
        </div>
      </div>
    </div>

    <!-- Nav -->
    <nav class="flex-1 p-3 space-y-1">
      <div onclick="showSection('dashboard')" class="sidebar-link active" data-section="dashboard">
        <span class="text-lg">📊</span> Dashboard
      </div>
      <div class="px-3 pt-4 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Catálogo</div>
      <!-- top-deals: oculto do menu -->
      <div onclick="showSection('products')" class="sidebar-link" data-section="products">
        <span class="text-lg">📦</span> Produtos
      </div>
      <div onclick="showSection('offers')" class="sidebar-link" data-section="offers">
        <span class="text-lg">💰</span> Ofertas
      </div>
      <div onclick="showSection('categories')" class="sidebar-link" data-section="categories">
        <span class="text-lg">🗂️</span> Categorias
      </div>
      <div class="px-3 pt-4 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Integrações</div>
      <!-- ml-import, ml-categories, ml-search, ml-crawl, ml-linkbuilder ocultos do menu -->
      <div onclick="showSection('feed-ingestion')" class="sidebar-link" data-section="feed-ingestion">
        <span class="text-lg">📥</span> Feed Ingestion
      </div>
      <div onclick="showSection('api-keys')" class="sidebar-link" data-section="api-keys">
        <span class="text-lg">🔑</span> API Keys
      </div>
      <div onclick="showSection('stores')" class="sidebar-link" data-section="stores">
        <span class="text-lg">🏪</span> Lojas Parceiras
      </div>
      <div onclick="showSection('api-configs')" class="sidebar-link" data-section="api-configs">
        <span class="text-lg">🔌</span> APIs & Secrets
      </div>
      <div class="px-3 pt-4 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Publicação</div>
      <div onclick="showSection('social')" class="sidebar-link" data-section="social">
        <span class="text-lg">📣</span> Social Media
      </div>
      <div onclick="showSection('editorial')" class="sidebar-link" data-section="editorial">
        <span class="text-lg">🤖</span> IA Editorial
      </div>
      <div onclick="showSection('footer')" class="sidebar-link" data-section="footer">
        <span class="text-lg">🦶</span> Rodapé
      </div>
      <div class="px-3 pt-4 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Análise</div>
      <div onclick="showSection('analytics')" class="sidebar-link" data-section="analytics">
        <span class="text-lg">📈</span> Analytics
      </div>
      <div onclick="showSection('users')" class="sidebar-link" data-section="users">
        <span class="text-lg">👥</span> Usuários
      </div>
    </nav>

    <!-- Footer sidebar -->
    <div class="p-4 border-t border-white/10">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold text-slate-200">admin</div>
        <button onclick="doLogout()" class="text-xs text-slate-400 hover:text-red-400 transition-colors font-semibold">Sair →</button>
      </div>
      <a href="/" target="_blank" class="mt-2 block text-xs text-slate-400 hover:text-white transition-colors font-medium">
        ← Ver site público
      </a>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 ml-64 min-h-screen">
    <!-- Top bar -->
    <header class="bg-white border-b border-slate-100 sticky top-0 z-30 px-6 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 id="page-title" class="text-lg font-bold text-slate-900">Dashboard</h2>
          <p id="page-subtitle" class="text-sm text-slate-500">Visão geral do sistema</p>
        </div>
        <div class="flex items-center gap-3">
          <div id="sync-status" class="hidden items-center gap-2 text-sm text-green-600 bg-green-50 px-3 py-1.5 rounded-lg">
            <span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Sincronizando...
          </div>
          <button onclick="loadSection(App.currentSection)" class="btn-secondary">↻ Atualizar</button>
        </div>
      </div>
    </header>

    <!-- Content Area -->
    <div id="content-area" class="p-6"></div>
  </main>
</div>

<!-- Toast -->
<div id="toast"></div>

<!-- Modal container -->
<div id="modal-container"></div>

<\/script>
<script src="/static/admin-spa.js?v=20260519a"><\/script>
</body>
</html>`
}

// ── POST /api/cron/shopee-refresh ─────────────────────────────────────────
// Atualiza preço, imagem, título e link curto de todas as offers Shopee.
//
// Estratégia (em ordem de prioridade):
//   1. GraphQL Afiliados (se AppId+Secret configurados) → preço real + link curto novo
//   2. facebookexternalhit no affiliate_url (link curto) →
//      og:title, og:image, al:web:url (shop_id/item_id)
//      Depois API interna /api/v4/pdp/get_pc com shop_id+item_id → preço real
//
// O affiliate_url gravado é sempre o link curto (s.shopee.com.br/xxx)
// para o cliente clicar e ir direto para o produto.
admin.post('/api/cron/shopee-refresh', async (c) => {
  const DB = (c.env as any).DB as D1Database

  const cronSecret = (c.env as any).CRON_SECRET as string | undefined
  if (cronSecret) {
    const auth  = c.req.header('Authorization') || ''
    const token = auth.replace(/^Bearer\s+/i, '').trim()
    if (token !== cronSecret) return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  const t0 = Date.now()

  // Busca offers Shopee ativas — precisa de affiliate_url (link curto)
  const { results: offers } = await DB.prepare(`
    SELECT o.id, o.external_id, o.external_sku, o.affiliate_url,
           o.shopee_product_url, o.price, o.product_id
    FROM   offers o
    WHERE  o.store_id = 4
      AND  o.is_active = 1
      AND  o.affiliate_url IS NOT NULL
    ORDER  BY o.last_updated ASC
    LIMIT  50
  `).all<any>()

  if (!offers || offers.length === 0)
    return c.json({ ok: true, message: 'Nenhuma offer Shopee encontrada', updated: 0 })

  // Credenciais GraphQL (opcional)
  const cfg = await DB.prepare(
    `SELECT api_key, extra_json FROM api_configs WHERE id = 'shopee-afiliados'`
  ).first<any>().catch(() => null)
  const shopeeAppId  = cfg?.api_key || ''
  const shopeeSecret = cfg ? (JSON.parse(cfg.extra_json || '{}').secret || '') : ''
  const useGraphQL   = !!(shopeeAppId && shopeeSecret)

  // ── Helper 1: GraphQL Afiliados ──────────────────────────────
  async function fetchViaGraphQL(itemId: string): Promise<{
    price: number | null; image: string | null; title: string | null; offerLink: string | null
  }> {
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const query   = `{ productOfferV2(itemId: ${itemId}, page: 1, limit: 1) { nodes { itemId productName imageUrl priceMin priceMax offerLink } } }`
      const payload = JSON.stringify({ query })
      const sigBuf  = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(shopeeAppId + String(timestamp) + payload + shopeeSecret))
      const sig = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2,'0')).join('')

      const res = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `SHA256 Credential=${shopeeAppId}, Timestamp=${timestamp}, Signature=${sig}`,
        },
        body: payload,
      })
      if (!res.ok) return { price: null, image: null, title: null, offerLink: null }
      const json: any = await res.json()
      const node = json?.data?.productOfferV2?.nodes?.[0]
      if (!node) return { price: null, image: null, title: null, offerLink: null }
      const rawPrice = node.priceMin ?? node.priceMax ?? null
      const v = rawPrice ? parseFloat(String(rawPrice).replace(',', '.')) : NaN
      return {
        price:     (!isNaN(v) && v > 0) ? v : null,
        image:     node.imageUrl    || null,
        title:     node.productName || null,
        offerLink: node.offerLink   || null,
      }
    } catch { return { price: null, image: null, title: null, offerLink: null } }
  }

  // ── Helper 2: Link curto → og:title + og:image + shop_id/item_id ──
  // O facebookexternalhit faz a Shopee renderizar metas SSR no link curto.
  // al:web:url contém a URL com shop_id e item_id embutidos.
  async function fetchViaShortLink(shortUrl: string): Promise<{
    title: string | null; image: string | null; shopId: string | null; itemId: string | null
  }> {
    try {
      const r = await fetch(shortUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent':      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept':          'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      })
      if (!r.ok) return { title: null, image: null, shopId: null, itemId: null }
      const html = await r.text()

      // og:title
      const titleM = html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                  ?? html.match(/content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
      const title = titleM ? titleM[1].replace(/\s*\|\s*Shopee.*$/i, '').trim() : null

      // og:image
      const imgM = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                ?? html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      const image = imgM ? imgM[1].trim() : null

      // al:web:url → shop_id e item_id (ex: /opaanlp/1429781525/23394276680)
      const alM = html.match(/property=["']al:web:url["'][^>]+content=["']([^"']+)["']/i)
               ?? html.match(/content=["']([^"']+)["'][^>]+property=["']al:web:url["']/i)
      let shopId: string | null = null, itemId: string | null = null
      if (alM) {
        const idsM = alM[1].match(/\/(\d{6,})\/(\d{6,})/)
        if (idsM) { shopId = idsM[1]; itemId = idsM[2] }
      }

      return { title, image, shopId, itemId }
    } catch { return { title: null, image: null, shopId: null, itemId: null } }
  }

  // ── Helper 3: API interna Shopee com shop_id + item_id ───────
  // Preço vem em centavos × 100000 (ex: 2990000 = R$29,90)
  async function fetchPriceViaAPI(shopId: string, itemId: string): Promise<number | null> {
    try {
      const r = await fetch(
        `https://shopee.com.br/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`,
        { headers: {
            'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept':       'application/json',
            'Referer':      `https://shopee.com.br/product/${shopId}/${itemId}`,
            'X-API-SOURCE': 'pc',
        }}
      )
      if (!r.ok) return null
      const d: any = await r.json()
      if (d.error && d.error !== 0) return null
      const item = d?.data?.item ?? d?.item ?? {}
      const raw  = item.price_min ?? item.price ?? null
      if (raw === null) return null
      const v = Math.round(Number(raw) / 100000 * 100) / 100
      return (v > 0 && v < 1_000_000) ? v : null
    } catch { return null }
  }

  // ── Processamento ────────────────────────────────────────────
  const log: any[] = []
  let updated = 0, failed = 0, nodata = 0

  const BATCH = 5
  for (let i = 0; i < offers.length; i += BATCH) {
    const batch = offers.slice(i, i + BATCH)
    await Promise.all(batch.map(async (offer: any) => {
      try {
        let price:    number | null = null
        let image:    string | null = null
        let title:    string | null = null
        let shortUrl: string | null = offer.affiliate_url || null  // link curto original

        // 1. GraphQL Afiliados (se credenciais disponíveis)
        if (useGraphQL && offer.external_id) {
          const gql = await fetchViaGraphQL(offer.external_id)
          price    = gql.price
          image    = gql.image
          title    = gql.title
          if (gql.offerLink) shortUrl = gql.offerLink  // link curto renovado pela API
        }

        // 2. facebookexternalhit no link curto → título + imagem + shop_id/item_id
        if ((price === null || image === null || title === null) && offer.affiliate_url) {
          const meta = await fetchViaShortLink(offer.affiliate_url)
          if (title === null && meta.title) title = meta.title
          if (image === null && meta.image) image = meta.image

          // 3. Com shop_id + item_id do al:web:url → busca preço via API interna
          if (price === null && meta.shopId && meta.itemId) {
            price = await fetchPriceViaAPI(meta.shopId, meta.itemId)

            // Atualiza external_sku (shop_id) e shopee_product_url se vieram do al:web:url
            if (meta.shopId && !offer.external_sku) {
              await DB.prepare(`UPDATE offers SET external_sku = ?, shopee_product_url = ? WHERE id = ?`)
                .bind(meta.shopId, `https://shopee.com.br/product/${meta.shopId}/${meta.itemId}`, offer.id).run()
            }
          }
        }

        if (price === null) {
          nodata++
          log.push({ id: offer.id, status: 'no-data', title, image: !!image })
          // Mesmo sem preço, salva título e imagem se vieram
          if (title || image) {
            await DB.prepare(`UPDATE offers SET
              title     = COALESCE(?, title),
              image_url = COALESCE(?, image_url),
              last_updated = CURRENT_TIMESTAMP
            WHERE id = ?`).bind(title, image, offer.id).run()
          }
          return
        }

        // Atualiza offer (price + image + title + affiliate_url se renovado pela API)
        await DB.prepare(`
          UPDATE offers
          SET price         = COALESCE(?, price),
              image_url     = COALESCE(?, image_url),
              title         = COALESCE(?, title),
              affiliate_url = COALESCE(?, affiliate_url),
              last_updated  = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, image, title, shortUrl, offer.id).run()

        // Atualiza produto (best_price + imagem se melhorou)
        if (price !== null) {
          await DB.prepare(`
            UPDATE products
            SET best_price = COALESCE(?, best_price),
                image_url  = COALESCE(?, image_url),
                name       = COALESCE(?, name)
            WHERE id = ? AND (best_price IS NULL OR ? <= best_price)
          `).bind(price, image, title, offer.product_id, price).run()
        }

        updated++
        log.push({
          id:     offer.id,
          status: 'updated',
          price,
          via:    useGraphQL && offer.external_id ? 'graphql'
                : offer.external_sku ? 'shopee-api'
                : 'html',
          url:    offer.shopee_product_url,
        })
      } catch (e: any) {
        failed++
        log.push({ id: offer.id, status: 'error', error: (e as any)?.message })
      }
    }))

    if (i + BATCH < offers.length) {
      await new Promise(res => setTimeout(res, 500))
    }
  }

  return c.json({
    ok:         true,
    total:      offers.length,
    updated,
    failed,
    nodata,
    graphql:    useGraphQL,
    duration_ms: Date.now() - t0,
    timestamp:  new Date().toISOString(),
    log,
  })
})

export default admin