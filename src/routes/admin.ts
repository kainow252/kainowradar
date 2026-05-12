// ============================================================
// ROUTES: Admin — Painel Administrativo Completo
// Protegido por Bearer token (ADMIN_SECRET via wrangler secret)
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'
import { CacheManager } from '../lib/cache'
import ml from './ml'

type AdminBindings = Bindings & {
  ADMIN_SECRET?: string
  ML_APP_ID?: string
  ML_SECRET?: string
  GECKO_API_KEY?: string
}

const admin = new Hono<{ Bindings: AdminBindings }>()

// ── Middleware de autenticação ────────────────────────────
// Rotas públicas (não precisam de token)
admin.post('/api/login', async (c) => {
  const { DB } = c.env
  const { password } = await c.req.json().catch(() => ({ password: '' }))
  const secret = (c.env as any).ADMIN_SECRET || 'admin123'

  if (!password || password !== secret) {
    return c.json({ error: 'Senha incorreta' }, 401)
  }

  // Gera token de sessão
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const ipHash = await hashIP(c.req.header('CF-Connecting-IP') || '0')
  const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString() // 8h

  await DB.prepare(`
    INSERT INTO admin_sessions (token, admin_user, ip_hash, user_agent, expires_at)
    VALUES (?, 'admin', ?, ?, ?)
  `).bind(token, ipHash, c.req.header('User-Agent') || '', expiresAt).run()

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

// ── GET /admin/api/top-deals — Query otimizada GROUP BY MIN ─
admin.get('/api/top-deals', async (c) => {
  const { DB, CACHE } = c.env
  const limit = Math.min(50, parseInt(c.req.query('limit') || '20'))
  const category = c.req.query('category') || ''
  const cache = new CacheManager(CACHE)
  const cacheKey = `admin:top-deals:${category}:${limit}`
  const cached = await cache.get(cacheKey)
  if (cached) return c.json(cached)

  // A QUERY MESTRA: GROUP BY p.id + MIN(price) garante 1 linha por produto
  // O subquery correlacionado pega os dados da oferta mais barata
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
      MIN(o.price)                  AS lowest_price,
      o2.original_price             AS original_price,
      o2.discount_percent           AS discount_percent,
      o2.free_shipping              AS free_shipping,
      o2.checkout_url               AS checkout_url,
      o2.affiliate_url              AS affiliate_url,
      s.name                        AS store_name,
      s.slug                        AS store_slug,
      s.logo_url                    AS store_logo,
      o2.last_updated               AS price_updated_at
    FROM products p
    JOIN offers o  ON o.product_id = p.id AND o.is_active = 1 AND o.in_stock = 1
    JOIN offers o2 ON o2.product_id = p.id
      AND o2.price = (SELECT MIN(o3.price) FROM offers o3 WHERE o3.product_id = p.id AND o3.is_active = 1 AND o3.in_stock = 1)
      AND o2.is_active = 1 AND o2.in_stock = 1
    JOIN stores s  ON s.id = o2.store_id AND s.is_active = 1
    WHERE p.is_active = 1
    ${catFilter}
    GROUP BY p.id
    ORDER BY lowest_price ASC
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

// ── DELETE /admin/api/products/:id — Desativar produto ────
admin.delete('/api/products/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  await DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
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
      (SELECT COUNT(*) FROM offers WHERE store_id = s.id AND is_active = 1) as offer_count,
      (SELECT MIN(price) FROM offers WHERE store_id = s.id AND is_active = 1) as min_price,
      (SELECT MAX(price) FROM offers WHERE store_id = s.id AND is_active = 1) as max_price
    FROM stores s ORDER BY s.name ASC
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
    { id: 'awin',        name: 'Awin',                     network: 'awin',               commission_rate: 5.0  },
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

// ── POST /admin/api/cron/run — Executa scraper ML manualmente ──
admin.post('/api/cron/run', async (c) => {
  const { DB, CACHE } = c.env
  const appId  = (c.env as any).ML_APP_ID || ''
  const secret = (c.env as any).ML_SECRET  || ''

  try {
    const { runMLPriceScraper } = await import('../lib/mlScraper')
    const stats = await runMLPriceScraper(DB, CACHE, appId, secret)
    return c.json({ ok: true, stats, ran_at: new Date().toISOString() })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500)
  }
})

// ── GET /admin/api/cron/status — Último log do cron ────────────
admin.get('/api/cron/status', async (c) => {
  const { CACHE } = c.env
  const [lastRun, lastError] = await Promise.all([
    CACHE.get('cron_last_run',   'json').catch(() => null),
    CACHE.get('cron_last_error', 'json').catch(() => null),
  ])
  return c.json({ last_run: lastRun, last_error: lastError })
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
// Link final: permalink?matt_word=PUBLISHER_ID&matt_tool=38524122&forceInApp=true
admin.post('/api/affiliate-bot/run-all', async (c) => {
  const { DB, CACHE } = c.env
  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '38524122'
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

// ── POST /admin/api/affiliate-bot/import-search ──────────
// Busca produtos no ML por keyword via /products/search
// Estratégia de preço:
//   1. Se há children_ids → /items/{child_id} com token OAuth (anúncios filho)
//   2. Se status=active e children vazio → /products/{id}/items (catalog items)
//   3. Fallback: usa permalink de catálogo sem preço (para afiliados)
// NOTA: /sites/MLB/search está bloqueado (403) para IPs de datacenter Cloudflare
admin.post('/api/affiliate-bot/import-search', async (c) => {
  const { DB, CACHE } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const query    = (body.query || '').trim()
  const category = (body.category || 'outros').trim()
  const limit    = Math.min(Math.max(parseInt(body.limit) || 10, 1), 20)

  if (!query) return c.json({ error: 'query obrigatória' }, 400)

  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '38524122'
  const ML_API       = 'https://api.mercadolibre.com'
  const appId        = (c.env as any).ML_APP_ID || '3098423019766450'
  const secret       = (c.env as any).ML_SECRET  || ''

  // ── 1. Pega token OAuth (tenta renovar se necessário) ────
  let token: string | null = null
  let token_source = 'none'

  const oauthToken = await CACHE?.get('ml_access_token').catch(() => null)
  if (oauthToken) { token = oauthToken; token_source = 'oauth' }

  if (!token && secret) {
    // Tenta refresh_token
    const refreshToken = await CACHE?.get('ml_refresh_token').catch(() => null)
    if (refreshToken) {
      try {
        const tr = await fetch(`${ML_API}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, client_secret: secret, refresh_token: refreshToken }),
        })
        if (tr.ok) {
          const td: any = await tr.json()
          if (td.access_token) {
            token = td.access_token; token_source = 'refresh'
            await CACHE?.put('ml_access_token', token!, { expirationTtl: td.expires_in || 21600 }).catch(() => {})
            if (td.refresh_token) await CACHE?.put('ml_refresh_token', td.refresh_token, { expirationTtl: 86400 * 30 }).catch(() => {})
          }
        }
      } catch {}
    }
  }

  if (!token && secret) {
    // client_credentials
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

  const headers: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0', 'Accept': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  // ── 2. Busca via /products/search → catalog_product_ids ──
  // Pede 4× limit para compensar os que ficarem sem preço
  let mlResultsRaw: any[] = []
  let search_status = 0
  try {
    const fetchLimit = Math.min(limit * 4, 50)
    const r = await fetch(
      `${ML_API}/products/search?site_id=MLB&q=${encodeURIComponent(query)}&limit=${fetchLimit}`,
      { headers }
    )
    search_status = r.status
    if (r.ok) mlResultsRaw = (await r.json().catch(() => ({}))).results || []
  } catch {}

  if (mlResultsRaw.length === 0) {
    return c.json({
      ok: false,
      error: `Nenhum resultado no /products/search (HTTP ${search_status}). Verifique o token OAuth em /admin → Importar ML.`,
      token_source,
      tip: 'Se o token expirou, use o botão "Reconectar OAuth" no painel Importar ML.',
    }, 400)
  }

  // Ordena: active primeiro, depois os que têm children_ids
  const mlResults = [
    ...mlResultsRaw.filter((r: any) => r.status === 'active' && (r.children_ids?.length || 0) > 0),
    ...mlResultsRaw.filter((r: any) => r.status === 'active' && !(r.children_ids?.length)),
    ...mlResultsRaw.filter((r: any) => r.status !== 'active' && (r.children_ids?.length || 0) > 0),
    ...mlResultsRaw.filter((r: any) => r.status !== 'active' && !(r.children_ids?.length)),
  ].slice(0, limit * 3)

  // ── 3. Helpers de preço ───────────────────────────────────

  // Seleciona o melhor item de uma lista (mais barato, ativo, com preço)
  function pickBest(items: any[], catalogId: string) {
    const pool = items.filter((x: any) => x.price && x.status !== 'closed' && x.status !== 'paused')
    if (pool.length === 0) return null
    const best = pool.sort((a: any, b: any) => (a.price || 0) - (b.price || 0))[0]
    return {
      price:          best.price as number,
      original_price: (best.original_price || null) as number | null,
      thumbnail:      (best.thumbnail || null) as string | null,
      permalink:      (best.permalink || `https://www.mercadolivre.com.br/p/${catalogId}`) as string,
      in_stock:       best.status !== 'closed' && best.status !== 'paused',
    }
  }

  // Estratégia A: /items/{child_id} — funciona com token OAuth para anúncios ativos
  async function tryChildItem(childId: string, catalogId: string) {
    try {
      const r = await fetch(`${ML_API}/items/${childId}?attributes=id,title,price,original_price,status,thumbnail,permalink`, { headers })
      if (!r.ok) return null
      const b: any = await r.json().catch(() => null)
      if (!b?.price || b.status === 'closed') return null
      return {
        price:          b.price as number,
        original_price: (b.original_price || null) as number | null,
        thumbnail:      (b.thumbnail || null) as string | null,
        permalink:      (b.permalink || `https://www.mercadolivre.com.br/p/${catalogId}`) as string,
        in_stock:       b.status !== 'closed' && b.status !== 'paused',
      }
    } catch { return null }
  }

  // Estratégia B: /products/{id}/items — funciona para catálogos com sellers ativos
  async function tryCatalogItems(catalogId: string) {
    try {
      const r = await fetch(`${ML_API}/products/${catalogId}/items?limit=5`, { headers })
      if (!r.ok) return null
      const d: any = await r.json().catch(() => null)
      return pickBest(d?.results || d?.items || [], catalogId)
    } catch { return null }
  }

  // Estratégia C: multi-get children_ids (eficiente para múltiplos filhos)
  async function tryMultiGet(childIds: string[], catalogId: string) {
    if (childIds.length === 0) return null
    try {
      const r = await fetch(
        `${ML_API}/items?ids=${childIds.slice(0, 10).join(',')}&attributes=id,title,price,original_price,status,thumbnail,permalink`,
        { headers }
      )
      if (!r.ok) return null
      const data: any[] = await r.json().catch(() => [])
      const items = (Array.isArray(data) ? data : [])
        .filter((x: any) => x.code === 200)
        .map((x: any) => x.body)
      return pickBest(items, catalogId)
    } catch { return null }
  }

  // Orquestra estratégias A → B → C
  async function fetchPrice(catalogId: string, childrenIds: string[]): Promise<{
    price: number | null, original_price: number | null,
    thumbnail: string | null, permalink: string,
    in_stock: boolean, strategy: string,
  }> {
    const fallback = {
      price: null, original_price: null, thumbnail: null,
      permalink: `https://www.mercadolivre.com.br/p/${catalogId}`,
      in_stock: false, strategy: 'none',
    }

    // A: tenta cada child_id individualmente (geralmente 1-2 filhos)
    for (const cid of childrenIds.slice(0, 3)) {
      const r = await tryChildItem(cid, catalogId)
      if (r) return { ...r, strategy: `child_item:${cid}` }
      await new Promise(resolve => setTimeout(resolve, 80))
    }

    // B: /products/{id}/items — funciona quando há sellers ativos no catálogo
    const rb = await tryCatalogItems(catalogId)
    if (rb) return { ...rb, strategy: 'catalog_items' }

    // C: multi-get de todos os children de uma vez
    if (childrenIds.length > 3) {
      const rc = await tryMultiGet(childrenIds, catalogId)
      if (rc) return { ...rc, strategy: 'multi_get' }
    }

    return fallback
  }

  // ── 4. Store ID do Mercado Livre ──────────────────────────
  const mlStore = await DB.prepare(
    `SELECT id FROM stores WHERE slug = 'mercadolivre' AND is_active = 1 LIMIT 1`
  ).first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  // ── 5. Detecta categoria por palavras-chave ───────────────
  function detectCategory(title: string, fallback: string): string {
    if (fallback && fallback !== 'outros') return fallback
    const t = title.toLowerCase()
    if (/iphone|galaxy|smartphone|celular|motorola|xiaomi|redmi/.test(t)) return 'smartphones'
    if (/notebook|macbook|laptop|ultrabook/.test(t)) return 'notebooks'
    if (/smart tv|televisor|\btv\b|qled|oled|led [0-9]/.test(t)) return 'tv'
    if (/fone|headphone|airpods|speaker|caixa de som|headset/.test(t)) return 'audio'
    if (/playstation|xbox|nintendo|\bgame\b|console/.test(t)) return 'games'
    if (/câmera|camera|drone|gopro/.test(t)) return 'cameras'
    if (/tablet|\bipad\b/.test(t)) return 'tablets'
    if (/geladeira|fogão|máquina de lavar|microondas|ar condicionado/.test(t)) return 'eletrodomesticos'
    if (/perfume|eau de|colônia/.test(t)) return 'perfumes'
    if (/relógio|smartwatch|watch/.test(t)) return 'smartwatches'
    return 'outros'
  }

  // ── 6. Processa cada resultado ────────────────────────────
  const imported: any[] = []
  const skipped:  any[] = []
  const errors:   any[] = []

  for (const item of mlResults) {
    if (imported.length >= limit) break
    try {
      const mlId  = (item.id || '').toString()
      const title = item.name || mlId
      const brand = item.brand || ''
      const cat   = detectCategory(title, category)
      const childrenIds: string[] = Array.isArray(item.children_ids) ? item.children_ids : []
      const staticThumb = item.pictures?.[0]?.url || null

      if (!mlId) { skipped.push({ title, reason: 'sem ID' }); continue }

      // Verifica se o produto já existe ANTES de buscar preço (economiza chamadas)
      const slugBase = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        .substring(0, 80) + '-' + mlId.toLowerCase()

      const existing = await DB.prepare(
        `SELECT id, best_price FROM products WHERE ml_item_id = ? LIMIT 1`
      ).bind(mlId).first<{ id: number; best_price: number | null }>()

      // ── Busca preço ───────────────────────────────────────
      const priceData = await fetchPrice(mlId, childrenIds)
      await new Promise(r => setTimeout(r, 150))

      const price     = priceData.price
      const origPrice = priceData.original_price
      const thumbnail = priceData.thumbnail || staticThumb

      // Gera permalink de catálogo + link de afiliado
      const catalogPermalink = `https://www.mercadolivre.com.br/p/${mlId}`
      const itemPermalink    = priceData.permalink || catalogPermalink
      const affiliate_url    = `${itemPermalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`

      if (existing) {
        // Atualiza preço e afiliado se já existir
        await DB.prepare(`
          UPDATE products SET
            affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP,
            best_price = COALESCE(?, best_price),
            image_url = COALESCE(NULLIF(image_url,''), ?),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(affiliate_url, price, thumbnail, existing.id).run()
        skipped.push({
          title, reason: 'já existe — atualizado', id: existing.id,
          price_before: existing.best_price, price_after: price,
        })
        continue
      }

      if (!price) {
        // Sem preço: importa com preço null (pode ser atualizado pelo cron)
        // Usa permalink de catálogo como affiliate_url
        const ins = await DB.prepare(`
          INSERT INTO products
            (name, slug, brand, category, description, image_url,
             ml_item_id, affiliate_url, best_price, best_store_id,
             offer_count, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, NULL, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(title, slugBase, brand, cat, thumbnail, mlId, affiliate_url, storeId).run()

        await DB.prepare(`UPDATE categories SET product_count = product_count + 1 WHERE slug = ?`)
          .bind(cat).run().catch(() => {})

        const productId = ins.meta.last_row_id as number
        skipped.push({
          title, reason: 'sem preço — importado sem preço (será atualizado pelo cron)',
          id: productId, ml_id: mlId, strategy: priceData.strategy,
          affiliate_url, children_count: childrenIds.length,
        })
        continue
      }

      // Insere produto com preço
      const ins = await DB.prepare(`
        INSERT INTO products
          (name, slug, brand, category, description, image_url,
           ml_item_id, affiliate_url, affiliate_updated_at,
           best_price, best_store_id, offer_count, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(title, slugBase, brand, cat, thumbnail, mlId, affiliate_url, price, storeId).run()

      const productId = ins.meta.last_row_id as number

      // Cria offer
      const discount  = origPrice && origPrice > price ? Math.round(((origPrice - price) / origPrice) * 100) : 0
      const expiresAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString()
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, original_price,
           discount_percent, free_shipping, in_stock, product_url, image_url, cache_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).bind(productId, storeId, mlId, title, price, origPrice || null, discount,
              priceData.in_stock ? 1 : 0, affiliate_url, thumbnail, expiresAt).run()

      await DB.prepare(`UPDATE categories SET product_count = product_count + 1 WHERE slug = ?`)
        .bind(cat).run().catch(() => {})

      imported.push({
        id: productId, title, price, original_price: origPrice,
        category: cat, affiliate_url, ml_id: mlId,
        thumbnail, in_stock: priceData.in_stock, strategy: priceData.strategy,
      })

    } catch (e: any) {
      errors.push({ title: item.name || '?', error: e?.message || 'exception' })
    }
  }

  const withPrice  = imported.length
  const withoutP   = skipped.filter((s: any) => s.reason?.includes('sem preço')).length
  const updated    = skipped.filter((s: any) => s.reason?.includes('atualizado')).length

  return c.json({
    ok: true,
    token_source,
    search_status,
    summary: {
      found:         mlResultsRaw.length,
      imported:      withPrice,
      imported_no_price: withoutP,
      updated:       updated,
      errors:        errors.length,
    },
    tip: withPrice === 0 && withoutP > 0
      ? 'Produtos importados sem preço. O cron vai buscar preços automaticamente. Ou use /admin → Importar ML → "Importar por URL" para itens específicos com preço garantido.'
      : null,
    imported,
    skipped,
    errors: errors.slice(0, 10),
  })
})

// ── POST /admin/api/affiliate-bot/import-offers ──────────
// Scrapa mercadolivre.com.br/ofertas, extrai o JSON embutido (_n.ctx.r)
// e importa os produtos com link de afiliado — SEM chamar /items/{id}.
// Todo o dados (titulo, preco, imagem, permalink) ja estao no HTML.
// Link afiliado = permalink + ?matt_word=cfegdhabc31955&matt_tool=38524122&forceInApp=true
admin.post('/api/affiliate-bot/import-offers', async (c) => {
  const { DB } = c.env
  const body: any    = await c.req.json().catch(() => ({}))
  const limit        = Math.min(Math.max(parseInt(body.limit) || 54, 1), 54)
  const categoryHint = (body.category || '').trim()
  const dryRun       = !!body.dry_run

  const PUBLISHER_ID = 'cfegdhabc31955'
  const MATT_TOOL    = '38524122'

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
      const existing = await DB.prepare(
        `SELECT id, best_price FROM products WHERE ml_item_id = ? LIMIT 1`
      ).bind(mlId).first<{ id: number; best_price: number | null }>()

      if (existing) {
        await DB.prepare(`
          UPDATE products SET
            best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP,
            image_url  = COALESCE(NULLIF(image_url,''), ?),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, affUrl, imgUrl, existing.id).run()

        skipped.push({
          id: mlId, title: title.slice(0, 50), reason: 'ja existe — preco atualizado',
          price_before: existing.best_price, price_after: price, product_id: existing.id,
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

  const updated = skipped.filter((s: any) => s.reason?.includes('atualizado')).length

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
      imported: imported.length,
      updated,
      skipped:  skipped.length - updated,
      errors:   errors.length,
    },
    imported,
    skipped,
    errors: errors.slice(0, 10),
    tip: imported.length > 0
      ? `${imported.length} produto(s) importado(s) direto da pagina de ofertas do ML!`
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
  const MATT_TOOL    = '38524122'
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

      // Verifica duplicata
      const existing = await DB.prepare(
        `SELECT id FROM products WHERE ml_item_id=? OR slug=? LIMIT 1`
      ).bind(mlId, slug).first<{id:number}>()

      if (existing) {
        await DB.prepare(`
          UPDATE products SET affiliate_url=?, affiliate_updated_at=CURRENT_TIMESTAMP,
            best_price=?, image_url=COALESCE(NULLIF(image_url,''),?), updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(affiliate_url, p.price, p.thumb, existing.id).run()
        skipped.push({ ml_id: mlId, title, reason: 'já existe — preço e afiliado atualizados', id: existing.id })
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

  return c.json({
    ok: true,
    token_source,
    summary: { found: ids.length, imported: imported.length, skipped: skipped.length, errors: errors.length },
    imported,
    skipped,
    errors: errors.slice(0, 10),
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
  const MATT_TOOL    = '38524122'

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
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'sans-serif'] },
          colors: {
            brand: { 50:'#eff6ff', 100:'#dbeafe', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8', 900:'#1e3a8a' }
          }
        }
      }
    }
  <\/script>
  <style>
    body { font-family: 'Inter', sans-serif; }
    .sidebar-link { @apply flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-all cursor-pointer; }
    .sidebar-link.active { @apply bg-white/15 text-white; }
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
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1.5">Senha de acesso</label>
          <input type="password" id="login-password" class="input" placeholder="••••••••"
            onkeydown="if(event.key==='Enter') doLogin()">
        </div>
        <div id="login-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"></div>
        <button onclick="doLogin()" id="login-btn"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-all text-sm">
          Entrar
        </button>
      </div>
      <p class="text-xs text-slate-400 text-center mt-4">
        Senha padrão em dev: <code class="bg-slate-100 px-1.5 py-0.5 rounded">admin123</code>
      </p>
    </div>
  </div>
</div>

<!-- ── Admin App ─────────────────────────────────────────── -->
<div id="admin-app" class="hidden min-h-screen flex">

  <!-- Sidebar -->
  <aside id="sidebar" class="w-64 bg-slate-900 min-h-screen flex flex-col fixed left-0 top-0 bottom-0 z-40">
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
      <div class="px-3 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-widest">Catálogo</div>
      <div onclick="showSection('top-deals')" class="sidebar-link" data-section="top-deals">
        <span class="text-lg">🏷️</span> Top Deals
      </div>
      <div onclick="showSection('products')" class="sidebar-link" data-section="products">
        <span class="text-lg">📦</span> Produtos
      </div>
      <div onclick="showSection('offers')" class="sidebar-link" data-section="offers">
        <span class="text-lg">💰</span> Ofertas
      </div>
      <div class="px-3 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-widest">Integrações</div>
      <div onclick="showSection('stores')" class="sidebar-link" data-section="stores">
        <span class="text-lg">🏪</span> Lojas Parceiras
      </div>
      <div onclick="showSection('api-configs')" class="sidebar-link" data-section="api-configs">
        <span class="text-lg">🔌</span> APIs & Feeds
      </div>
      <div onclick="showSection('queue')" class="sidebar-link" data-section="queue">
        <span class="text-lg">⚡</span> Fila de Preços
      </div>
      <div onclick="showSection('editorial')" class="sidebar-link" data-section="editorial">
        <span class="text-lg">🤖</span> IA Editorial
      </div>
      <div onclick="showSection('footer')" class="sidebar-link" data-section="footer">
        <span class="text-lg">🦶</span> Rodapé do Site
      </div>
      <div onclick="showSection('social')" class="sidebar-link" data-section="social">
        <span class="text-lg">📣</span> Social Media
      </div>
      <div onclick="showSection('affiliate-bot')" class="sidebar-link" data-section="affiliate-bot">
        <span class="text-lg">🤝</span> Bot Afiliados ML
      </div>
      <div onclick="showSection('ml-import')" class="sidebar-link" data-section="ml-import">
        <span class="text-lg">🟡</span> Importar do ML
      </div>
      <div onclick="showSection('affiliate-codes')" class="sidebar-link" data-section="affiliate-codes">
        <span class="text-lg">🔗</span> Códigos Afiliados
      </div>
      <div class="px-3 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-widest">Análise</div>
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
        <div class="text-sm text-slate-400">admin</div>
        <button onclick="doLogout()" class="text-xs text-slate-400 hover:text-red-400 transition-colors">Sair →</button>
      </div>
      <a href="/" target="_blank" class="mt-2 block text-xs text-slate-500 hover:text-slate-300 transition-colors">
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
<script src="/static/admin-spa.js"><\/script>
</body>
</html>`
}

export default admin
