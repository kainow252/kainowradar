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

// ── POST /api/price-alerts — Cria alerta de preço ────────
api.post('/price-alerts', async (c) => {
  const { DB } = c.env
  const body = await c.req.json().catch(() => ({}))
  const { product_id, email, target_price } = body

  if (!product_id || !email || !target_price) {
    return c.json({ error: 'product_id, email e target_price são obrigatórios' }, 400)
  }

  // Valida email básico
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Email inválido' }, 400)
  }

  // Valida produto
  const product = await DB
    .prepare('SELECT id, name, slug, best_price FROM products WHERE id = ? AND is_active = 1')
    .bind(product_id)
    .first<any>()

  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

  // Verifica alerta duplicado
  const existing = await DB
    .prepare('SELECT id FROM price_alerts WHERE product_id = ? AND email = ? AND is_active = 1')
    .bind(product_id, email)
    .first()

  if (existing) {
    // Atualiza target_price
    await DB
      .prepare('UPDATE price_alerts SET target_price = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND email = ? AND is_active = 1')
      .bind(target_price, product_id, email)
      .run()
    return c.json({ ok: true, updated: true, message: 'Alerta atualizado!' })
  }

  await DB
    .prepare('INSERT INTO price_alerts (product_id, email, target_price, is_active) VALUES (?,?,?,1)')
    .bind(product_id, email, target_price)
    .run()

  return c.json({ ok: true, created: true, message: `Alerta criado! Você receberá um email quando o preço de "${product.name}" cair abaixo de R$ ${Number(target_price).toFixed(2)}.` })
})

