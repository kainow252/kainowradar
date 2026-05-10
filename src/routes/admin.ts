// ============================================================
// ROUTES: Admin — Painel Administrativo Completo
// Protegido por Bearer token (ADMIN_SECRET via wrangler secret)
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'
import { CacheManager } from '../lib/cache'

type AdminBindings = Bindings & {
  ADMIN_SECRET?: string
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
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
  </script>
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
      <div class="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-xl">
        <span class="text-white text-3xl font-black">S</span>
      </div>
      <h1 class="text-2xl font-bold text-white">KainowRadar</h1>
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
        <div class="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shadow">
          <span class="text-white font-black text-lg">S</span>
        </div>
        <div>
          <div class="text-white font-bold text-sm">KainowRadar</div>
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

<script>
// ============================================================
// ADMIN SPA — JavaScript
// ============================================================

const App = {
  token: localStorage.getItem('admin_token') || '',
  currentSection: 'dashboard',
  charts: {},
}

// ── Auth ─────────────────────────────────────────────────
async function doLogin() {
  const pwd = document.getElementById('login-password').value
  const btn = document.getElementById('login-btn')
  const err = document.getElementById('login-error')
  if (!pwd) return
  btn.textContent = 'Entrando...'
  btn.disabled = true
  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Senha incorreta')
    App.token = data.token
    localStorage.setItem('admin_token', data.token)
    err.classList.add('hidden')
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('admin-app').classList.remove('hidden')
    loadSection('dashboard')
  } catch (e) {
    err.textContent = e.message
    err.classList.remove('hidden')
    btn.textContent = 'Entrar'
    btn.disabled = false
  }
}

async function doLogout() {
  await api('POST', '/admin/api/logout').catch(() => {})
  localStorage.removeItem('admin_token')
  App.token = ''
  location.reload()
}

// ── API helper ───────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + App.token }
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(path, opts)
  if (res.status === 401) { doLogout(); return null }
  return res.json()
}

// ── Toast ────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.getElementById('toast')
  const colors = { info:'#1e293b', success:'#166534', error:'#991b1b' }
  t.style.background = colors[type] || colors.info
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._t)
  t._t = setTimeout(() => t.classList.remove('show'), 3000)
}

