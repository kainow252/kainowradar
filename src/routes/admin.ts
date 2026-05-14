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
  LOMADEE_API_KEY?: string
  AWIN_API_TOKEN?: string
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

  // Tenta descobrir MLB ID a partir de um link curto meli.la
  // via API pública do ML (resolve o item_id no endpoint de redirects, se disponível)
  // Fallback: busca no banco por affiliate_url parecida
  async function lookupMlbFromShortLink(shortUrl: string): Promise<string | null> {
    // Tenta o endpoint de expand do ML (não oficial mas funcional)
    try {
      const apiUrl = `https://api.mercadolibre.com/short-urls?url=${encodeURIComponent(shortUrl)}`
      const r = await fetch(apiUrl, {
        headers: { 'User-Agent': 'KainowRadar/1.0', Accept: 'application/json' },
        redirect: 'follow',
      })
      if (r.ok) {
        const j = await r.json() as any
        const longUrl = j?.resource_id || j?.url || j?.redirect_url || ''
        if (longUrl) return extractMlbId(String(longUrl))
      }
    } catch { /* ignora */ }
    return null
  }

  // ── Processamento ───────────────────────────────────────────

  const results: any[] = []
  let matched = 0, saved = 0, errors = 0, imported = 0

  for (const originalUrl of urls) {
    try {
      const isShort = isShortAffiliateLink(originalUrl)
      const isLong  = isLongMlLink(originalUrl)

      let affiliateUrl: string
      let mlbId: string | null = null

      if (isShort) {
        // Link meli.la já É o link de afiliado — usa direto
        affiliateUrl = originalUrl
        // Tenta descobrir MLB para vincular ao produto
        mlbId = await lookupMlbFromShortLink(originalUrl)
      } else if (isLong) {
        // Link longo → extrai MLB e injeta tracking
        mlbId = extractMlbId(originalUrl)
        affiliateUrl = buildTrackedUrl(originalUrl)
      } else {
        // Link desconhecido — tenta extrair MLB de qualquer forma e usa como está
        mlbId = extractMlbId(originalUrl)
        affiliateUrl = originalUrl
      }

      imported++

      // Busca produto vinculado pelo ml_item_id (se encontrado)
      let product: any = null
      if (mlbId) {
        product = await DB.prepare(
          'SELECT id, name FROM products WHERE ml_item_id = ? LIMIT 1'
        ).bind(mlbId).first<any>()
      }

      if (product) {
        matched++
        await DB.prepare(`
          UPDATE products
          SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(affiliateUrl, product.id).run()
        saved++
      }

      // Log da importação
      await DB.prepare(`
        INSERT INTO ml_affiliate_imports
          (original_url, resolved_url, ml_item_id, affiliate_url,
           product_id, product_name, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        originalUrl,
        isShort ? originalUrl : originalUrl,
        mlbId ?? null,
        affiliateUrl,
        product?.id ?? null,
        product?.name ?? null,
        product ? 'matched' : 'resolved'
      ).run()

      results.push({
        url:          originalUrl,
        affiliate_url: affiliateUrl,
        ml_item_id:   mlbId ?? null,
        status:       product ? 'matched' : 'resolved',
        product_id:   product?.id ?? null,
        product_name: product?.name ?? null,
        type:         isShort ? 'short' : isLong ? 'long' : 'unknown',
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
    total:    urls.length,
    imported,
    matched,
    saved,
    errors,
    results,
  })
})

// ── GET /admin/api/stores/ml/import-history ─────────────────────
// Retorna histórico dos últimos 100 links importados
admin.get('/api/stores/ml/import-history', async (c) => {
  const { DB } = c.env
  const { results } = await DB.prepare(`
    SELECT id, original_url, resolved_url, ml_item_id, affiliate_url,
           product_id, product_name, status, error_msg, imported_at
    FROM ml_affiliate_imports
    ORDER BY imported_at DESC
    LIMIT 100
  `).all<any>()
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
  const store = await DB.prepare(`SELECT id, name, affiliate_network FROM stores WHERE id = ?`).bind(storeId).first<any>()
  if (!store) return c.json({ error: 'Loja não encontrada' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const raw: string = body.links || ''
  if (!raw.trim()) return c.json({ error: 'Nenhum link enviado' }, 400)

  // ── Parser de linhas ─────────────────────────────────────────
  // Cada linha pode ser:
  //   - só URL
  //   - URL | Nome
  //   - URL | Nome | Preço
  //   - URL | Nome | Preço | ImageURL
  //   - CSV: url,name,price,image_url
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

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
  }

  function parseLine(line: string): ParsedItem | null {
    // Tenta separar por | (bloco de texto)
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim())
      const url = parts[0]
      if (!url.startsWith('http')) return null
      return {
        url,
        name: parts[1] || '',
        price: parts[2] ? parseFloat(parts[2].replace(/[^0-9.,]/g, '').replace(',', '.')) || null : null,
        image_url: parts[3] && parts[3].startsWith('http') ? parts[3] : null,
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
      }
    }
    // Só URL
    if (line.startsWith('http')) {
      return { url: line, name: '', price: null, image_url: null }
    }
    return null
  }

  if (dataLines.length === 0) return c.json({ error: 'Nenhuma linha válida encontrada' }, 400)
  if (dataLines.length > 500) return c.json({ error: 'Máximo 500 links por importação' }, 400)

  // ── Processa cada linha ──────────────────────────────────────
  function slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 120)
  }

  const results: any[] = []
  let imported = 0
  let skipped  = 0
  let errors   = 0

  for (const line of dataLines) {
    const item = parseLine(line)
    if (!item) { skipped++; continue }

    const affiliateUrl = item.url
    const name = (item.name || '').trim()
    // Rejeita itens sem nome — o frontend DEVE fornecer o nome antes de salvar
    if (!name) {
      results.push({ url: affiliateUrl, name: '', status: 'erro', error: 'Nome obrigatório' })
      errors++
      continue
    }

    const price   = item.price ?? 0
    const imgUrl  = item.image_url || null
    const slug    = slugify(name) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)
    const extId   = 'import-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)

    try {
      // 1) Cria o produto se não existir (ou cria novo se sem nome único)
      let productId: number | null = null

      // Tenta achar oferta existente pelo affiliate_url exato → UPSERT
      const existingOffer = await DB.prepare(
        `SELECT id, product_id, title FROM offers WHERE affiliate_url = ? AND store_id = ? LIMIT 1`
      ).bind(affiliateUrl, storeId).first<any>()

      if (existingOffer) {
        // Atualiza título e preço se vieram preenchidos
        const hasNewName  = name && name !== existingOffer.title && !affiliateUrl.includes(name)
        const hasNewPrice = price > 0
        if (hasNewName || hasNewPrice) {
          await DB.prepare(`
            UPDATE offers SET
              title       = CASE WHEN ? != '' THEN ? ELSE title END,
              price       = CASE WHEN ? > 0   THEN ? ELSE price END,
              image_url   = CASE WHEN ? != '' THEN ? ELSE image_url END,
              last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(name, name, price, price, imgUrl||'', imgUrl||'', existingOffer.id).run()

          // Atualiza também o produto
          await DB.prepare(`
            UPDATE products SET
              name       = CASE WHEN ? != '' THEN ? ELSE name END,
              best_price = CASE WHEN ? > 0 AND (best_price IS NULL OR ? < best_price) THEN ? ELSE best_price END,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(name, name, price, price, price, existingOffer.product_id).run()

          results.push({ url: affiliateUrl, status: 'atualizado', product_id: existingOffer.product_id, name })
          imported++
        } else {
          results.push({ url: affiliateUrl, status: 'já existe', product_id: existingOffer.product_id, name: existingOffer.title })
          skipped++
        }
        continue
      }

      // Cria produto novo
      const prodResult = await DB.prepare(`
        INSERT INTO products (name, slug, source, is_active, created_at, updated_at, best_price, best_store_id)
        VALUES (?, ?, 'manual', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
      `).bind(name, slug, price > 0 ? price : null, storeId).run()

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

      results.push({ url: affiliateUrl, status: 'importado', product_id: productId, name })
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
    total: dataLines.length,
    imported,
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

// ═══════════════════════════════════════════════════════════════════════════
// ██  AWIN API — Integração com rede global de afiliados
// ═══════════════════════════════════════════════════════════════════════════
// Publisher ID: 2892017 (KAINOW PROMOCAO DE VENDAS E SERVICOS)
// Token: AWIN_API_TOKEN (OAuth2 Bearer)
// Base: https://api.awin.com
// Lojas BR mapeadas: Casas Bahia (17629), Extra (17874), Ponto (17621),
//                    Fast Shop (17590), Kabum (17729), Centauro (17806)
// ─────────────────────────────────────────────────────────────────────────

const AWIN_BASE    = 'https://api.awin.com'
const AWIN_PUB_ID  = 2892017

// Mapa slug → advertiser ID (fallback hardcoded para as lojas principais)
// Atualizado com todos os programas verificados na Awin BR (migration 0026)
const AWIN_STORE_MAP: Record<string, number> = {
  // ── Lojas originais ──────────────────────────────────────
  casasbahia   : 17629,
  extra        : 17874,
  ponto        : 17621,
  pontofrio    : 17621,
  fastshop     : 17590,
  kabum        : 17729,
  centauro     : 17806,
  // ── Novas lojas mapeadas (migration 0026) ────────────────
  carrefour    : 17665,
  dafiti       : 17697,
  madeiramadeira: 17762,
  renner       : 17801,
  riachuelo    : 86587,
  samsung      : 25539,
  tok_stok     : 36382,
}

// Helper GET autenticado na Awin
async function awinGet(path: string, token: string): Promise<{ data: any; error: string | null }> {
  try {
    const r = await fetch(`${AWIN_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    })
    const text = await r.text()
    if (!r.ok) return { data: null, error: `Awin ${r.status}: ${text.slice(0, 200)}` }
    return { data: JSON.parse(text), error: null }
  } catch (e: any) {
    return { data: null, error: `Awin fetch error: ${e.message}` }
  }
}

// Helper: gera link de afiliado Awin
// Estratégia dual:
//   1. Tenta Link Builder API (gera shortUrl tidd.ly — requer aprovação no programa)
//   2. Fallback imediato: cread.php com ued= (funciona SEM aprovação, já rastreia cookie awc)
//
// O formato cread.php foi testado e gera rastreamento completo:
//   https://www.awin1.com/cread.php?awinmid=17629&awinaffid=2892017&ued=<encoded_url>
//   → redireciona com ?awc=17629_timestamp_hash (cookie de conversão Awin)
async function awinBuildLink(
  advertiserId: number,
  destinationUrl: string,
  token: string,
  shorten = false,
): Promise<{ url: string | null; shortUrl: string | null; error: string | null }> {
  // ── Gera cread.php diretamente (sem chamada de API, sem aprovação necessária) ──
  const encodedDest = encodeURIComponent(destinationUrl)
  const creadUrl = `https://www.awin1.com/cread.php?awinmid=${advertiserId}&awinaffid=${AWIN_PUB_ID}&ued=${encodedDest}`

  // Se não precisa de shortUrl, retorna o cread.php direto — sem latência de API
  if (!shorten) {
    return { url: creadUrl, shortUrl: null, error: null }
  }

  // Se pediu shortUrl, tenta o Link Builder API (requer aprovação)
  try {
    const r = await fetch(`${AWIN_BASE}/publishers/${AWIN_PUB_ID}/linkbuilder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ advertiserId, destinationUrl, shorten: true }),
      signal: AbortSignal.timeout(8000),
    })
    const json: any = await r.json().catch(() => ({}))
    // Sucesso: retorna o shortUrl do Link Builder junto com o cread.php como fallback
    if (r.ok && json.url && !json.description) {
      return { url: json.url, shortUrl: json.shortUrl ?? null, error: null }
    }
    // Link Builder falhou (sem aprovação ou erro) — usa cread.php como fallback
    return { url: creadUrl, shortUrl: null, error: null }
  } catch {
    // Timeout ou erro de rede — usa cread.php como fallback
    return { url: creadUrl, shortUrl: null, error: null }
  }
}

// ── GET /admin/api/awin/status ────────────────────────────────────────────
admin.get('/api/awin/status', async (c) => {
  const token = (c.env as any).AWIN_API_TOKEN as string | undefined
  if (!token) return c.json({ ok: false, configured: false, error: 'AWIN_API_TOKEN não configurado' })

  const { data, error } = await awinGet('/accounts', token)
  if (error || !data) return c.json({ ok: false, configured: true, error })

  const acc = data.accounts?.[0]
  return c.json({
    ok: true,
    configured: true,
    publisher_id: acc?.accountId,
    publisher_name: acc?.accountName,
    account_type: acc?.accountType,
    user_role: acc?.userRole,
  })
})

// ── GET /admin/api/awin/programmes ────────────────────────────────────────
// Lista programas do banco local (após sync)
admin.get('/api/awin/programmes', async (c) => {
  const { DB } = c.env
  const relationship = c.req.query('relationship') || 'all'
  const search       = (c.req.query('search') || '').trim()

  let sql = `SELECT id, name, logo_url, primary_region, status, relationship, joined_at, synced_at
             FROM awin_programmes WHERE 1=1`
  const binds: any[] = []

  if (relationship !== 'all') { sql += ` AND relationship = ?`; binds.push(relationship) }
  if (search) { sql += ` AND name LIKE ?`; binds.push(`%${search}%`) }
  sql += ` ORDER BY relationship DESC, name ASC LIMIT 300`

  const { results } = await DB.prepare(sql).bind(...binds).all<any>()

  // Vinculação com stores do banco
  const { results: linked } = await DB.prepare(
    `SELECT slug, name, awin_advertiser_id FROM stores WHERE awin_advertiser_id IS NOT NULL`
  ).all<any>()
  const linkedMap = new Map(linked.map((s: any) => [s.awin_advertiser_id, s]))

  const enriched = results.map((p: any) => ({
    ...p,
    store: linkedMap.get(p.id) ?? null,
  }))

  return c.json({ ok: true, total: enriched.length, programmes: enriched })
})

// ── POST /admin/api/awin/sync-programmes ─────────────────────────────────
// Busca todos os programas BR da Awin API e salva no banco local
admin.post('/api/awin/sync-programmes', async (c) => {
  const { DB } = c.env
  const token = (c.env as any).AWIN_API_TOKEN as string | undefined
  if (!token) return c.json({ ok: false, error: 'AWIN_API_TOKEN não configurado' }, 400)

  // Busca joined + notjoined em paralelo
  const [rJoined, rNot] = await Promise.all([
    awinGet(`/publishers/${AWIN_PUB_ID}/programmes?relationship=joined`, token),
    awinGet(`/publishers/${AWIN_PUB_ID}/programmes?relationship=notjoined&countryCode=BR`, token),
  ])

  if (rJoined.error && rNot.error) {
    return c.json({ ok: false, error: rJoined.error }, 502)
  }

  const joined   : any[] = rJoined.data ?? []
  const notJoined: any[] = (rNot.data ?? []).filter(
    (p: any) => p.primaryRegion?.name === 'Brazil'
  )
  const allProg = [
    ...joined.map((p: any) => ({ ...p, relationship: 'joined' })),
    ...notJoined.map((p: any) => ({ ...p, relationship: 'notjoined' })),
  ]

  if (allProg.length === 0) {
    return c.json({ ok: false, error: 'Nenhum programa retornado pela Awin' }, 502)
  }

  // Upsert em lotes de 50
  const stmts = allProg.map((p: any) =>
    DB.prepare(`
      INSERT INTO awin_programmes (id, name, logo_url, primary_region, status, relationship, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name         = excluded.name,
        logo_url     = COALESCE(NULLIF(excluded.logo_url,''), awin_programmes.logo_url),
        status       = excluded.status,
        relationship = excluded.relationship,
        synced_at    = CURRENT_TIMESTAMP
    `).bind(
      p.id,
      p.name,
      p.logoUrl ?? p.logo ?? '',
      p.primaryRegion?.name ?? 'Brazil',
      p.status ?? 'Active',
      p.relationship,
    )
  )

  const CHUNK = 50
  const chunks: (typeof stmts)[] = []
  for (let i = 0; i < stmts.length; i += CHUNK) chunks.push(stmts.slice(i, i + CHUNK))
  await Promise.all(chunks.map(chunk => DB.batch(chunk)))

  // Atualiza awin_advertiser_id nas stores a partir do mapa hardcoded
  const mapStmts = Object.entries(AWIN_STORE_MAP).map(([slug, advId]) =>
    DB.prepare(`UPDATE stores SET awin_advertiser_id = ? WHERE slug = ?`).bind(advId, slug)
  )
  await DB.batch(mapStmts)

  return c.json({
    ok: true,
    synced: allProg.length,
    joined: joined.length,
    not_joined_br: notJoined.length,
  })
})

// ── POST /admin/api/awin/join-programme ──────────────────────────────────
// Solicita participação em programa (atualiza relationship no banco)
// Nota: a aprovação é feita no painel Awin, aqui apenas registramos o status local
admin.post('/api/awin/join-programme', async (c) => {
  const { DB } = c.env
  const body         = await c.req.json().catch(() => ({})) as any
  const advertiserId = parseInt(body.advertiser_id)
  const storeSlug    = (body.store_slug || '').trim()

  if (!advertiserId) return c.json({ ok: false, error: 'advertiser_id obrigatório' }, 400)

  // Marca como 'pending' no banco local
  await DB.prepare(`
    UPDATE awin_programmes SET relationship = 'pending' WHERE id = ?
  `).bind(advertiserId).run()

  // Vincula ao store se fornecido
  if (storeSlug) {
    await DB.prepare(`
      UPDATE stores SET awin_advertiser_id = ? WHERE slug = ?
    `).bind(advertiserId, storeSlug).run()
  }

  return c.json({
    ok: true,
    advertiser_id: advertiserId,
    message: 'Para concluir, acesse o painel Awin em: https://ui.awin.com/affiliate/programmes',
    awin_url: `https://ui.awin.com/affiliate/programmes?advertiser=${advertiserId}`,
  })
})

// ── POST /admin/api/awin/generate-link ───────────────────────────────────
// Gera link de afiliado via Link Builder API
// Body: { advertiser_id, url, shorten? } ou { store_slug, url, shorten? }
admin.post('/api/awin/generate-link', async (c) => {
  const token = (c.env as any).AWIN_API_TOKEN as string | undefined
  if (!token) return c.json({ ok: false, error: 'AWIN_API_TOKEN não configurado' }, 400)

  const { DB } = c.env
  const body        = await c.req.json().catch(() => ({})) as any
  const destUrl     = (body.url || '').trim()
  const shorten     = !!body.shorten
  let advertiserId  = parseInt(body.advertiser_id) || 0

  if (!destUrl) return c.json({ ok: false, error: 'url obrigatório' }, 400)

  // Resolve advertiser_id por store_slug se não fornecido
  if (!advertiserId && body.store_slug) {
    advertiserId = AWIN_STORE_MAP[body.store_slug] ?? 0
    if (!advertiserId) {
      const row = await DB.prepare(
        `SELECT awin_advertiser_id FROM stores WHERE slug = ?`
      ).bind(body.store_slug).first<{ awin_advertiser_id: number | null }>()
      advertiserId = row?.awin_advertiser_id ?? 0
    }
  }

  if (!advertiserId) return c.json({ ok: false, error: 'advertiser_id ou store_slug obrigatório' }, 400)

  const result = await awinBuildLink(advertiserId, destUrl, token, shorten)
  if (result.error) return c.json({ ok: false, error: result.error, advertiser_id: advertiserId }, 502)

  return c.json({
    ok: true,
    advertiser_id: advertiserId,
    original_url: destUrl,
    affiliate_url: result.url,
    short_url: result.shortUrl ?? null,
  })
})

// ── POST /admin/api/awin/generate-batch ──────────────────────────────────
// Gera links de afiliado em lote (até 100 por chamada)
// Body: { links: [{ advertiser_id, url }], shorten? }
admin.post('/api/awin/generate-batch', async (c) => {
  const token = (c.env as any).AWIN_API_TOKEN as string | undefined
  if (!token) return c.json({ ok: false, error: 'AWIN_API_TOKEN não configurado' }, 400)

  const body    = await c.req.json().catch(() => ({})) as any
  const links   = (body.links ?? []) as { advertiser_id: number; url: string }[]
  const shorten = !!body.shorten

  if (!Array.isArray(links) || links.length === 0) {
    return c.json({ ok: false, error: 'links[] obrigatório' }, 400)
  }
  if (links.length > 100) {
    return c.json({ ok: false, error: 'Máximo 100 links por batch' }, 400)
  }

  // Processa em paralelo (respeitando rate limit 20 req/min da Awin)
  const BATCH = 10
  const results: any[] = []
  for (let i = 0; i < links.length; i += BATCH) {
    const slice = links.slice(i, i + BATCH)
    const batch = await Promise.all(
      slice.map(async (item) => {
        const r = await awinBuildLink(item.advertiser_id, item.url, token, shorten)
        return { advertiser_id: item.advertiser_id, original_url: item.url, ...r }
      })
    )
    results.push(...batch)
    // Pequeno delay entre batches para respeitar rate limit
    if (i + BATCH < links.length) await new Promise(r => setTimeout(r, 500))
  }

  const ok    = results.filter(r => r.url)
  const failed = results.filter(r => !r.url)

  return c.json({ ok: true, total: results.length, success: ok.length, failed: failed.length, results })
})

// ── POST /admin/api/awin/refresh-links ───────────────────────────────────
// Regenera affiliate_url de todas as offers de lojas Awin no banco
// Usa Link Builder API para obter links rastreados reais
admin.post('/api/awin/refresh-links', async (c) => {
  const { DB } = c.env
  const token = (c.env as any).AWIN_API_TOKEN as string | undefined
  if (!token) return c.json({ ok: false, error: 'AWIN_API_TOKEN não configurado' }, 400)

  const body    = await c.req.json().catch(() => ({})) as any
  const limit   = Math.min(parseInt(body.limit) || 20, 50)  // max 50 por run (rate limit)
  const storeSlug = body.store_slug || null

  // Busca offers de lojas Awin com URL de produto mas sem affiliate_url ou com affiliate_url antiga
  let sql = `
    SELECT o.id, o.product_url, o.affiliate_url, s.slug, s.awin_advertiser_id
    FROM offers o
    JOIN stores s ON s.id = o.store_id
    WHERE s.affiliate_network = 'awin'
      AND s.awin_advertiser_id IS NOT NULL
      AND o.product_url IS NOT NULL AND o.product_url != ''
      AND (o.affiliate_url IS NULL OR o.affiliate_url = '' OR o.affiliate_url NOT LIKE '%awin1.com%')
  `
  const binds: any[] = []
  if (storeSlug) { sql += ` AND s.slug = ?`; binds.push(storeSlug) }
  sql += ` ORDER BY o.last_updated ASC LIMIT ?`
  binds.push(limit)

  const { results: offers } = await DB.prepare(sql).bind(...binds)
    .all<{ id: number; product_url: string; affiliate_url: string | null; slug: string; awin_advertiser_id: number }>()

  if (offers.length === 0) {
    // Conta total pendente para informar
    const countRow = await DB.prepare(`
      SELECT COUNT(*) as total FROM offers o
      JOIN stores s ON s.id = o.store_id
      WHERE s.affiliate_network = 'awin' AND s.awin_advertiser_id IS NOT NULL
        AND o.product_url IS NOT NULL AND o.product_url != ''
        AND (o.affiliate_url IS NULL OR o.affiliate_url = '' OR o.affiliate_url NOT LIKE '%awin1.com%')
    `).first<{ total: number }>()
    return c.json({ ok: true, processed: 0, updated: 0, has_more: false,
      total_pending: countRow?.total ?? 0, message: 'Nenhuma offer Awin pendente' })
  }

  let updated = 0
  const errors: { id: number; error: string }[] = []

  // Processa em lotes de 5 (rate limit Awin: 20 req/min)
  const BATCH = 5
  for (let i = 0; i < offers.length; i += BATCH) {
    const slice = offers.slice(i, i + BATCH)
    await Promise.all(
      slice.map(async (offer) => {
        const result = await awinBuildLink(offer.awin_advertiser_id, offer.product_url, token, true)
        if (result.url) {
          await DB.prepare(
            `UPDATE offers SET affiliate_url = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(result.shortUrl ?? result.url, offer.id).run()
          updated++
        } else {
          errors.push({ id: offer.id, error: result.error ?? 'unknown' })
        }
      })
    )
    if (i + BATCH < offers.length) await new Promise(r => setTimeout(r, 400))
  }

  // Verifica se há mais pendentes
  const countRow = await DB.prepare(`
    SELECT COUNT(*) as total FROM offers o
    JOIN stores s ON s.id = o.store_id
    WHERE s.affiliate_network = 'awin' AND s.awin_advertiser_id IS NOT NULL
      AND o.product_url IS NOT NULL AND o.product_url != ''
      AND (o.affiliate_url IS NULL OR o.affiliate_url = '' OR o.affiliate_url NOT LIKE '%awin1.com%')
  `).first<{ total: number }>()

  return c.json({
    ok: true,
    processed: offers.length,
    updated,
    failed: errors.length,
    has_more: (countRow?.total ?? 0) > 0,
    total_pending: countRow?.total ?? 0,
    errors: errors.slice(0, 5),
  })
})

// ── GET /admin/api/awin/stats ─────────────────────────────────────────────
// Estatísticas das offers Awin no banco
admin.get('/api/awin/stats', async (c) => {
  const { DB } = c.env

  const [storeStats, linkStats, progStats] = await Promise.all([
    DB.prepare(`
      SELECT s.slug, s.name, s.awin_advertiser_id,
             COUNT(o.id) as total_offers,
             SUM(CASE WHEN o.affiliate_url LIKE '%awin1.com%' THEN 1 ELSE 0 END) as with_awin_link,
             MIN(o.price) as min_price, MAX(o.price) as max_price
      FROM stores s
      LEFT JOIN offers o ON o.store_id = s.id
      WHERE s.affiliate_network = 'awin' AND s.awin_advertiser_id IS NOT NULL
      GROUP BY s.id ORDER BY total_offers DESC
    `).all<any>(),

    DB.prepare(`
      SELECT
        COUNT(*) as total_awin_offers,
        SUM(CASE WHEN affiliate_url LIKE '%awin1.com%' THEN 1 ELSE 0 END) as with_awin_link,
        SUM(CASE WHEN affiliate_url IS NULL OR affiliate_url = '' THEN 1 ELSE 0 END) as no_link
      FROM offers o
      JOIN stores s ON s.id = o.store_id
      WHERE s.affiliate_network = 'awin'
    `).first<any>(),

    DB.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN relationship='joined' THEN 1 ELSE 0 END) as joined,
             SUM(CASE WHEN relationship='notjoined' THEN 1 ELSE 0 END) as available,
             SUM(CASE WHEN relationship='pending' THEN 1 ELSE 0 END) as pending
      FROM awin_programmes
    `).first<any>(),
  ])

  return c.json({
    ok: true,
    stores: storeStats.results,
    links: linkStats,
    programmes: progStats,
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ██  PRICE SYNC BOT — Busca preços reais via ML API (OAuth refresh_token)
// ════════════════════════════════════════════════════════════════════════════
// Estratégia de token (prioridade):
//   1. ml_app_token no KV (access_token cacheado, dura 6h — evita refresh desnecessário)
//   2. refresh_token no KV → gera novo access_token + salva novo refresh_token no KV
//   3. client_credentials como último fallback (acesso público limitado)
// Usa multi-get do ML: até 20 IDs por chamada → muito rápido.
// Atualiza: best_price, image_url, offer (price + in_stock), offer_count.
// Auto-triggered pela homepage a cada 6h via waitUntil (sem cron externo).
// ─────────────────────────────────────────────────────────────────────────

// GET /admin/api/ml-linkbuilder/status
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
      <!-- ml-import, ml-categories, ml-search, ml-crawl, ml-linkbuilder ocultos do menu -->
      <div onclick="showSection('api-keys')" class="sidebar-link" data-section="api-keys">
        <span class="text-lg">🔑</span> API Keys
      </div>
      <div onclick="showSection('stores')" class="sidebar-link" data-section="stores">
        <span class="text-lg">🏪</span> Lojas Parceiras
      </div>
      <div onclick="showSection('api-configs')" class="sidebar-link" data-section="api-configs">
        <span class="text-lg">🔌</span> APIs & Secrets
      </div>
      <div class="px-3 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-widest mt-1">Análise</div>
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
<script src="/static/admin-spa.js?v=20260513h"><\/script>
</body>
</html>`
}

export default admin