// ── DELETE /api/price-alerts/:id — Remove alerta ─────────
api.delete('/price-alerts/:id', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  await DB.prepare('UPDATE price_alerts SET is_active = 0 WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ── GET /api/price-alerts?email= — Lista alertas ─────────
api.get('/price-alerts', async (c) => {
  const { DB } = c.env
  const email = c.req.query('email') || ''
  if (!email) return c.json([])

  const { results } = await DB
    .prepare(`
      SELECT pa.*, p.name as product_name, p.slug as product_slug,
             p.image_url as product_image, p.best_price as current_price
      FROM price_alerts pa
      JOIN products p ON p.id = pa.product_id
      WHERE pa.email = ? AND pa.is_active = 1
      ORDER BY pa.created_at DESC
    `)
    .bind(email)
    .all()

  return c.json(results)
})

// ── POST /api/price-alerts/notify — Cron: dispara alertas ─
// Chamado pelo Cloudflare Cron Trigger ou manualmente via admin
api.post('/price-alerts/notify', async (c) => {
  const { DB, RESEND_API_KEY } = c.env
  const authHeader = c.req.header('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return c.json({ error: 'Não autorizado' }, 401)

  // Busca alertas ativos cujo preço atual <= target_price
  const { results: alerts } = await DB
    .prepare(`
      SELECT pa.id, pa.email, pa.target_price,
             p.id as product_id, p.name as product_name,
             p.slug as product_slug, p.best_price as current_price,
             p.image_url as product_image,
             s.name as store_name
      FROM price_alerts pa
      JOIN products p ON p.id = pa.product_id
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE pa.is_active = 1
        AND p.best_price <= pa.target_price
        AND p.best_price IS NOT NULL
        AND (pa.notified_at IS NULL OR pa.notified_at < date('now', '-3 days'))
    `)
    .all<any>()

  if (alerts.length === 0) return c.json({ ok: true, sent: 0 })

  let sent = 0
  const appUrl = (c.env as any).APP_URL || 'https://shopping-compare.pages.dev'

  for (const alert of alerts) {
    try {
      if (RESEND_API_KEY) {
        await sendPriceAlertEmail({
          apiKey: RESEND_API_KEY,
          to: alert.email,
          product: {
            name: alert.product_name,
            slug: alert.product_slug,
            image: alert.product_image,
            currentPrice: alert.current_price,
            targetPrice: alert.target_price,
            storeName: alert.store_name,
          },
          appUrl,
        })
      }

      // Marca como notificado
      await DB
        .prepare('UPDATE price_alerts SET notified_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(alert.id)
        .run()

      sent++
    } catch (err) {
      console.error(`[alerts] Erro ao enviar para ${alert.email}:`, err)
    }
  }

  return c.json({ ok: true, sent, total: alerts.length })
})

// ── GET /api/recommend?q=&product_id= — IA de recomendação ──
api.get('/recommend', async (c) => {
  const { DB, CACHE, OPENAI_API_KEY } = c.env
  const q           = (c.req.query('q') || '').trim()
  const productId   = c.req.query('product_id') ? parseInt(c.req.query('product_id')!) : null
  const category    = c.req.query('category') || ''
  const limit       = Math.min(8, parseInt(c.req.query('limit') || '6'))

  if (!q && !productId && !category) {
    return c.json({ error: 'Informe q, product_id ou category' }, 400)
  }

  const cache = new CacheManager(CACHE)
  const cacheKey = `recommend:${q}:${productId}:${category}:${limit}`
  const cached = await cache.get(cacheKey)
  if (cached) return c.json(cached)

  // ─ Estratégia 1: produto de referência → busca por categoria + preço similar
  if (productId) {
    const ref = await DB
      .prepare('SELECT * FROM products WHERE id = ? AND is_active = 1')
      .bind(productId)
      .first<any>()

    if (ref) {
      const priceMin = ref.best_price * 0.5
      const priceMax = ref.best_price * 2.0

      const { results } = await DB
        .prepare(`
          SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
          FROM products p
          LEFT JOIN stores s ON s.id = p.best_store_id
          WHERE p.is_active = 1
            AND p.id != ?
            AND p.category = ?
            AND (p.best_price BETWEEN ? AND ? OR p.best_price IS NULL)
          ORDER BY
            CASE WHEN p.brand = ? THEN 0 ELSE 1 END,
            p.offer_count DESC,
            p.best_price ASC
          LIMIT ?
        `)
        .bind(productId, ref.category || '', priceMin, priceMax, ref.brand || '', limit)
        .all()

      const result = { products: results, strategy: 'similar', ref_id: productId }
      await cache.set(cacheKey, result, 600)
      return c.json(result)
    }
  }

  // ─ Estratégia 2: query textual → keywords extraídas
  if (q && OPENAI_API_KEY) {
    try {
      const aiResult = await aiRecommend(q, DB, OPENAI_API_KEY, limit)
      const result = { products: aiResult, strategy: 'ai', query: q }
      await cache.set(cacheKey, result, 300)
      return c.json(result)
    } catch {
      // Fallback para heurística se OpenAI falhar
    }
  }

  // ─ Estratégia 3: heurística — keywords no nome
  const keywords = (q || category).split(/\s+/).filter(w => w.length > 2).slice(0, 4)
  if (keywords.length === 0) {
    // Sem keywords: retorna mais populares
    const { results } = await DB
      .prepare(`
        SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
        FROM products p LEFT JOIN stores s ON s.id = p.best_store_id
        WHERE p.is_active = 1 AND p.offer_count > 0
        ORDER BY p.offer_count DESC LIMIT ?
      `)
      .bind(limit)
      .all()
    const result = { products: results, strategy: 'popular' }
    await cache.set(cacheKey, result, 900)
    return c.json(result)
  }

  // LIKE para cada keyword
  const likeConditions = keywords.map(() => 'p.name LIKE ?').join(' OR ')
  const likeBinds = keywords.map(k => `%${k}%`)

  const { results } = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.is_active = 1 AND (${likeConditions})
      ORDER BY p.offer_count DESC, p.best_price ASC
      LIMIT ?
    `)
    .bind(...likeBinds, limit)
    .all()

  const result = { products: results, strategy: 'keyword', keywords }
  await cache.set(cacheKey, result, 600)
  return c.json(result)
})

// ── Helpers ───────────────────────────────────────────────

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(ip + 'salt_shopping')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
}

// ── Resend: envio de email de alerta ──────────────────────
interface AlertEmailParams {
  apiKey: string
  to: string
  product: {
    name: string
    slug: string
    image?: string
    currentPrice: number
    targetPrice: number
    storeName?: string
  }
  appUrl: string
}

async function sendPriceAlertEmail({ apiKey, to, product, appUrl }: AlertEmailParams) {
  const productUrl = `${appUrl}/produto/${product.slug}`
  const saving = product.targetPrice - product.currentPrice
  const pct = ((saving / product.targetPrice) * 100).toFixed(0)

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alerta de Preço — MelhorPreço</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1d4ed8,#7c3aed);padding:28px 32px;text-align:center;">
      <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;">🏷️ MelhorPreço</div>
      <div style="color:#bfdbfe;margin-top:4px;font-size:14px;">Seu alerta de preço foi ativado!</div>
    </div>

    <!-- Alerta badge -->
    <div style="background:#dcfce7;border-left:4px solid #16a34a;margin:24px 32px 0;padding:12px 16px;border-radius:0 8px 8px 0;">
      <div style="color:#15803d;font-weight:700;font-size:15px;">✅ O preço caiu para o seu alvo!</div>
      <div style="color:#166534;font-size:13px;margin-top:2px;">Economize R$ ${saving.toFixed(2)} (${pct}% abaixo do seu alvo)</div>
    </div>

    <!-- Produto -->
    <div style="padding:24px 32px;">
      ${product.image ? `<img src="${product.image}" alt="${product.name}" style="width:100%;max-height:220px;object-fit:contain;border-radius:8px;margin-bottom:16px;background:#f8fafc;">` : ''}
      <h2 style="margin:0 0 16px;font-size:17px;color:#1e293b;line-height:1.4;">${product.name}</h2>

      <div style="display:flex;gap:16px;align-items:center;margin-bottom:8px;">
        <div>
          <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">Preço atual</div>
          <div style="font-size:32px;font-weight:900;color:#16a34a;">R$ ${Number(product.currentPrice).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
        </div>
        <div style="background:#f1f5f9;padding:8px 16px;border-radius:8px;text-align:center;">
          <div style="font-size:11px;color:#94a3b8;">Seu alvo</div>
          <div style="font-size:18px;font-weight:700;color:#64748b;">R$ ${Number(product.targetPrice).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
        </div>
      </div>

      ${product.storeName ? `<div style="font-size:13px;color:#64748b;margin-bottom:20px;">🏪 Disponível em: <strong>${product.storeName}</strong></div>` : ''}

      <a href="${productUrl}" style="display:block;text-align:center;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:12px;">
        Ver produto e comprar →
      </a>

      <p style="font-size:12px;color:#94a3b8;text-align:center;margin:0;">
        Este preço pode mudar a qualquer momento. Aproveite enquanto disponível!
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="font-size:12px;color:#94a3b8;margin:0;">
        Você recebeu este email porque configurou um alerta em 
        <a href="${appUrl}" style="color:#2563eb;">MelhorPreço</a>.<br>
        <a href="${appUrl}/meus-alertas?email=${encodeURIComponent(to)}" style="color:#94a3b8;">Gerenciar alertas</a>
      </p>
    </div>
  </div>
</body>
</html>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'MelhorPreço <alertas@melhorpreco.app>',
      to:      [to],
      subject: `🏷️ Alerta: ${product.name} caiu para R$ ${Number(product.currentPrice).toFixed(2)}!`,
      html,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error ${res.status}: ${err}`)
  }
}

// ── OpenAI: recomendação por IA ──────────────────────────
async function aiRecommend(q: string, DB: D1Database, apiKey: string, limit: number) {
  // 1. Pede ao GPT para extrair keywords e categoria
  const systemPrompt = `Você é um assistente de e-commerce brasileiro.
Dado um texto de busca do usuário, extraia:
1. keywords: lista de 2-4 palavras-chave relevantes (marca, modelo, tipo de produto)
2. category: categoria principal em português (ex: "Eletrônicos", "Smartphones", "Notebooks", "TV & Áudio", "Câmeras", "Games", "Eletrodomésticos", "Móveis", "Esportes", "Outros")

Responda APENAS em JSON: {"keywords": ["k1","k2"], "category": "Categoria"}`

  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: q }
      ],
      max_tokens: 150,
      temperature: 0.3,
    }),
  })

  if (!aiRes.ok) throw new Error('OpenAI error')

  const aiData = await aiRes.json() as any
  const parsed = JSON.parse(aiData.choices[0].message.content)
  const { keywords = [], category: aiCategory = '' } = parsed

  // 2. Busca produtos com keywords e categoria
  const allKeywords = keywords.slice(0, 4)
  if (allKeywords.length === 0) throw new Error('Sem keywords')

  const likeConditions = allKeywords.map(() => 'p.name LIKE ?').join(' OR ')
  const likeBinds = allKeywords.map((k: string) => `%${k}%`)

  let whereExtra = ''
  if (aiCategory && aiCategory !== 'Outros') {
    whereExtra = ` AND p.category LIKE '%${aiCategory}%'`
  }

  const { results } = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.is_active = 1 AND (${likeConditions})${whereExtra}
      ORDER BY p.offer_count DESC, p.best_price ASC
      LIMIT ?
    `)
    .bind(...likeBinds, limit)
    .all()

  return results
}

export default api