// ── Format helpers ────────────────────────────────────────
const fBRL = v => v != null ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v) : '—'
const fDate = d => d ? new Date(d).toLocaleDateString('pt-BR') : '—'
const fDateTime = d => d ? new Date(d).toLocaleString('pt-BR') : '—'
const badge = (text, color) => \`<span class="badge-\${color}">\${text}</span>\`
const spin = \`<div class="flex items-center justify-center py-20"><div class="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>\`

// ── Navigation ────────────────────────────────────────────
function showSection(name) {
  App.currentSection = name
  document.querySelectorAll('[data-section]').forEach(el => el.classList.remove('active'))
  const link = document.querySelector(\`[data-section="\${name}"]\`)
  if (link) link.classList.add('active')
  loadSection(name)
}

async function loadSection(name) {
  const area = document.getElementById('content-area')
  area.innerHTML = spin
  const titles = {
    dashboard: ['Dashboard', 'Visão geral do sistema'],
    'top-deals': ['Top Deals', 'Melhor preço por produto — GROUP BY MIN(price)'],
    products: ['Produtos', 'Gerenciar catálogo de produtos'],
    offers: ['Ofertas', 'Gerenciar ofertas por loja'],
    stores: ['Lojas Parceiras', 'Ativar/desativar lojas e ver métricas'],
    'api-configs': ['APIs & Feeds', 'Configurar integrações e chaves de API'],
    queue: ['Fila de Preços', 'Jobs pendentes de atualização cirúrgica'],
    analytics: ['Analytics', 'Cliques, conversões e performance'],
    users: ['Usuários', 'Gerenciar clientes e membros'],
  }
  const [title, subtitle] = titles[name] || ['Admin', '']
  document.getElementById('page-title').textContent = title
  document.getElementById('page-subtitle').textContent = subtitle

  const sections = {
    dashboard: renderDashboard,
    'top-deals': renderTopDeals,
    products: renderProducts,
    offers: renderOffers,
    stores: renderStores,
    'api-configs': renderApiConfigs,
    queue: renderQueue,
    analytics: renderAnalytics,
    users: renderUsers,
  }
  if (sections[name]) await sections[name](area)
}

// ── DASHBOARD ─────────────────────────────────────────────
async function renderDashboard(area) {
  const data = await api('GET', '/admin/api/dashboard')
  if (!data) return
  const p = data.products || {}; const o = data.offers || {}; const s = data.stores || {}
  const u = data.users || {}; const cl = data.clicks || {}; const q = data.queue || {}

  area.innerHTML = \`
    <div class="section">
      <!-- Stats grid -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        \${statCard('📦', 'Produtos', p.total, \`\${p.with_offers || 0} com ofertas\`, 'blue')}
        \${statCard('💰', 'Ofertas Ativas', o.total, \`\${o.in_stock || 0} em estoque\`, 'green')}
        \${statCard('🏪', 'Lojas', s.total, \`\${s.active || 0} ativas\`, 'purple')}
        \${statCard('👆', 'Cliques Hoje', cl.today, \`Fila: \${q.pending || 0} pendentes\`, 'orange')}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Cliques por dia -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📈 Cliques (7 dias)</h3>
          <canvas id="clicks-chart" height="180"></canvas>
        </div>

        <!-- Top Categorias -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📂 Top Categorias</h3>
          <div class="space-y-3">
            \${(data.topCategories || []).map(c => \`
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-slate-700 capitalize">\${c.category || 'Outros'}</span>
                <div class="flex items-center gap-3">
                  <div class="w-32 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div class="bg-blue-500 h-2 rounded-full" style="width:\${Math.min(100, (c.count / p.total) * 100)}%"></div>
                  </div>
                  <span class="text-sm font-bold text-slate-800 w-8 text-right">\${c.count}</span>
                </div>
              </div>
            \`).join('')}
          </div>
        </div>

        <!-- Top Lojas -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">🏆 Lojas por Ofertas</h3>
          <table class="w-full">
            <thead><tr>
              <th class="text-left text-xs text-slate-500 font-semibold pb-2">Loja</th>
              <th class="text-right text-xs text-slate-500 font-semibold pb-2">Ofertas</th>
              <th class="text-right text-xs text-slate-500 font-semibold pb-2">Menor Preço</th>
            </tr></thead>
            <tbody>
              \${(data.topStores || []).map(s => \`
                <tr class="border-t border-slate-50 hover:bg-slate-50">
                  <td class="py-2 text-sm font-medium text-slate-700">\${s.name}</td>
                  <td class="py-2 text-sm text-right text-slate-600">\${s.offer_count}</td>
                  <td class="py-2 text-sm text-right font-semibold text-green-700">\${fBRL(s.min_price)}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>

        <!-- Faixa de preços -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">💵 Faixa de Preços</h3>
          <div class="space-y-4">
            \${priceRange('Menor preço', o.min_price, 'text-green-700')}
            \${priceRange('Preço médio', o.avg_price, 'text-blue-700')}
            \${priceRange('Maior preço', o.max_price, 'text-red-700')}
          </div>
          <div class="mt-4 pt-4 border-t border-slate-100">
            <div class="text-xs text-slate-500">Usuários cadastrados</div>
            <div class="flex items-baseline gap-2 mt-1">
              <span class="text-2xl font-bold text-slate-800">\${u.total || 0}</span>
              <span class="text-sm text-green-600">\${u.active || 0} ativos</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  \`

  // Gráfico de cliques
  const ctx = document.getElementById('clicks-chart')
  if (ctx && data.clicksByDay) {
    if (App.charts.clicks) App.charts.clicks.destroy()
    App.charts.clicks = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.clicksByDay.map(d => new Date(d.day).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})),
        datasets: [{ label: 'Cliques', data: data.clicksByDay.map(d => d.clicks),
          backgroundColor: '#3b82f6', borderRadius: 6 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    })
  }
}

function statCard(icon, label, value, sub, color) {
  const colors = { blue:'border-blue-200 bg-blue-50', green:'border-green-200 bg-green-50',
    purple:'border-purple-200 bg-purple-50', orange:'border-orange-200 bg-orange-50' }
  return \`
    <div class="stat-card border-l-4 \${colors[color] || ''}">
      <div class="flex items-start justify-between">
        <div>
          <p class="text-sm font-medium text-slate-500">\${label}</p>
          <p class="text-3xl font-black text-slate-900 mt-1">\${value ?? '—'}</p>
          <p class="text-xs text-slate-400 mt-1">\${sub}</p>
        </div>
        <span class="text-3xl">\${icon}</span>
      </div>
    </div>
  \`
}

function priceRange(label, value, cls) {
  return \`
    <div class="flex justify-between items-center">
      <span class="text-sm text-slate-500">\${label}</span>
      <span class="text-sm font-bold \${cls}">\${fBRL(value)}</span>
    </div>
  \`
}

// ── TOP DEALS ─────────────────────────────────────────────
async function renderTopDeals(area) {
  const data = await api('GET', '/admin/api/top-deals?limit=24')
  if (!data) return
  const rows = data.map((item, i) => \`
    <tr class="hover:bg-slate-50 cursor-pointer" onclick="openProductPage('\${item.slug}')">
      <td class="table-td w-8 font-bold text-slate-400">\${i+1}</td>
      <td class="table-td">
        <div class="flex items-center gap-3">
          <img src="\${item.image_url || 'https://via.placeholder.com/48?text=P'}" class="w-10 h-10 object-contain bg-slate-50 rounded-lg">
          <div>
            <div class="font-semibold text-slate-800 text-sm max-w-xs truncate">\${item.name}</div>
            <div class="text-xs text-slate-400">\${item.brand || ''} · EAN: \${item.ean || '—'}</div>
          </div>
        </div>
      </td>
      <td class="table-td">\${badge(item.category || 'outros', 'blue')}</td>
      <td class="table-td">
        <div class="flex items-center gap-2">
          \${item.store_logo ? \`<img src="\${item.store_logo}" class="h-4 max-w-[60px] object-contain">\` : \`<span class="font-semibold text-xs">\${item.store_name}</span>\`}
        </div>
      </td>
      <td class="table-td">
        <div class="text-lg font-black text-green-700">\${fBRL(item.lowest_price)}</div>
        \${item.original_price && item.original_price > item.lowest_price
          ? \`<div class="text-xs text-slate-400 line-through">\${fBRL(item.original_price)}</div>\` : ''}
      </td>
      <td class="table-td">
        \${item.discount_percent > 0 ? badge('-' + Math.round(item.discount_percent) + '%', 'red') : '—'}
      </td>
      <td class="table-td">
        \${item.free_shipping ? badge('✓ Grátis', 'green') : badge('A consultar', 'yellow')}
      </td>
      <td class="table-td">
        <span class="text-xs text-slate-400">\${item.offer_count} \${item.offer_count===1?'loja':'lojas'}</span>
      </td>
      <td class="table-td">
        \${item.checkout_url ? \`<a href="\${item.checkout_url}" target="_blank" class="btn-success text-xs" onclick="event.stopPropagation()">Testar →</a>\` : '—'}
      </td>
    </tr>
  \`).join('')

  area.innerHTML = \`
    <div class="section">
      <div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
        <span class="text-lg">💡</span>
        <div>
          <strong>Query otimizada:</strong> <code class="bg-blue-100 px-1.5 py-0.5 rounded text-xs">GROUP BY p.id + MIN(o.price)</code>
          — garante exatamente 1 linha por produto, sempre com a oferta mais barata. Se o estoque da loja mais barata acabar, a próxima assume automaticamente.
        </div>
      </div>
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 class="font-bold text-slate-800">Melhor preço por produto <span class="text-slate-400 font-normal text-sm ml-1">\${data.length} resultados</span></h3>
          <div class="flex gap-2">
            \${['', 'smartphones', 'notebooks', 'tv', 'games', 'audio', 'eletrodomesticos'].map(cat =>
              \`<button onclick="loadTopDealsCategory('\${cat}')" class="text-xs px-3 py-1.5 rounded-lg border \${cat===''?'bg-blue-600 text-white border-blue-600':'border-slate-200 hover:bg-slate-50'}">\${cat||'Todos'}</button>\`
            ).join('')}
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th">#</th>
              <th class="table-th">Produto</th>
              <th class="table-th">Categoria</th>
              <th class="table-th">Loja</th>
              <th class="table-th">Menor Preço</th>
              <th class="table-th">Desconto</th>
              <th class="table-th">Frete</th>
              <th class="table-th">Lojas</th>
              <th class="table-th">Ação</th>
            </tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  \`
}

async function loadTopDealsCategory(cat) {
  const area = document.getElementById('content-area')
  area.innerHTML = spin
  const url = cat ? \`/admin/api/top-deals?limit=24&category=\${cat}\` : '/admin/api/top-deals?limit=24'
  App._topDealsUrl = url
  const data = await api('GET', url)
  if (!data) return
  // Só re-renderiza a tabela
  await renderTopDeals(area)
}

function openProductPage(slug) {
  window.open('/produto/' + slug, '_blank')
}

// ── PRODUCTS ──────────────────────────────────────────────
async function renderProducts(area, page = 1) {
  const q = App.productSearch || ''
  const data = await api('GET', \`/admin/api/products?page=\${page}&q=\${encodeURIComponent(q)}\`)
  if (!data) return

  const rows = data.products.map(p => \`
    <tr class="hover:bg-slate-50">
      <td class="table-td w-12">
        <img src="\${p.image_url || 'https://via.placeholder.com/40?text=P'}" class="w-10 h-10 object-contain bg-slate-50 rounded-lg">
      </td>
      <td class="table-td max-w-xs">
        <div class="font-semibold text-slate-800 text-sm truncate">\${p.name}</div>
        <div class="text-xs text-slate-400">\${p.brand || ''} \${p.ean ? '· EAN: '+p.ean : ''}</div>
      </td>
      <td class="table-td">\${badge(p.category || 'outros', 'blue')}</td>
      <td class="table-td font-bold text-green-700">\${fBRL(p.best_price)}</td>
      <td class="table-td">
        <span class="text-sm font-semibold text-blue-700">\${p.live_offers || 0}</span>
        <span class="text-xs text-slate-400"> lojas</span>
      </td>
      <td class="table-td">\${fDateTime(p.updated_at)}</td>
      <td class="table-td">\${p.is_active ? badge('Ativo','green') : badge('Inativo','red')}</td>
      <td class="table-td">
        <div class="flex gap-2">
          <button onclick="editProduct(\${p.id})" class="btn-secondary text-xs">Editar</button>
          <button onclick="toggleProduct(\${p.id}, \${p.is_active})" class="\${p.is_active?'btn-danger':'btn-success'} text-xs">
            \${p.is_active?'Desativar':'Ativar'}
          </button>
        </div>
      </td>
    </tr>
  \`).join('')

  area.innerHTML = \`
    <div class="section">
      <div class="flex items-center gap-3 mb-4">
        <input type="text" id="product-search" value="\${q}" placeholder="Buscar por nome, marca, EAN..."
          class="input max-w-sm" oninput="App.productSearch=this.value" onkeydown="if(event.key==='Enter'){renderProducts(document.getElementById('content-area'))}">
        <button onclick="renderProducts(document.getElementById('content-area'))" class="btn-primary">Buscar</button>
        <span class="text-sm text-slate-500 ml-auto">\${data.total} produtos</span>
      </div>
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th"></th>
              <th class="table-th">Produto</th>
              <th class="table-th">Categoria</th>
              <th class="table-th">Melhor Preço</th>
              <th class="table-th">Ofertas</th>
              <th class="table-th">Atualizado</th>
              <th class="table-th">Status</th>
              <th class="table-th">Ações</th>
            </tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
        \${renderPagination(data.page, data.total, data.per_page, (p) => renderProducts(document.getElementById('content-area'), p))}
      </div>
    </div>
  \`
}

async function toggleProduct(id, currentActive) {
  await api('DELETE', \`/admin/api/products/\${id}\`)
  toast(currentActive ? 'Produto desativado' : 'Produto ativado', 'success')
  renderProducts(document.getElementById('content-area'))
}

function editProduct(id) {
  toast('Edição em desenvolvimento', 'info')
}

// ── OFFERS ────────────────────────────────────────────────
async function renderOffers(area, page = 1) {
  const data = await api('GET', \`/admin/api/offers?page=\${page}\`)
  if (!data) return
  const rows = data.offers.map(o => \`
    <tr class="hover:bg-slate-50">
      <td class="table-td max-w-xs">
        <div class="font-medium text-slate-800 text-sm truncate">\${o.product_name}</div>
        <div class="text-xs text-slate-400">ID: \${o.external_id}</div>
      </td>
      <td class="table-td">\${badge(o.store_name, 'blue')}</td>
      <td class="table-td font-bold text-green-700 text-base">\${fBRL(o.price)}</td>
      <td class="table-td">
        \${o.original_price && o.original_price > o.price ? \`<span class="text-slate-400 line-through text-xs">\${fBRL(o.original_price)}</span>\` : '—'}
      </td>
      <td class="table-td">
        \${o.discount_percent > 0 ? badge('-' + Math.round(o.discount_percent) + '%','red') : '—'}
      </td>
      <td class="table-td">\${o.in_stock ? badge('Em estoque','green') : badge('Sem estoque','red')}</td>
      <td class="table-td">\${o.free_shipping ? badge('Grátis','green') : badge('A consultar','yellow')}</td>
      <td class="table-td text-xs text-slate-400">\${fDateTime(o.last_updated)}</td>
      <td class="table-td">
        \${o.checkout_url ? \`<a href="\${o.checkout_url}" target="_blank" class="text-blue-600 text-xs hover:underline">Abrir →</a>\` : '—'}
      </td>
    </tr>
  \`).join('')

  area.innerHTML = \`
    <div class="section">
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-slate-800">Todas as Ofertas <span class="text-slate-400 font-normal text-sm ml-1">\${data.total} total</span></h3>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th">Produto</th>
              <th class="table-th">Loja</th>
              <th class="table-th">Preço</th>
              <th class="table-th">Preço original</th>
              <th class="table-th">Desconto</th>
              <th class="table-th">Estoque</th>
              <th class="table-th">Frete</th>
              <th class="table-th">Atualizado</th>
              <th class="table-th">Link</th>
            </tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
        \${renderPagination(data.page, data.total, data.per_page, (p) => renderOffers(document.getElementById('content-area'), p))}
      </div>
    </div>
  \`
}

// ── STORES ────────────────────────────────────────────────
// ── Mapa de cores por rede ─────────────────────────────────
const NETWORK_COLORS = {
  'amazon-pa-api':      { bg: '#fff8ee', border: '#FF9900', label: 'Amazon PA-API' },
  'meli-api':           { bg: '#fffde6', border: '#FFE600', label: 'Mercado Livre' },
  'magalu-api':         { bg: '#eef5ff', border: '#0086FF', label: 'Magalu API'    },
  'shopee-api':         { bg: '#fff3f0', border: '#EE4D2D', label: 'Shopee API'    },
  'shein-api':          { bg: '#f5f5f5', border: '#444444', label: 'Shein'         },
  'aliexpress-portals': { bg: '#fff0f0', border: '#FF4747', label: 'AliExpress'    },
  'awin':               { bg: '#e8f4fd', border: '#007AC9', label: 'Awin'          },
  'lomadee':            { bg: '#f0f0ff', border: '#6366F1', label: 'SocialSoul'    },
  'rakuten':            { bg: '#fff0f0', border: '#BF0000', label: 'Rakuten'       },
  'hotmart-api':        { bg: '#fff3f0', border: '#FF5722', label: 'Hotmart'       },
  'eduzz-api':          { bg: '#f5f3ff', border: '#7C3AED', label: 'Eduzz'         },
  'monetizze-api':      { bg: '#f0fdf4', border: '#00B359', label: 'Monetizze'     },
  'dafiti-api':         { bg: '#f8f8f8', border: '#555555', label: 'Dafiti'        },
  // Plataformas de Parceria
  'ltk-api':            { bg: '#fff0f3', border: '#FF385C', label: 'LTK'            },
  'impact-api':         { bg: '#fff4f0', border: '#FF6B35', label: 'Impact.com'     },
  // Live Commerce
  'twitch-api':         { bg: '#f5f0ff', border: '#9146FF', label: 'Twitch'         },
  // Discovery Commerce
  'pinterest-api':      { bg: '#fff0f0', border: '#E60023', label: 'Pinterest'      },
  // E-commerce Builder
  'woocommerce-api':    { bg: '#f5f0ff', border: '#7F54B3', label: 'WooCommerce'    },
  'shopify-store-api':  { bg: '#f0f1ff', border: '#5C6AC4', label: 'Shopify'        },
  // Social Commerce
  'tiktok-shop':        { bg: '#f0f0f5', border: '#010101', label: 'TikTok Shop'    },
  'kwai-shop':          { bg: '#fff4ee', border: '#FF6600', label: 'Kwai Shop'      },
  'instagram-shop':     { bg: '#fff0f5', border: '#E1306C', label: 'Instagram'      },
  'youtube-shop':       { bg: '#fff0f0', border: '#FF0000', label: 'YouTube'        },
  'facebook-shop':      { bg: '#eff5ff', border: '#1877F2', label: 'Facebook'       },
}

// Variável global para os dados de lojas (busca local)
let _storesData = []

function _buildStoreCard(s) {
  const nc = NETWORK_COLORS[s.affiliate_network] || { bg: '#f8fafc', border: '#94a3b8', label: s.affiliate_network || '—' }
  const logoHTML = s.logo_url
    ? '<img src="' + s.logo_url + '" class="h-7 max-w-[72px] object-contain">'
    : '<div class="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-sm" style="background:' + nc.border + '">' + s.name[0] + '</div>'
  const statusBadge = s.is_active
    ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full inline-block"></span>Ativa</span>'
    : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativa</span>'
  const offersBadge = s.offer_count > 0
    ? '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">' + s.offer_count + ' produto' + (s.offer_count > 1 ? 's' : '') + '</span>'
    : ''
  const checked = s.is_active ? 'checked' : ''
  const urlHint = s.checkout_pattern || s.deeplink_base || '—'
  return (
    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="store-card-' + s.id + '">'
    + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + nc.bg + ';border-bottom:2px solid ' + nc.border + '20">'
    +   '<div class="flex items-center gap-2.5">'
    +     '<div style="width:40px;height:40px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid ' + nc.border + '30;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07)">'
    +       logoHTML
    +     '</div>'
    +     '<div>'
    +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + s.name + '</div>'
    +       '<div class="text-xs font-medium mt-0.5" style="color:' + nc.border + '">' + nc.label + '</div>'
    +     '</div>'
    +   '</div>'
    +   '<label class="toggle-switch flex-shrink-0">'
    +     '<input type="checkbox" ' + checked + ' onchange="toggleStore(' + s.id + ', this.checked)">'
    +     '<span class="toggle-slider"></span>'
    +   '</label>'
    + '</div>'
    + '<div class="px-4 py-3">'
    +   '<div class="grid grid-cols-3 gap-2 text-center mb-3">'
    +     '<div class="bg-slate-50 rounded-xl p-2"><div class="text-lg font-black text-slate-800">' + (s.offer_count || 0) + '</div><div class="text-xs text-slate-400">Ofertas</div></div>'
    +     '<div class="bg-green-50 rounded-xl p-2"><div class="text-sm font-bold text-green-700">' + fBRL(s.min_price) + '</div><div class="text-xs text-slate-400">Menor preço</div></div>'
    +     '<div class="bg-blue-50 rounded-xl p-2"><div class="text-sm font-bold text-blue-700">' + (s.commission_rate || 0) + '%</div><div class="text-xs text-slate-400">Comissão</div></div>'
    +   '</div>'
    +   '<div class="flex items-center gap-2 mb-2">' + statusBadge + offersBadge + '</div>'
    +   '<div class="text-xs text-slate-400 truncate mb-3" title="' + urlHint + '">🔗 ' + urlHint + '</div>'
    +   '<button onclick="openStoreModal(' + s.id + ')" class="w-full text-xs font-semibold py-2 px-3 rounded-xl border bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 transition-all">✏️ Editar loja</button>'
    + '</div>'
    + '</div>'
  )
}

async function renderStores(area) {
  const data = await api('GET', '/admin/api/stores')
  if (!data) return

  const total      = data.length
  const active     = data.filter(s => s.is_active).length
  const withOffers = data.filter(s => s.offer_count > 0).length
  const allCards   = data.map(_buildStoreCard).join('')

  area.innerHTML = \`
    <div class="section">
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="stat-card text-center border-t-4 border-blue-400">
          <div class="text-3xl font-black text-slate-800">\${total}</div>
          <div class="text-sm text-slate-500 mt-1">Lojas cadastradas</div>
        </div>
        <div class="stat-card text-center border-t-4 border-green-400">
          <div class="text-3xl font-black text-green-700">\${active}</div>
          <div class="text-sm text-slate-500 mt-1">Lojas ativas</div>
        </div>
        <div class="stat-card text-center border-t-4 border-amber-400">
          <div class="text-3xl font-black text-amber-700">\${withOffers}</div>
          <div class="text-sm text-slate-500 mt-1">Com produtos</div>
        </div>
      </div>
      <div class="flex gap-3 mb-5">
        <div class="relative flex-1">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          <input type="text" id="stores-search" placeholder="Buscar loja..."
            class="input pl-9 w-full" oninput="filterStores(this.value)">
        </div>
        <select id="stores-filter" class="input w-44" onchange="filterStores(document.getElementById('stores-search').value)">
          <option value="">Todas as redes</option>
          <option value="amazon-pa-api">Amazon PA-API</option>
          <option value="meli-api">Mercado Livre</option>
          <option value="magalu-api">Magalu API</option>
          <option value="shopee-api">Shopee</option>
          <option value="aliexpress-portals">AliExpress</option>
          <option value="awin">Awin</option>
          <option value="lomadee">SocialSoul/Lomadee</option>
          <option value="hotmart-api">Hotmart</option>
          <option value="eduzz-api">Eduzz</option>
          <option value="tiktok-shop">TikTok Shop</option>
          <option value="kwai-shop">Kwai Shop</option>
          <option value="instagram-shop">Instagram</option>
          <option value="youtube-shop">YouTube</option>
          <option value="facebook-shop">Facebook</option>
          <option value="ltk-api">LTK</option>
          <option value="impact-api">Impact.com</option>
          <option value="twitch-api">Twitch</option>
          <option value="pinterest-api">Pinterest</option>
          <option value="woocommerce-api">WooCommerce</option>
          <option value="shopify-store-api">Shopify Store</option>
        </select>
        <button onclick="renderStores(document.getElementById('content-area'))"
          class="btn-secondary flex items-center gap-2 whitespace-nowrap">↻ Atualizar</button>
      </div>
      <div id="stores-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        \${allCards}
      </div>
    </div>
  \`
}

function filterStores(q) {
  const filter = document.getElementById('stores-filter')?.value || ''
  const term = (q || '').toLowerCase().trim()
  document.querySelectorAll('#stores-grid > div').forEach(card => {
    const name    = (card.querySelector('.font-bold')?.textContent || '').toLowerCase()
    const network = (card.querySelector('.text-xs.font-medium')?.textContent || '').toLowerCase()
    const matchQ  = !term   || name.includes(term) || network.includes(term)
    const matchF  = !filter || card.innerHTML.includes(filter)
    card.style.display = (matchQ && matchF) ? '' : 'none'
  })
}

async function toggleStore(id, active) {
  await api('PATCH', \`/admin/api/stores/\${id}/toggle\`, { active })
  toast(active ? 'Loja ativada ✓' : 'Loja desativada', active ? 'success' : 'info')
}

function openStoreModal(id) {
  const card = document.getElementById(\`store-card-\${id}\`)
  const name = card?.querySelector('.font-bold')?.textContent || ''
  const modal = document.getElementById('modal-container')
  modal.innerHTML = \`
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal max-w-lg">
        <h3 class="font-bold text-slate-800 text-lg mb-4">✏️ Editar loja: \${name}</h3>
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Logo URL</label>
            <input type="url" id="store-logo-url" class="input" placeholder="https://logo.clearbit.com/loja.com.br">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Rede de afiliados</label>
            <select id="store-network" class="input">
              <option value="amazon-pa-api">Amazon PA-API</option>
              <option value="meli-api">Mercado Livre</option>
              <option value="magalu-api">Magalu API</option>
              <option value="shopee-api">Shopee</option>
              <option value="aliexpress-portals">AliExpress Portals</option>
              <option value="awin">Awin</option>
              <option value="lomadee">SocialSoul/Lomadee</option>
              <option value="hotmart-api">Hotmart</option>
              <option value="eduzz-api">Eduzz</option>
              <option value="monetizze-api">Monetizze</option>
              <option value="rakuten">Rakuten</option>
              <option value="shein-api">Shein</option>
              <option value="dafiti-api">Dafiti</option>
              <option value="tiktok-shop">TikTok Shop</option>
              <option value="kwai-shop">Kwai Shop</option>
              <option value="instagram-shop">Instagram Shopping</option>
              <option value="youtube-shop">YouTube Shopping</option>
              <option value="facebook-shop">Facebook Shops</option>
              <option value="ltk-api">LTK (LikeToKnow.it)</option>
              <option value="impact-api">Impact.com</option>
              <option value="twitch-api">Twitch</option>
              <option value="pinterest-api">Pinterest Shopping</option>
              <option value="woocommerce-api">WooCommerce Affiliates</option>
              <option value="shopify-store-api">Shopify Multi-vendor</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Padrão de checkout</label>
            <input type="text" id="store-checkout" class="input" placeholder="https://loja.com/produto/{ID}">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Comissão (%)</label>
            <input type="number" id="store-commission" class="input" placeholder="5.0" step="0.1" min="0" max="100">
          </div>
        </div>
        <div class="flex gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveStore(\${id})" class="btn-primary flex-1">💾 Salvar</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  \`
}

async function saveStore(id) {
  const body = {
    logo_url:           document.getElementById('store-logo-url')?.value.trim() || undefined,
    affiliate_network:  document.getElementById('store-network')?.value || undefined,
    checkout_pattern:   document.getElementById('store-checkout')?.value.trim() || undefined,
    commission_rate:    parseFloat(document.getElementById('store-commission')?.value) || undefined,
  }
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k])
  await api('PATCH', \`/admin/api/stores/\${id}\`, body)
  toast('Loja atualizada ✓', 'success')
  closeModal()
  renderStores(document.getElementById('content-area'))
}


// ── API CONFIGS ───────────────────────────────────────────
// Catálogo estático de todas as redes suportadas
const AFFILIATE_NETWORKS = [
  // ── Marketplaces ──────────────────────────────────────
  {
    id: 'amazon',
    name: 'Amazon Associados',
    group: 'Marketplaces',
    icon: '🟠',
    color: '#FF9900',
    bg: '#fff8ee',
    border: '#FF9900',
    desc: 'Amazon PA-API v5 — produtos, preços, imagens e links de afiliado',
    fields: ['api_key:API Key (Access Key ID)', 'client_secret:Secret Access Key', 'partner_tag:Associate Tag (ex: seusite-20)', 'client_id:Tracking ID'],
    docsUrl: 'https://webservices.amazon.com.br/paapi5/documentation/',
    commission: '1–10%',
    network: 'amazon-pa-api',
  },
  {
    id: 'mercadolivre',
    name: 'Mercado Livre Afiliados',
    group: 'Marketplaces',
    icon: '🟡',
    color: '#FFE600',
    bg: '#fffde6',
    border: '#e6c800',
    desc: 'MELI Affiliates — feed de produtos e deep links rastreados',
    fields: ['client_id:App ID', 'client_secret:Client Secret', 'partner_tag:Affiliate ID', 'api_key:Access Token'],
    docsUrl: 'https://developers.mercadolivre.com.br/',
    commission: '2–15%',
    network: 'meli-api',
  },
  {
    id: 'magalu',
    name: 'Magalu Parceiro',
    group: 'Marketplaces',
    icon: '🔵',
    color: '#0086FF',
    bg: '#eef5ff',
    border: '#0086FF',
    desc: 'Magazine Luiza — feed XML/CSV + API de produtos e rastreamento',
    fields: ['api_key:API Key', 'client_id:Client ID', 'client_secret:Client Secret', 'partner_tag:Publisher ID'],
    docsUrl: 'https://parceiro.magazineluiza.com.br/',
    commission: '2–12%',
    network: 'magalu-api',
  },
  {
    id: 'shopee',
    name: 'Shopee Afiliados',
    group: 'Marketplaces',
    icon: '🟠',
    color: '#EE4D2D',
    bg: '#fff3f0',
    border: '#EE4D2D',
    desc: 'Shopee Affiliate — API de produtos, deep links e rastreamento',
    fields: ['api_key:API Key', 'client_id:App ID', 'client_secret:App Secret', 'partner_tag:Sub ID'],
    docsUrl: 'https://open.shopee.com/documents',
    commission: '1–12%',
    network: 'shopee-api',
  },
  {
    id: 'shein',
    name: 'Shein Afiliados',
    group: 'Marketplaces',
    icon: '🖤',
    color: '#000000',
    bg: '#f5f5f5',
    border: '#444444',
    desc: 'Shein Affiliate Program — feed de produtos de moda e links de afiliado',
    fields: ['api_key:API Key', 'partner_tag:Affiliate ID', 'client_id:Publisher ID'],
    docsUrl: 'https://affiliate.shein.com/',
    commission: '10–20%',
    network: 'shein-api',
  },
  {
    id: 'aliexpress',
    name: 'AliExpress Portals',
    group: 'Marketplaces',
    icon: '🔴',
    color: '#FF4747',
    bg: '#fff0f0',
    border: '#FF4747',
    desc: 'AliExpress Affiliate — Portals API para produtos, hotlinks e comissões',
    fields: ['api_key:App Key', 'client_secret:App Secret', 'partner_tag:Tracking ID', 'client_id:Publisher SiteID'],
    docsUrl: 'https://portals.aliexpress.com/',
    commission: '3–9%',
    network: 'aliexpress-portals',
  },
  {
    id: 'dafiti',
    name: 'Dafiti Afiliados',
    group: 'Marketplaces',
    icon: '👟',
    color: '#2C2C2C',
    bg: '#f8f8f8',
    border: '#555555',
    desc: 'Dafiti — moda, calçados e acessórios. Feed de produtos via Awin/Lomadee',
    fields: ['api_key:API Token', 'partner_tag:Publisher ID', 'client_id:Site ID'],
    docsUrl: 'https://www.dafiti.com.br/afiliados/',
    commission: '5–10%',
    network: 'dafiti-api',
  },
  // ── Infoprodutos ──────────────────────────────────────
  {
    id: 'hotmart',
    name: 'Hotmart',
    group: 'Infoprodutos',
    icon: '🔥',
    color: '#FF5722',
    bg: '#fff3f0',
    border: '#FF5722',
    desc: 'Hotmart Club — cursos, e-books e infoprodutos digitais brasileiros',
    fields: ['client_id:Client ID', 'client_secret:Client Secret', 'api_key:Basic Token', 'partner_tag:HotLink ID'],
    docsUrl: 'https://developers.hotmart.com/',
    commission: '20–80%',
    network: 'hotmart-api',
  },
  {
    id: 'eduzz',
    name: 'Eduzz',
    group: 'Infoprodutos',
    icon: '🟣',
    color: '#7C3AED',
    bg: '#f5f3ff',
    border: '#7C3AED',
    desc: 'Eduzz — marketplace de infoprodutos, cursos e assinaturas',
    fields: ['api_key:API Key', 'client_id:Publisher ID', 'partner_tag:Affiliate Token'],
    docsUrl: 'https://api.eduzz.com/',
    commission: '20–80%',
    network: 'eduzz-api',
  },
  {
    id: 'monetizze',
    name: 'Monetizze',
    group: 'Infoprodutos',
    icon: '💚',
    color: '#00B359',
    bg: '#f0fdf4',
    border: '#00B359',
    desc: 'Monetizze — infoprodutos físicos e digitais com rastreamento avançado',
    fields: ['api_key:API Key', 'client_id:Publisher ID', 'partner_tag:Affiliate Slug'],
    docsUrl: 'https://app.monetizze.com.br/afiliados',
    commission: '20–70%',
    network: 'monetizze-api',
  },
  {
    id: 'braip',
    name: 'Braip',
    group: 'Infoprodutos',
    icon: '🔷',
    color: '#1565C0',
    bg: '#e8f0fe',
    border: '#1565C0',
    desc: 'Braip — plataforma de vendas de produtos físicos e digitais afiliados',
    fields: ['api_key:API Key', 'partner_tag:Affiliate ID', 'client_id:Account ID'],
    docsUrl: 'https://braip.com/afiliados',
    commission: '20–60%',
    network: 'braip-api',
  },
  // ── Redes Multimarcas ─────────────────────────────────
  {
    id: 'socialsoul',
    name: 'SocialSoul / Lomadee',
    group: 'Redes Multimarcas',
    icon: '🌐',
    color: '#6366F1',
    bg: '#f0f0ff',
    border: '#6366F1',
    desc: 'SocialSoul (ex-Lomadee) — rede multimarcas B2W, C&A, Renner e mais',
    fields: ['api_key:Token de Acesso', 'client_id:Source ID', 'partner_tag:Publisher ID'],
    docsUrl: 'https://developer.socialsoul.com.br/',
    commission: '2–15%',
    network: 'lomadee',
  },
  {
    id: 'awin',
    name: 'Awin',
    group: 'Redes Multimarcas',
    icon: '🌍',
    color: '#007AC9',
    bg: '#e8f4fd',
    border: '#007AC9',
    desc: 'Awin — rede global de afiliados com centenas de anunciantes no Brasil',
    fields: ['api_key:API Key', 'client_id:Publisher ID', 'partner_tag:Campaign ID'],
    docsUrl: 'https://wiki.awin.com/index.php/API',
    commission: '1–20%',
    network: 'awin',
  },
  {
    id: 'rakuten',
    name: 'Rakuten Advertising',
    group: 'Redes Multimarcas',
    icon: '🔴',
    color: '#BF0000',
    bg: '#fff0f0',
    border: '#BF0000',
    desc: 'Rakuten — rede de performance marketing com grandes marcas globais',
    fields: ['api_key:Security Token', 'client_id:Publisher ID', 'client_secret:API Secret', 'partner_tag:Site ID'],
    docsUrl: 'https://developers.rakutenadvertising.com/',
    commission: '1–15%',
    network: 'rakuten',
  },
  // ── Tecnologia & SaaS ─────────────────────────────────
  {
    id: 'hostinger',
    name: 'Hostinger',
    group: 'Tecnologia & SaaS',
    icon: '🟣',
    color: '#673DE6',
    bg: '#f5f0ff',
    border: '#673DE6',
    desc: 'Hostinger Affiliate — hospedagem, domínios e ferramentas web',
    fields: ['api_key:API Token', 'partner_tag:Referral Code', 'client_id:Account ID'],
    docsUrl: 'https://www.hostinger.com.br/afiliados',
    commission: '40–60%',
    network: 'hostinger-api',
  },
  {
    id: 'shopify',
    name: 'Shopify Partners',
    group: 'Tecnologia & SaaS',
    icon: '🟢',
    color: '#96BF48',
    bg: '#f0f7ea',
    border: '#96BF48',
    desc: 'Shopify Affiliate — indicação de lojas e soluções de e-commerce',
    fields: ['api_key:API Key', 'client_id:Partner ID', 'client_secret:API Secret Key', 'partner_tag:Referral Tag'],
    docsUrl: 'https://www.shopify.com/partners',
    commission: '20% recorrente',
    network: 'shopify-partners',
  },
  {
    id: 'nuvemshop',
    name: 'Nuvemshop / Tiendanube',
    group: 'Tecnologia & SaaS',
    icon: '☁️',
    color: '#0070F3',
    bg: '#e6f0ff',
    border: '#0070F3',
    desc: 'Nuvemshop Afiliados — indicação de plataforma de e-commerce para PMEs',
    fields: ['api_key:Token de Afiliado', 'partner_tag:Publisher ID', 'client_id:Campaign ID'],
    docsUrl: 'https://www.nuvemshop.com.br/afiliados',
    commission: '20–30%',
    network: 'nuvemshop-api',
  },
  // ── Outros / CPG ──────────────────────────────────────
  {
    id: 'nestle',
    name: 'Nestlé',
    group: 'Outros',
    icon: '🍫',
    color: '#C8102E',
    bg: '#fff0f2',
    border: '#C8102E',
    desc: 'Nestlé — programa de afiliados para produtos alimentícios e parceiros',
    fields: ['api_key:API Key', 'partner_tag:Publisher ID', 'client_id:Account ID'],
    docsUrl: 'https://www.nestle.com.br/',
    commission: 'Sob consulta',
    network: 'nestle-api',
  },
  // ── Plataformas de Parceria ──────────────────────────
  {
    id: 'ltk',
    name: 'LTK (LikeToKnow.it)',
    group: 'Plataformas de Parceria',
    icon: '💗',
    color: '#FF385C',
    bg: '#fff0f3',
    border: '#FF385C',
    desc: 'LTK Creator API — vitrine de influenciadores de moda, beleza e decoração. Cada item é um link de afiliado rastreável. Padrão ouro para conteúdo estético.',
    fields: [
      'api_key:API Key (LTK Partner Portal)',
      'client_id:Publisher ID',
      'client_secret:Client Secret',
      'partner_tag:Creator Profile ID',
    ],
    docsUrl: 'https://www.ltk.com/partner',
    commission: '5–20%',
    network: 'ltk-api',
    authType: 'OAuth2',
    scopes: ['profile.read', 'products.read', 'links.create', 'analytics.read'],
    baseUrl: 'https://api.liketoknow.it/v2',
    webhookSupport: true,
    integrations: ['Instagram', 'TikTok', 'YouTube'],
    notes: 'Ecossistema fechado mas integrado ao Instagram/TikTok. Ideal para influenciadores de lifestyle. Requer aprovação editorial.',
  },
  {
    id: 'impact',
    name: 'Impact.com',
    group: 'Plataformas de Parceria',
    icon: '⚡',
    color: '#FF6B35',
    bg: '#fff4f0',
    border: '#FF6B35',
    desc: 'Impact Partnership Cloud API — automação completa de parcerias. Apple, Canva, Uber e centenas de marcas usam Impact para gerenciar afiliados.',
    fields: [
      'api_key:Account SID (Impact Dashboard)',
      'client_secret:Auth Token',
      'client_id:Program ID',
      'partner_tag:Media Partner ID',
    ],
    docsUrl: 'https://developer.impact.com/',
    commission: '2–30% (varia por marca)',
    network: 'impact-api',
    authType: 'Basic Auth (SID + Token)',
    scopes: ['Ads', 'Conversions', 'Reports', 'Catalogs', 'Coupons'],
    baseUrl: 'https://api.impact.com/Mediapartners',
    webhookSupport: true,
    brands: ['Apple', 'Canva', 'Uber', 'Airbnb', 'Nike', 'Sephora'],
    notes: 'A API mais completa do mercado para gestão de múltiplas marcas. Ideal para quem quer um painel único com centenas de anunciantes.',
  },
  // ── Live Commerce ─────────────────────────────────────
  {
    id: 'twitch',
    name: 'Twitch + Amazon Afiliados',
    group: 'Live Commerce',
    icon: '🎮',
    color: '#9146FF',
    bg: '#f5f0ff',
    border: '#9146FF',
    desc: 'Twitch Extensions API + Amazon Associates — overlays interativos em lives. Espectador clica e compra sem fechar a transmissão. Referência para público gamer e tech.',
    fields: [
      'api_key:Amazon Access Key (PA-API)',
      'client_id:Twitch Client ID (dev.twitch.tv)',
      'client_secret:Twitch Client Secret',
      'partner_tag:Amazon Associate Tag',
    ],
    docsUrl: 'https://dev.twitch.tv/docs/extensions/',
    commission: '1–10% (Amazon) + bits Twitch',
    network: 'twitch-api',
    authType: 'OAuth2 (Twitch) + AWS Signature (Amazon)',
    scopes: ['channel:read:subscriptions', 'bits:read', 'channel:manage:extensions'],
    baseUrl: 'https://api.twitch.tv/helix',
    webhookSupport: true,
    notes: 'Integração dupla: Twitch Extensions para overlays interativos + Amazon PA-API para produtos. Ideal para streamers que vendem produtos tech/gamer durante lives.',
  },
  // ── Discovery Commerce ────────────────────────────────
  {
    id: 'pinterest',
    name: 'Pinterest Shopping API v5',
    group: 'Discovery Commerce',
    icon: '📌',
    color: '#E60023',
    bg: '#fff0f0',
    border: '#E60023',
    desc: 'Pinterest API v5 — catálogos dinâmicos, Pins automatizados e API de Conversões. Ideal para moda, decoração e DIY. Automação de novos produtos como Pins.',
    fields: [
      'api_key:Access Token (Pinterest Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Ad Account ID',
    ],
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/',
    commission: '3–10%',
    network: 'pinterest-api',
    authType: 'OAuth2',
    scopes: ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'catalogs:read', 'catalogs:write', 'ads:read'],
    baseUrl: 'https://api.pinterest.com/v5',
    webhookSupport: true,
    notes: 'API v5 focada em Shopping: catálogos dinâmicos automáticos + Conversion API para otimizar anúncios. Criar Pin automaticamente ao adicionar novo produto na base de dados.',
  },
  // ── E-commerce Builder ────────────────────────────────
  {
    id: 'woocommerce',
    name: 'WooCommerce Affiliates',
    group: 'E-commerce Builder',
    icon: '🛍️',
    color: '#7F54B3',
    bg: '#f5f0ff',
    border: '#7F54B3',
    desc: 'WooCommerce REST API + plugins de afiliados (AffiliateWP, YITH) — crie sua própria rede multi-vendor onde outros vendem e ganham comissão automática.',
    fields: [
      'api_key:Consumer Key (WooCommerce → Settings → REST API)',
      'client_secret:Consumer Secret',
      'client_id:Site URL (ex: minhaloja.com)',
      'partner_tag:Affiliate Program Slug',
    ],
    docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    commission: 'Você define (5–30%)',
    network: 'woocommerce-api',
    authType: 'Basic Auth (Consumer Key/Secret) ou OAuth1',
    scopes: ['products', 'orders', 'customers', 'coupons', 'reports'],
    baseUrl: 'https://seusite.com/wp-json/wc/v3',
    webhookSupport: true,
    plugins: ['AffiliateWP', 'YITH WooCommerce Affiliates', 'SliceWP'],
    notes: 'Você vira o dono da plataforma. Use plugins como AffiliateWP para criar rede própria onde afiliados ganham comissão automática por cada venda.',
  },
  {
    id: 'shopify-store',
    name: 'Shopify Multi-vendor',
    group: 'E-commerce Builder',
    icon: '🏪',
    color: '#5C6AC4',
    bg: '#f0f1ff',
    border: '#5C6AC4',
    desc: 'Shopify Admin API + apps de afiliados (Refersion, Tapfiliate) — loja própria com sistema de comissões para afiliados/vendedores. Alternativa mais profissional ao WooCommerce.',
    fields: [
      'api_key:Admin API Access Token (Shopify Partners)',
      'client_id:API Key',
      'client_secret:API Secret Key',
      'partner_tag:Store Domain (ex: minhaloja.myshopify.com)',
    ],
    docsUrl: 'https://shopify.dev/docs/api/admin-rest',
    commission: 'Você define (5–30%)',
    network: 'shopify-store-api',
    authType: 'OAuth2 + Admin API Token',
    scopes: ['read_products', 'write_products', 'read_orders', 'write_orders', 'read_customers'],
    baseUrl: 'https://{shop}.myshopify.com/admin/api/2024-01',
    webhookSupport: true,
    apps: ['Refersion', 'Tapfiliate', 'Goaffpro', 'UpPromote'],
    notes: 'Solução enterprise para criar sua própria rede de afiliados. Use apps como Refersion para painel completo de gestão de comissões e pagamentos automáticos.',
  },
  // ── Social Commerce ──────────────────────────────────
  {
    id: 'tiktok-shop',
    name: 'TikTok Shop Afiliados',
    group: 'Social Commerce',
    icon: '🎵',
    color: '#000000',
    bg: '#f0f0f5',
    border: '#010101',
    desc: 'TikTok Shop Open API — produtos, lives de vendas, links em vídeos curtos e rastreamento de afiliados',
    fields: [
      'client_id:App ID (TikTok Developers)',
      'client_secret:App Secret',
      'api_key:Access Token',
      'partner_tag:Affiliate ID / Promo Code',
    ],
    docsUrl: 'https://partner.tiktokshop.com/doc/page/developer-guide',
    commission: '5–20%',
    network: 'tiktok-shop',
    authType: 'OAuth2',
    scopes: ['product.readonly', 'order.readonly', 'affiliate.readonly'],
    baseUrl: 'https://open-api.tiktokglobalshop.com',
    webhookSupport: true,
    notes: 'Requer conta Business no TikTok for Developers. Sandbox disponível para testes.',
  },
  {
    id: 'kwai-shop',
    name: 'Kwai Shop Afiliados',
    group: 'Social Commerce',
    icon: '🎬',
    color: '#FF6600',
    bg: '#fff4ee',
    border: '#FF6600',
    desc: 'Kwai for Business — shoppertainment com lives e vídeos curtos. Maior concorrente do TikTok Shop no Brasil.',
    fields: [
      'client_id:App Key (Kwai for Business)',
      'client_secret:App Secret',
      'api_key:Access Token',
      'partner_tag:Publisher ID / Sub ID',
    ],
    docsUrl: 'https://www.kwai-for-business.com/br',
    commission: '5–15%',
    network: 'kwai-shop',
    authType: 'OAuth2',
    scopes: ['shop.products', 'shop.orders', 'affiliate.links'],
    baseUrl: 'https://open.kwai.com/api',
    webhookSupport: true,
    notes: 'Cadastro via Kwai for Business. Ideal para criadores com audiência em vídeos curtos.',
  },
  {
    id: 'instagram-shop',
    name: 'Instagram Shopping',
    group: 'Social Commerce',
    icon: '📸',
    color: '#E1306C',
    bg: '#fff0f5',
    border: '#E1306C',
    desc: 'Meta Graph API — marcar produtos em Reels, Stories e Feed. Figurinha de link para afiliados de marketplaces parceiros.',
    fields: [
      'api_key:Access Token (Meta for Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Instagram Business Account ID',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
    commission: '2–10%',
    network: 'instagram-shop',
    authType: 'OAuth2 (Meta)',
    scopes: ['instagram_basic', 'instagram_shopping_tag_products', 'catalog_management', 'pages_read_engagement'],
    baseUrl: 'https://graph.facebook.com/v18.0',
    webhookSupport: true,
    notes: 'Requer Página do Facebook + conta Instagram Business/Creator. Cadastro em Meta for Developers.',
  },
  {
    id: 'youtube-shop',
    name: 'YouTube Shopping',
    group: 'Social Commerce',
    icon: '▶️',
    color: '#FF0000',
    bg: '#fff0f0',
    border: '#FF0000',
    desc: 'YouTube Data API v3 + Shopping — marcar produtos em Shorts, vídeos e ao vivo. Integração via Google Merchant Center.',
    fields: [
      'api_key:API Key (Google Cloud Console)',
      'client_id:OAuth 2.0 Client ID',
      'client_secret:OAuth 2.0 Client Secret',
      'partner_tag:YouTube Channel ID',
    ],
    docsUrl: 'https://developers.google.com/youtube/v3',
    commission: '3–8%',
    network: 'youtube-shop',
    authType: 'OAuth2 (Google)',
    scopes: ['youtube.readonly', 'youtubepartner', 'yt-analytics.readonly'],
    baseUrl: 'https://www.googleapis.com/youtube/v3',
    webhookSupport: false,
    notes: 'Requer Google Merchant Center vinculado + canal com +10k inscritos para Shopping em Shorts. Programa de afiliados via parceiros globais.',
  },
  {
    id: 'facebook-shop',
    name: 'Facebook Shops / Meta',
    group: 'Social Commerce',
    icon: '👥',
    color: '#1877F2',
    bg: '#eff5ff',
    border: '#1877F2',
    desc: 'Meta Graph API — catálogo de produtos no Facebook Shops, Marketplace e anúncios. Página em Modo Profissional obrigatório.',
    fields: [
      'api_key:Page Access Token (Meta for Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Facebook Page ID',
    ],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api',
    commission: '2–8%',
    network: 'facebook-shop',
    authType: 'OAuth2 (Meta)',
    scopes: ['pages_manage_metadata', 'catalog_management', 'business_management', 'ads_read'],
    baseUrl: 'https://graph.facebook.com/v18.0',
    webhookSupport: true,
    notes: 'Requer Página ou Perfil no Modo Profissional. Conformidade com Políticas de Monetização de Conteúdo da Meta. Cadastro em Meta for Developers.',
  },
]

const AFFILIATE_GROUPS = ['Marketplaces', 'Infoprodutos', 'Redes Multimarcas', 'Plataformas de Parceria', 'Live Commerce', 'Discovery Commerce', 'E-commerce Builder', 'Tecnologia & SaaS', 'Social Commerce', 'Outros']

async function renderApiConfigs(area) {
  // Garante que todos os 18 registros existam no banco (idempotente)
  await api('POST', '/admin/api/api-configs/seed').catch(() => {})

  const dbData = await api('GET', '/admin/api/api-configs')
  if (!dbData) return

  // Mapeia configs do banco por network id
  const dbMap = {}
  ;(dbData || []).forEach(cfg => { dbMap[cfg.network] = cfg })

  const groupIcons = {
    'Marketplaces': '🛒',
    'Infoprodutos': '🎓',
    'Redes Multimarcas': '🌐',
    'Plataformas de Parceria': '🤝',
    'Live Commerce': '🎮',
    'Discovery Commerce': '🔍',
    'E-commerce Builder': '🏗️',
    'Tecnologia & SaaS': '⚙️',
    'Social Commerce': '📱',
    'Outros': '🏷️',
  }

  function buildCard(net) {
    const db = dbMap[net.network] || {}
    const isActive = db.is_active ?? 0
    const configId = db.id || null
    const hasKey = !!db.api_key_preview
    const hasLogo = !!db.logo_url
    const lastSync = db.last_sync_at
    const syncStatus = db.last_sync_status

    const avatarHTML = hasLogo
      ? '<div style="width:38px;height:38px;border-radius:9px;background:#fff;border:1px solid ' + net.border + '30;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.08)">'
        + '<img src="' + db.logo_url + '" alt="' + net.name + '" style="width:30px;height:30px;object-fit:contain">'
        + '</div>'
      : '<div style="width:38px;height:38px;border-radius:9px;background:' + net.color + '22;display:flex;align-items:center;justify-content:center;flex-shrink:0">'
        + '<span style="font-size:1.3rem">' + net.icon + '</span>'
        + '</div>'

    const activeBadge = isActive
      ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Ativo</span>'
      : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativo</span>'
    const keyBadge = hasKey
      ? '<span class="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">\uD83D\uDD11 Chave configurada</span>'
      : '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">\u26A0\uFE0F Sem credenciais</span>'
    const logoBadge = hasLogo ? '<span class="text-xs text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full">\uD83D\uDDBC\uFE0F Logo OK</span>' : ''
    const syncBadge = syncStatus === 'ok'
      ? '<span class="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">\u2713 Sync OK</span>'
      : syncStatus === 'error'
        ? '<span class="text-xs text-red-700 bg-red-50 px-2 py-0.5 rounded-full">\u2717 Erro sync</span>'
        : ''
    const syncLine = lastSync ? '<div class="text-xs text-slate-400 mb-2">\u00DAltima sync: ' + fDateTime(lastSync) + '</div>' : ''
    const btnClass = hasKey ? 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100' : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
    const btnLabel = hasKey ? '\u270F\uFE0F Editar credenciais' : '\uD83D\uDD0C Configurar'
    const checked = isActive ? 'checked' : ''

    return (
      '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="aff-card-' + net.id + '">'
      + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + net.bg + '; border-bottom: 2px solid ' + net.border + '20">'
      +   '<div class="flex items-center gap-2.5">'
      +     avatarHTML
      +     '<div>'
      +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + net.name + '</div>'
      +       '<div class="text-xs font-medium mt-0.5" style="color:' + net.color + '">' + net.commission + ' comiss\u00E3o</div>'
      +     '</div>'
      +   '</div>'
      +   '<label class="toggle-switch flex-shrink-0">'
      +     '<input type="checkbox" ' + checked + ' data-network="' + net.network + '" data-config-id="' + configId + '" onchange="toggleAffNetwork(this.dataset.network, this.dataset.configId, this.checked)">'
      +     '<span class="toggle-slider"></span>'
      +   '</label>'
      + '</div>'
      + '<div class="px-4 py-3">'
      +   '<p class="text-xs text-slate-500 mb-3 leading-relaxed">' + net.desc + '</p>'
      +   '<div class="flex items-center gap-2 flex-wrap mb-3">' + activeBadge + keyBadge + logoBadge + syncBadge + '</div>'
      +   syncLine
      +   '<div class="flex items-center gap-2 mt-2">'
      +     '<button data-net-id="' + net.id + '" onclick="openAffModal(this.dataset.netId)" class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border transition-all ' + btnClass + '">' + btnLabel + '</button>'
      +     '<a href="' + net.docsUrl + '" target="_blank" class="text-xs text-slate-400 hover:text-blue-600 transition-colors px-2" title="Ver documenta\u00E7\u00E3o">\uD83D\uDCC4</a>'
      +   '</div>'
      + '</div>'
      + '</div>'
    )
  }

  // ── Cards de empresas customizadas ──────────────────────────────────────────
  function buildCustomCard(cfg) {
    const isActive = cfg.is_active ?? 0
    const hasKey   = !!cfg.api_key_preview
    const color    = cfg.color || '#6366F1'
    const icon     = cfg.icon  || '🔌'
    const commission = cfg.commission_rate ? cfg.commission_rate + '%' : '—'
    const avatarHTML = cfg.logo_url
      ? '<div style="width:38px;height:38px;border-radius:9px;background:#fff;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.08)">'
        + '<img src="' + cfg.logo_url + '" alt="' + cfg.name + '" style="width:30px;height:30px;object-fit:contain">'
        + '</div>'
      : '<div style="width:38px;height:38px;border-radius:9px;background:' + color + '22;display:flex;align-items:center;justify-content:center;flex-shrink:0">'
        + '<span style="font-size:1.3rem">' + icon + '</span>'
        + '</div>'
    const activeBadge = isActive
      ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Ativo</span>'
      : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativo</span>'
    const keyBadge = hasKey
      ? '<span class="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">\uD83D\uDD11 Chave configurada</span>'
      : '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">\u26A0\uFE0F Sem credenciais</span>'
    const checked = isActive ? 'checked' : ''
    const btnClass = hasKey ? 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100' : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
    const btnLabel = hasKey ? '\u270F\uFE0F Editar' : '\uD83D\uDD0C Configurar'
    return (
      '<div class="bg-white rounded-2xl border-2 border-indigo-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="aff-card-custom-' + cfg.id + '">'
      + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + color + '12; border-bottom: 2px solid ' + color + '30">'
      +   '<div class="flex items-center gap-2.5">'
      +     avatarHTML
      +     '<div>'
      +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + cfg.name + '</div>'
      +       '<div class="text-xs font-medium mt-0.5" style="color:' + color + '">' + commission + ' comiss\u00E3o</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="flex items-center gap-2">'
      +     '<span class="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">custom</span>'
      +     '<label class="toggle-switch flex-shrink-0">'
      +       '<input type="checkbox" ' + checked + ' data-network="' + cfg.network + '" data-config-id="' + cfg.id + '" onchange="toggleAffNetwork(this.dataset.network, this.dataset.configId, this.checked)">'
      +       '<span class="toggle-slider"></span>'
      +     '</label>'
      +   '</div>'
      + '</div>'
      + '<div class="px-4 py-3">'
      +   '<p class="text-xs text-slate-500 mb-3 leading-relaxed">' + (cfg.description || cfg.network) + '</p>'
      +   '<div class="flex items-center gap-2 flex-wrap mb-3">' + activeBadge + keyBadge + '</div>'
      +   '<div class="flex items-center gap-2 mt-2">'
      +     '<button data-net-id="' + cfg.id + '" onclick="openCustomConfigModal(this.dataset.netId)" class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border transition-all ' + btnClass + '">' + btnLabel + '</button>'
      +     '<button data-custom-id="' + cfg.id + '" data-custom-name="' + cfg.name + '" onclick="deleteCustomIntegration(this.dataset.customId, this.dataset.customName)" class="flex-shrink-0 w-8 h-8 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl border border-slate-200 transition-colors" title="Remover empresa">'
      +       '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>'
      +     '</button>'
      +   '</div>'
      + '</div>'
      + '</div>'
    )
  }

  // Separa customizadas
  const customEntries = (dbData || []).filter(cfg => cfg.custom)

  let groupsHTML = ''
  AFFILIATE_GROUPS.forEach(group => {
    const nets = AFFILIATE_NETWORKS.filter(n => n.group === group)
    if (!nets.length) return
    const activeCount = nets.filter(n => (dbMap[n.network]?.is_active ?? 0)).length
    groupsHTML += \`
      <div class="mb-8">
        <div class="flex items-center gap-3 mb-4">
          <span class="text-xl">\${groupIcons[group]}</span>
          <h3 class="text-base font-bold text-slate-800">\${group}</h3>
          <span class="text-xs font-medium px-2 py-0.5 rounded-full \${activeCount > 0 ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}">
            \${activeCount}/\${nets.length} ativos
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          \${nets.map(buildCard).join('')}
        </div>
      </div>
    \`
  })

  // Bloco empresas customizadas
  const totalCustom = customEntries.length
  const customHTML = totalCustom > 0 ? \`
    <div class="mb-8">
      <div class="flex items-center gap-3 mb-4">
        <span class="text-xl">✨</span>
        <h3 class="text-base font-bold text-slate-800">Minhas Empresas</h3>
        <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
          \${totalCustom} cadastradas
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        \${customEntries.map(buildCustomCard).join('')}
      </div>
    </div>
  \` : ''

  // Sumário geral
  const totalActive = AFFILIATE_NETWORKS.filter(n => dbMap[n.network]?.is_active).length
  const totalConfigured = AFFILIATE_NETWORKS.filter(n => dbMap[n.network]?.api_key_preview).length

  area.innerHTML = \`
    <div class="section">
      <!-- Banner de segurança -->
      <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-3">
        <span class="text-xl flex-shrink-0">🔒</span>
        <div>
          <strong>Segurança:</strong> As chaves são mascaradas na exibição. Em produção, prefira usar
          <code class="bg-amber-100 px-1.5 py-0.5 rounded text-xs">wrangler secret put AMAZON_ACCESS_KEY</code>
          para guardar segredos fora do banco. Ative o <strong>Cloudflare Zero Trust</strong> na rota
          <code class="bg-amber-100 px-1 rounded text-xs">/admin</code> para proteção máxima.
        </div>
      </div>

      <!-- Cabeçalho + botão Cadastrar -->
      <div class="flex items-end justify-between gap-4">
        <div class="grid grid-cols-4 gap-4 flex-1">
          <div class="stat-card text-center border-t-4 border-blue-400">
            <div class="text-3xl font-black text-slate-800">\${AFFILIATE_NETWORKS.length + totalCustom}</div>
            <div class="text-sm text-slate-500 mt-1">Redes disponíveis</div>
          </div>
          <div class="stat-card text-center border-t-4 border-green-400">
            <div class="text-3xl font-black text-green-700">\${totalActive}</div>
            <div class="text-sm text-slate-500 mt-1">Redes ativas</div>
          </div>
          <div class="stat-card text-center border-t-4 border-amber-400">
            <div class="text-3xl font-black text-amber-700">\${totalConfigured}</div>
            <div class="text-sm text-slate-500 mt-1">Com credenciais</div>
          </div>
          <div class="stat-card text-center border-t-4 border-indigo-400">
            <div class="text-3xl font-black text-indigo-700">\${totalCustom}</div>
            <div class="text-sm text-slate-500 mt-1">Customizadas</div>
          </div>
        </div>
        <button onclick="openNewIntegrationModal()"
          class="flex-shrink-0 flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white font-bold px-5 py-3 rounded-xl shadow-md hover:shadow-lg transition-all text-sm whitespace-nowrap">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
          Cadastrar nova empresa
        </button>
      </div>

      <!-- Empresas customizadas (topo, destaque) -->
      \${customHTML}

      <!-- Cards por grupo (redes padrão) -->
      \${groupsHTML}
    </div>
  \`
}

// Abre modal de configuração da rede pelo id estático
function openAffModal(netId) {
  const net = AFFILIATE_NETWORKS.find(n => n.id === netId)
  if (!net) return

  const fieldsHTML = net.fields.map(f => {
    const [fieldKey, fieldLabel] = f.split(':')
    const isSecret = ['api_key','client_secret'].includes(fieldKey)
    const placeholders = {
      api_key: '••••••••••••••••',
      client_id: 'ex: 12345678',
      client_secret: '••••••••••••••••',
      partner_tag: 'ex: seusite-20',
    }
    return \`
      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1">\${fieldLabel}</label>
        <input type="\${isSecret ? 'password' : 'text'}"
               id="modal-\${fieldKey}"
               class="input"
               placeholder="\${placeholders[fieldKey] || ''}">
      </div>
    \`
  }).join('')

  const modal = document.getElementById('modal-container')
  modal.innerHTML = \`
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal max-w-lg" style="max-height:90vh;overflow-y:auto;">

        <!-- Header com logo preview -->
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div id="modal-logo-preview"
               style="width:52px;height:52px;border-radius:12px;background:\${net.color};flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);overflow:hidden;">
            <span class="text-2xl" id="modal-logo-emoji">\${net.icon}</span>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-slate-800 text-lg leading-tight">\${net.name}</h3>
            <p class="text-xs text-slate-500 mt-0.5 truncate">\${net.desc}</p>
          </div>
        </div>

        <!-- Campo Logo URL (destaque visual) -->
        <div class="bg-slate-50 rounded-xl p-3 mb-4 border border-slate-200">
          <label class="block text-sm font-bold text-slate-700 mb-2">
            🖼️ Logo da empresa
          </label>
          <div class="flex gap-2 items-center">
            <input type="url" id="modal-logo-url" class="input flex-1 text-xs"
                   placeholder="https://logo.clearbit.com/amazon.com.br"
                   data-net-color="\${net.color}"
                   oninput="previewLogo(this.value, this.dataset.netColor)">
            <button type="button"
                    data-net-id="\${net.id}" data-net-name="\${net.name}" data-net-color="\${net.color}"
                    onclick="autoFetchLogo(this.dataset.netId, this.dataset.netName, this.dataset.netColor)"
                    class="flex-shrink-0 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-2 rounded-lg transition-all whitespace-nowrap">
              ✨ Auto
            </button>
          </div>
          <p class="text-xs text-slate-400 mt-1.5">
            Cole a URL da logo (PNG/SVG) ou clique em <strong>Auto</strong> para buscar automaticamente
          </p>
          <!-- Sugestões rápidas -->
          <div class="flex flex-wrap gap-1.5 mt-2">
            <button data-logo-url="https://logo.clearbit.com/\${net.id}.com" data-net-color="\${net.color}"
                    onclick="var u=this.dataset.logoUrl; document.getElementById('modal-logo-url').value=u; previewLogo(u, this.dataset.netColor)"
                    class="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-md hover:border-blue-300 hover:text-blue-600 transition-all">
              Clearbit
            </button>
            <button data-logo-url="https://www.google.com/s2/favicons?domain=\${net.id}.com.br&sz=64" data-net-color="\${net.color}"
                    onclick="var u=this.dataset.logoUrl; document.getElementById('modal-logo-url').value=u; previewLogo(u, this.dataset.netColor)"
                    class="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-md hover:border-blue-300 hover:text-blue-600 transition-all">
              Google Favicon
            </button>
            <button data-net-color="\${net.color}"
                    onclick="document.getElementById('modal-logo-url').value=String(); previewLogo(String(), this.dataset.netColor)"
                    class="text-xs bg-white border border-red-100 text-red-400 px-2 py-0.5 rounded-md hover:bg-red-50 transition-all">
              Limpar
            </button>
          </div>
        </div>

        <!-- Demais campos -->
        <div class="space-y-3">
          \${fieldsHTML}
          <div class="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="modal-rate-limit" class="input" placeholder="10">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Comissão base (%)</label>
              <input type="number" id="modal-commission" class="input" placeholder="5.0" step="0.1">
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveAffConfig('\${net.network}', \${JSON.stringify(net.fields).replace(/'/g,'&#39;')})"
            class="btn-primary flex-1">💾 Salvar configuração</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
          <a href="\${net.docsUrl}" target="_blank"
             class="text-xs text-slate-400 hover:text-blue-600 transition-colors flex-shrink-0" title="Ver documentação">📄</a>
        </div>
      </div>
    </div>
  \`
}

// Preview da logo em tempo real no header do modal
function previewLogo(url, color) {
  const preview = document.getElementById('modal-logo-preview')
  const emoji   = document.getElementById('modal-logo-emoji')
  if (!preview) return
  if (!url) {
    // Volta para emoji/ícone
    preview.style.background = color
    preview.innerHTML = \`<span class="text-2xl" id="modal-logo-emoji">\${emoji ? emoji.textContent : '🔌'}</span>\`
    return
  }
  // Mostra spinner enquanto carrega
  preview.innerHTML = \`<div style="width:20px;height:20px;border:2px solid white;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div>\`
  const img = new Image()
  img.onload = () => {
    preview.style.background = '#fff'
    preview.innerHTML = \`<img src="\${url}" style="width:42px;height:42px;object-fit:contain;border-radius:6px;">\`
  }
  img.onerror = () => {
    preview.style.background = color
    preview.innerHTML = \`<span style="color:white;font-size:11px;font-weight:700;text-align:center;padding:2px;">Erro</span>\`
    toast('URL inválida ou imagem não carregou', 'error')
  }
  img.src = url
}

// Auto-busca a logo pela Clearbit usando o domínio da rede
function autoFetchLogo(netId, netName, color) {
  const domainMap = {
    amazon:       'amazon.com.br',
    mercadolivre: 'mercadolivre.com.br',
    magalu:       'magazineluiza.com.br',
    shopee:       'shopee.com.br',
    shein:        'shein.com',
    aliexpress:   'aliexpress.com',
    dafiti:       'dafiti.com.br',
    hotmart:      'hotmart.com',
    eduzz:        'eduzz.com',
    monetizze:    'monetizze.com.br',
    braip:        'braip.com',
    socialsoul:   'socialsoul.com.br',
    awin:         'awin.com',
    rakuten:      'rakuten.com',
    hostinger:    'hostinger.com.br',
    shopify:      'shopify.com',
    nuvemshop:    'nuvemshop.com.br',
    nestle:       'nestle.com.br',
  }
  const domain = domainMap[netId] || (netId + '.com')
  const url = \`https://logo.clearbit.com/\${domain}\`
  const input = document.getElementById('modal-logo-url')
  if (input) input.value = url
  previewLogo(url, color)
  toast('Buscando logo...', 'info')
}

async function saveAffConfig(network, fields) {
  // Monta o body lendo os inputs do modal
  const body = { rate_limit_per_min: undefined, commission_rate: undefined }
  fields.forEach(f => {
    const [fieldKey] = f.split(':')
    const el = document.getElementById(\`modal-\${fieldKey}\`)
    if (el && el.value.trim()) body[fieldKey] = el.value.trim()
  })
  const rateEl = document.getElementById('modal-rate-limit')
  const commEl = document.getElementById('modal-commission')
  const logoEl = document.getElementById('modal-logo-url')
  if (rateEl && rateEl.value) body.rate_limit_per_min = parseInt(rateEl.value)
  if (commEl && commEl.value) body.commission_rate = parseFloat(commEl.value)
  if (logoEl && logoEl.value.trim()) body.logo_url = logoEl.value.trim()

  // Usa rota por network — funciona para todas as 18 redes independente do id
  const res = await api('PUT', \`/admin/api/api-configs/by-network/\${network}\`, body)
  if (res && res.ok) {
    toast('Configuração salva ✓', 'success')
  } else {
    toast('Erro ao salvar — tente novamente', 'error')
  }
  closeModal()
  renderApiConfigs(document.getElementById('content-area'))
}

async function toggleAffNetwork(network, configId, active) {
  // Usa rota por network — não depende do configId estar no banco
  await api('PUT', \`/admin/api/api-configs/by-network/\${network}/toggle\`, { active })
  toast(active ? '✓ Integração ativada' : 'Integração desativada', active ? 'success' : 'info')
  renderApiConfigs(document.getElementById('content-area'))
}

async function toggleApiConfig(id, active) {
  await api('PATCH', \`/admin/api/api-configs/\${id}/toggle\`, { active })
  toast(active ? 'API ativada ✓' : 'API desativada', active ? 'success' : 'info')
}

// ── Modal: Cadastrar nova empresa ────────────────────────────────────────────
function openNewIntegrationModal() {
  const groups = ['Marketplaces','Infoprodutos','Redes Multimarcas','Plataformas de Parceria','Live Commerce','Discovery Commerce','E-commerce Builder','Tecnologia & SaaS','Social Commerce','Outros']
  const modal = document.getElementById('modal-container')
  modal.innerHTML = \`
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:520px;max-height:90vh;overflow-y:auto;">

        <!-- Header -->
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div id="new-int-logo-preview"
            style="width:52px;height:52px;border-radius:12px;background:#6366F1;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.8rem;box-shadow:0 4px 12px rgba(0,0,0,0.15)">
            🔌
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg leading-tight">Cadastrar nova empresa</h3>
            <p class="text-xs text-slate-500 mt-0.5">Adicione uma nova integração de API ou rede afiliada</p>
          </div>
        </div>

        <!-- Campos principais -->
        <div class="space-y-3">

          <!-- Nome + Ícone -->
          <div class="grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <label class="block text-sm font-semibold text-slate-700 mb-1">Nome da empresa <span class="text-red-500">*</span></label>
              <input type="text" id="new-int-name" class="input" placeholder="ex: Casas Bahia Afiliados"
                oninput="document.getElementById('new-int-logo-preview').title=this.value">
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Ícone (emoji)</label>
              <input type="text" id="new-int-icon" class="input text-center text-xl" placeholder="🏪" maxlength="4"
                oninput="var p=document.getElementById('new-int-logo-preview'); if(!document.getElementById('new-int-logo-url').value){p.innerHTML=this.value||'🔌'}">
            </div>
          </div>

          <!-- Network ID -->
          <div>
            <label class="block text-sm font-semibold text-slate-700 mb-1">
              ID da rede (network) <span class="text-red-500">*</span>
              <span class="text-xs font-normal text-slate-400 ml-1">— identificador único, ex: casasbahia-api</span>
            </label>
            <input type="text" id="new-int-network" class="input font-mono text-sm" placeholder="ex: minha-loja-api"
              oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'-')">
          </div>

          <!-- Descrição -->
          <div>
            <label class="block text-sm font-semibold text-slate-700 mb-1">Descrição</label>
            <input type="text" id="new-int-desc" class="input" placeholder="ex: API de afiliados da Casas Bahia — produtos, links e comissões">
          </div>

          <!-- Grupo + Comissão -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Grupo</label>
              <select id="new-int-group" class="input">
                \${groups.map(g => \`<option value="\${g}">\${g}</option>\`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Comissão base (%)</label>
              <input type="number" id="new-int-commission" class="input" placeholder="ex: 8.5" step="0.1" min="0" max="100">
            </div>
          </div>

          <!-- Cor + Tipo de auth -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Cor da marca</label>
              <div class="flex gap-2 items-center">
                <input type="color" id="new-int-color" value="#6366F1" class="h-10 w-14 rounded-lg border border-slate-200 cursor-pointer p-1"
                  oninput="document.getElementById('new-int-logo-preview').style.background=this.value">
                <input type="text" id="new-int-color-text" class="input flex-1 font-mono text-sm" value="#6366F1" placeholder="#6366F1"
                  oninput="document.getElementById('new-int-color').value=this.value; document.getElementById('new-int-logo-preview').style.background=this.value">
              </div>
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Tipo de autenticação</label>
              <select id="new-int-auth" class="input">
                <option>API Key</option>
                <option>OAuth2</option>
                <option>Bearer Token</option>
                <option>Basic Auth</option>
                <option>Webhook</option>
                <option>Feed XML/CSV</option>
                <option>Outro</option>
              </select>
            </div>
          </div>

          <!-- Logo URL -->
          <div class="bg-slate-50 rounded-xl p-3 border border-slate-200">
            <label class="block text-sm font-bold text-slate-700 mb-2">🖼️ Logo da empresa</label>
            <div class="flex gap-2">
              <input type="url" id="new-int-logo-url" class="input flex-1 text-xs"
                placeholder="https://logo.clearbit.com/empresa.com.br"
                oninput="newIntPreviewLogo(this.value)">
              <button type="button" onclick="newIntAutoLogo()"
                class="flex-shrink-0 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap">
                ✨ Auto
              </button>
            </div>
            <p class="text-xs text-slate-400 mt-1.5">Cole a URL ou clique em <strong>Auto</strong> para buscar pela Clearbit</p>
          </div>

          <!-- Divisor: Credenciais (opcionais) -->
          <div class="border-t border-slate-100 pt-3">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Credenciais (opcional — pode configurar depois)</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
                <input type="password" id="new-int-api-key" class="input" placeholder="••••••••••••">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
                <input type="text" id="new-int-client-id" class="input" placeholder="ex: app-12345">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
                <input type="password" id="new-int-client-secret" class="input" placeholder="••••••••••••">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / ID afiliado</label>
                <input type="text" id="new-int-partner-tag" class="input" placeholder="ex: seusite-20">
              </div>
            </div>
          </div>

          <!-- URL Docs -->
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">URL da documentação</label>
            <input type="url" id="new-int-docs" class="input text-xs" placeholder="https://dev.empresa.com/docs">
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveNewIntegration()"
            class="btn-primary flex-1 flex items-center justify-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
            </svg>
            Cadastrar empresa
          </button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>

      </div>
    </div>
  \`
}

function newIntPreviewLogo(url) {
  const preview = document.getElementById('new-int-logo-preview')
  if (!preview) return
  if (!url) { preview.innerHTML = document.getElementById('new-int-icon')?.value || '🔌'; return }
  preview.innerHTML = '<div style="width:20px;height:20px;border:2px solid white;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div>'
  const img = new Image()
  img.onload = () => { preview.style.background = '#fff'; preview.innerHTML = '<img src="'+url+'" style="width:42px;height:42px;object-fit:contain;border-radius:6px;">' }
  img.onerror = () => { preview.style.background = document.getElementById('new-int-color')?.value || '#6366F1'; preview.innerHTML = document.getElementById('new-int-icon')?.value || '🔌'; toast('Logo não carregou', 'error') }
  img.src = url
}

function newIntAutoLogo() {
  const network = document.getElementById('new-int-network')?.value || ''
  const domain = network.replace(/-api$|-shop$|-afiliados$/, '') + '.com.br'
  const url = 'https://logo.clearbit.com/' + domain
  const input = document.getElementById('new-int-logo-url')
  if (input) input.value = url
  newIntPreviewLogo(url)
  toast('Buscando logo...', 'info')
}

async function saveNewIntegration() {
  const name    = document.getElementById('new-int-name')?.value.trim()
  const network = document.getElementById('new-int-network')?.value.trim()
  if (!name || !network) { toast('Nome e ID da rede são obrigatórios', 'error'); return }

  const body = {
    name,
    network,
    group:           document.getElementById('new-int-group')?.value || 'Outros',
    description:     document.getElementById('new-int-desc')?.value.trim() || null,
    commission_rate: parseFloat(document.getElementById('new-int-commission')?.value) || 0,
    color:           document.getElementById('new-int-color')?.value || '#6366F1',
    icon:            document.getElementById('new-int-icon')?.value.trim() || '🔌',
    auth_type:       document.getElementById('new-int-auth')?.value || 'API Key',
    logo_url:        document.getElementById('new-int-logo-url')?.value.trim() || null,
    docs_url:        document.getElementById('new-int-docs')?.value.trim() || null,
    api_key:         document.getElementById('new-int-api-key')?.value.trim() || null,
    client_id:       document.getElementById('new-int-client-id')?.value.trim() || null,
    client_secret:   document.getElementById('new-int-client-secret')?.value.trim() || null,
    partner_tag:     document.getElementById('new-int-partner-tag')?.value.trim() || null,
  }

  const btn = document.querySelector('#modal-container .btn-primary')
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...' }

  const res = await api('POST', '/admin/api/api-configs/new', body)
  if (res?.ok) {
    toast('Empresa cadastrada com sucesso! ✓', 'success')
    closeModal()
    renderApiConfigs(document.getElementById('content-area'))
  } else {
    toast(res?.error || 'Erro ao cadastrar empresa', 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg> Cadastrar empresa' }
  }
}

// ── Modal: Configurar empresa customizada ────────────────────────────────────
async function openCustomConfigModal(cfgId) {
  const dbData = await api('GET', '/admin/api/api-configs')
  const cfg = (dbData || []).find(c => c.id === cfgId)
  if (!cfg) { toast('Empresa não encontrada', 'error'); return }

  const modal = document.getElementById('modal-container')
  modal.innerHTML = \`
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:480px;max-height:90vh;overflow-y:auto;">
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div style="width:52px;height:52px;border-radius:12px;background:\${cfg.color||'#6366F1'};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.8rem;box-shadow:0 4px 12px rgba(0,0,0,0.15)">
            \${cfg.icon||'🔌'}
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg">\${cfg.name}</h3>
            <p class="text-xs text-slate-500 font-mono">\${cfg.network}</p>
          </div>
        </div>
        <div class="space-y-3">
          <div><label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
            <input type="password" id="ccfg-api-key" class="input" placeholder="••••••••••••"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
            <input type="text" id="ccfg-client-id" class="input" placeholder="ex: app-12345"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
            <input type="password" id="ccfg-client-secret" class="input" placeholder="••••••••••••"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / ID afiliado</label>
            <input type="text" id="ccfg-partner-tag" class="input" placeholder="ex: seusite-20"></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="ccfg-rate" class="input" placeholder="10"></div>
            <div><label class="block text-sm font-medium text-slate-600 mb-1">Comissão (%)</label>
              <input type="number" id="ccfg-commission" class="input" placeholder="\${cfg.commission_rate||5}" step="0.1"></div>
          </div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Logo URL</label>
            <input type="url" id="ccfg-logo" class="input text-xs" placeholder="https://logo.clearbit.com/empresa.com.br"></div>
        </div>
        <div class="flex gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveCustomConfig('\${cfgId}')" class="btn-primary flex-1">💾 Salvar</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  \`
}

async function saveCustomConfig(cfgId) {
  const body = {
    api_key:         document.getElementById('ccfg-api-key')?.value.trim() || undefined,
    client_id:       document.getElementById('ccfg-client-id')?.value.trim() || undefined,
    client_secret:   document.getElementById('ccfg-client-secret')?.value.trim() || undefined,
    partner_tag:     document.getElementById('ccfg-partner-tag')?.value.trim() || undefined,
    rate_limit_per_min: parseInt(document.getElementById('ccfg-rate')?.value) || undefined,
    commission_rate: parseFloat(document.getElementById('ccfg-commission')?.value) || undefined,
    logo_url:        document.getElementById('ccfg-logo')?.value.trim() || undefined,
  }
  const res = await api('PATCH', \`/admin/api/api-configs/\${cfgId}\`, body)
  if (res?.ok) { toast('Configuração salva ✓', 'success'); closeModal(); renderApiConfigs(document.getElementById('content-area')) }
  else toast('Erro ao salvar', 'error')
}

// ── Deletar empresa customizada ──────────────────────────────────────────────
async function deleteCustomIntegration(cfgId, name) {
  if (!confirm('Remover a empresa "' + name + '"? Esta ação não pode ser desfeita.')) return
  const res = await api('DELETE', \`/admin/api/api-configs/\${cfgId}\`)
  if (res?.ok) { toast('Empresa removida ✓', 'success'); renderApiConfigs(document.getElementById('content-area')) }
  else toast(res?.error || 'Erro ao remover', 'error')
}


function editApiConfig(id, name) {
  const modal = document.getElementById('modal-container')
  modal.innerHTML = \`
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3 class="font-bold text-slate-800 text-lg mb-4">🔌 Configurar: \${name}</h3>
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
            <input type="password" id="cfg-api-key" class="input" placeholder="••••••••••••">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
            <input type="text" id="cfg-client-id" class="input" placeholder="ex: app-12345">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
            <input type="password" id="cfg-client-secret" class="input" placeholder="••••••••••••">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / Affiliate ID</label>
            <input type="text" id="cfg-partner-tag" class="input" placeholder="ex: seusite-20">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="cfg-rate-limit" class="input" placeholder="10">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Comissão (%)</label>
              <input type="number" id="cfg-commission" class="input" placeholder="5.0" step="0.1">
            </div>
          </div>
        </div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveApiConfig('\${id}')" class="btn-primary flex-1">Salvar</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  \`
}

async function saveApiConfig(id) {
  const body = {
    api_key: document.getElementById('cfg-api-key').value || undefined,
    client_id: document.getElementById('cfg-client-id').value || undefined,
    client_secret: document.getElementById('cfg-client-secret').value || undefined,
    partner_tag: document.getElementById('cfg-partner-tag').value || undefined,
    rate_limit_per_min: parseInt(document.getElementById('cfg-rate-limit').value) || undefined,
    commission_rate: parseFloat(document.getElementById('cfg-commission').value) || undefined,
  }
  await api('PATCH', \`/admin/api/api-configs/\${id}\`, body)
  toast('Configuração salva ✓', 'success')
  closeModal()
  renderApiConfigs(document.getElementById('content-area'))
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = ''
}

// ── QUEUE ─────────────────────────────────────────────────
async function renderQueue(area) {
  const data = await api('GET', '/admin/api/queue')
  if (!data) return
  const statusBadge = s => s === 'pending' ? badge(s,'yellow') : s === 'done' ? badge(s,'green') : badge(s,'red')
  const rows = data.map(j => \`
    <tr class="hover:bg-slate-50">
      <td class="table-td text-xs text-slate-500">\${j.id}</td>
      <td class="table-td font-medium text-sm">\${j.product_name}</td>
      <td class="table-td text-sm">\${j.store_name}</td>
      <td class="table-td text-xs text-slate-500">\${j.external_id}</td>
      <td class="table-td">
        <span class="text-sm font-bold \${j.priority<=2?'text-red-600':'text-slate-700'}">\${j.priority}</span>
        \${j.priority<=2?'<span class="text-xs text-red-500 ml-1">(urgente)</span>':''}
      </td>
      <td class="table-td">\${statusBadge(j.status)}</td>
      <td class="table-td text-xs text-slate-400">\${fDateTime(j.scheduled_for)}</td>
      <td class="table-td text-xs text-slate-400">\${j.attempts}</td>
    </tr>
  \`).join('')

  area.innerHTML = \`
    <div class="section">
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-slate-800">Fila de Atualização de Preços</h3>
          <button onclick="processQueue()" class="btn-primary">⚡ Processar Agora</button>
        </div>
        \${data.length === 0
          ? \`<div class="py-16 text-center text-slate-400"><div class="text-4xl mb-3">✅</div>Fila vazia — todos os preços atualizados</div>\`
          : \`<div class="overflow-x-auto"><table class="w-full">
              <thead><tr>
                <th class="table-th">ID</th><th class="table-th">Produto</th>
                <th class="table-th">Loja</th><th class="table-th">External ID</th>
                <th class="table-th">Prioridade</th><th class="table-th">Status</th>
                <th class="table-th">Agendado</th><th class="table-th">Tentativas</th>
              </tr></thead>
              <tbody>\${rows}</tbody>
            </table></div>\`}
      </div>
    </div>
  \`
}

async function processQueue() {
  const syncStatus = document.getElementById('sync-status')
  syncStatus.classList.remove('hidden')
  syncStatus.classList.add('flex')
  const data = await api('POST', '/api/cron/process-queue')
  syncStatus.classList.add('hidden')
  syncStatus.classList.remove('flex')
  toast(\`Processados: \${data?.processed || 0} jobs\`, 'success')
  renderQueue(document.getElementById('content-area'))
}

// ── ANALYTICS ─────────────────────────────────────────────
async function renderAnalytics(area) {
  const data = await api('GET', '/admin/api/clicks?days=7')
  if (!data) return
  area.innerHTML = \`
    <div class="section">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📈 Cliques por dia (7 dias)</h3>
          <canvas id="analytics-daily" height="200"></canvas>
        </div>
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">🏆 Cliques por loja</h3>
          <canvas id="analytics-stores" height="200"></canvas>
        </div>
        <div class="stat-card col-span-full">
          <h3 class="font-bold text-slate-800 mb-4">🔥 Produtos mais clicados</h3>
          <div class="space-y-2">
            \${(data.byProduct || []).map((p, i) => \`
              <div class="flex items-center gap-3">
                <span class="text-lg font-black text-slate-300 w-6">\${i+1}</span>
                <div class="flex-1 bg-slate-100 rounded-full h-6 overflow-hidden">
                  <div class="h-6 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full flex items-center px-3" style="width:\${Math.max(5, (p.clicks/((data.byProduct[0]?.clicks)||1))*100)}%">
                    <span class="text-white text-xs font-semibold truncate">\${p.name}</span>
                  </div>
                </div>
                <span class="text-sm font-bold text-slate-700 w-12 text-right">\${p.clicks}</span>
              </div>
            \`).join('')}
          </div>
        </div>
      </div>
    </div>
  \`

  // Gráfico diário
  if (data.byDay?.length) {
    if (App.charts.daily) App.charts.daily.destroy()
    App.charts.daily = new Chart(document.getElementById('analytics-daily'), {
      type: 'line',
      data: {
        labels: data.byDay.map(d => new Date(d.day).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})),
        datasets: [{ label:'Cliques', data: data.byDay.map(d=>d.clicks),
          borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.1)',
          fill:true, tension:.3, pointRadius:4 }]
      },
      options: { responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} }
    })
  }

  // Gráfico lojas
  if (data.byStore?.length) {
    if (App.charts.stores) App.charts.stores.destroy()
    App.charts.stores = new Chart(document.getElementById('analytics-stores'), {
      type: 'doughnut',
      data: {
        labels: data.byStore.map(s => s.store),
        datasets: [{ data: data.byStore.map(s=>s.clicks),
          backgroundColor: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16'] }]
      },
      options: { responsive:true, plugins:{legend:{position:'right'}} }
    })
  }
}

// ── USERS ─────────────────────────────────────────────────
async function renderUsers(area, page = 1) {
  const data = await api('GET', \`/admin/api/users?page=\${page}\`)
  if (!data) return

  const rows = (data.users || []).length > 0
    ? data.users.map(u => \`
      <tr class="hover:bg-slate-50">
        <td class="table-td">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm">
              \${(u.full_name || u.email || '?')[0].toUpperCase()}
            </div>
            <div>
              <div class="font-semibold text-sm text-slate-800">\${u.full_name || '—'}</div>
              <div class="text-xs text-slate-400">\${u.email}</div>
            </div>
          </div>
        </td>
        <td class="table-td">\${badge(u.role || 'customer', u.role==='admin' ? 'red' : 'blue')}</td>
        <td class="table-td">\${u.status==='active' ? badge('Ativo','green') : badge('Bloqueado','red')}</td>
        <td class="table-td text-xs text-slate-400">\${fDateTime(u.last_login_at)}</td>
        <td class="table-td text-xs text-slate-400">\${fDate(u.created_at)}</td>
        <td class="table-td">
          <div class="flex gap-2">
            \${u.status==='active'
              ? \`<button data-uid="\${u.id}" data-status="blocked" onclick="setUserStatus(this.dataset.uid, this.dataset.status)" class="btn-danger text-xs">Bloquear</button>\`
              : \`<button data-uid="\${u.id}" data-status="active" onclick="setUserStatus(this.dataset.uid, this.dataset.status)" class="btn-success text-xs">Ativar</button>\`}
            \${u.role!=='admin' ? \`<button data-uid="\${u.id}" onclick="deleteUser(this.dataset.uid)" class="btn-danger text-xs">Excluir</button>\` : ''}
          </div>
        </td>
      </tr>
    \`).join('')
    : \`<tr><td colspan="6" class="py-12 text-center text-slate-400">Nenhum usuário cadastrado ainda</td></tr>\`

  area.innerHTML = \`
    <div class="section">
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100">
          <h3 class="font-bold text-slate-800">Usuários <span class="text-slate-400 font-normal text-sm ml-1">\${data.total || 0} total</span></h3>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th">Usuário</th>
              <th class="table-th">Role</th>
              <th class="table-th">Status</th>
              <th class="table-th">Último login</th>
              <th class="table-th">Cadastro</th>
              <th class="table-th">Ações</th>
            </tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  \`
}

async function setUserStatus(id, status) {
  await api('PATCH', \`/admin/api/users/\${id}/status\`, { status })
  toast(status === 'active' ? 'Usuário ativado ✓' : 'Usuário bloqueado', status === 'active' ? 'success' : 'info')
  renderUsers(document.getElementById('content-area'))
}

async function deleteUser(id) {
  if (!confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) return
  await api('DELETE', \`/admin/api/users/\${id}\`)
  toast('Usuário excluído', 'info')
  renderUsers(document.getElementById('content-area'))
}

// ── Pagination helper ─────────────────────────────────────
function renderPagination(page, total, perPage, onPage) {
  const totalPages = Math.ceil(total / perPage)
  if (totalPages <= 1) return ''
  const btns = []
  for (let i = 1; i <= Math.min(totalPages, 7); i++) {
    btns.push(\`<button onclick="(\${onPage.toString()})(\${i})" class="px-3 py-1.5 text-sm rounded-lg border \${i===page?'bg-blue-600 text-white border-blue-600':'border-slate-200 hover:bg-slate-50'}">\${i}</button>\`)
  }
  return \`<div class="flex items-center gap-2 px-5 py-4 border-t border-slate-100">\${btns.join('')}<span class="text-sm text-slate-500 ml-2">\${total} total</span></div>\`
}

// ── Boot ──────────────────────────────────────────────────
(function init() {
  // Verifica se já tem token salvo
  if (App.token) {
    // Tenta validar
    fetch('/admin/api/dashboard', { headers: { 'Authorization': 'Bearer ' + App.token } })
      .then(r => {
        if (r.ok) {
          document.getElementById('login-screen').classList.add('hidden')
          document.getElementById('admin-app').classList.remove('hidden')
          loadSection('dashboard')
        } else {
          localStorage.removeItem('admin_token')
          App.token = ''
        }
      }).catch(() => {})
  }

  // Enter no campo de senha
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin()
  })
})()
</script>
</body>
</html>`
}

export default admin
