// ============================================================
// LIB: ML Scraper v4 — Busca preços via /products/{catalog_id}/items
// ============================================================
// ESTRATÉGIA:
//   Os IDs no banco são catalog_product_id (tipo /p/MLB...) 
//   Para buscar o preço mais barato, usa:
//     GET /products/{catalog_product_id}/items?limit=5
//   Isso retorna os anúncios ativos do catálogo — precisa de OAuth com read:catalog
//
//   Fallback (se items vazio ou 403):
//     GET /products/{catalog_product_id} — traz buy_box_winner com preço
//
//   Se o produto tem item_id real (tipo MLB5878803420, não MLB24045332):
//     GET /items/{item_id} — direto
// ============================================================

export interface ScraperStats {
  total: number
  updated: number
  skipped: number
  errors: number
  duration_ms: number
  token_source: string
  details: Array<{
    ml_id: string
    name: string
    price?: number
    error?: string
    status?: number
    strategy?: string
  }>
}

const ML_API = 'https://api.mercadolibre.com'

// ── Detecta se o ID é catalog_product_id ou item_id ──────────
// catalog_product_id: MLB + número curto (5-8 dígitos) → /p/MLB...
// item_id: MLB + número longo (10+ dígitos)  → anúncio real
function isCatalogId(mlId: string): boolean {
  // catalog_product_id tem formato MLB + 5-9 dígitos
  // item_id tem formato MLB + 10+ dígitos
  const num = mlId.replace(/^MLB/i, '')
  return num.length <= 9
}

// ── Pega token disponível no KV ──────────────────────────────
export async function getBestToken(
  cache: KVNamespace,
  appId: string,
  secret: string,
): Promise<{ token: string | null; source: string }> {
  // 1) OAuth do usuário (melhor — tem todos os scopes incluindo read:catalog)
  const oauth = await cache.get('ml_access_token').catch(() => null)
  if (oauth) return { token: oauth, source: 'oauth' }

  if (!secret) return { token: null, source: 'none' }

  // 2) Tenta renovar via refresh_token (silencioso, não precisa de redirect)
  const refresh = await cache.get('ml_refresh_token').catch(() => null)
  if (refresh) {
    try {
      const res = await fetch(`${ML_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     appId,
          client_secret: secret,
          refresh_token: refresh,
        }),
      })
      if (res.ok) {
        const data: any = await res.json()
        if (data.access_token) {
          await cache.put('ml_access_token', data.access_token, { expirationTtl: data.expires_in || 21600 })
          if (data.refresh_token) {
            await cache.put('ml_refresh_token', data.refresh_token, { expirationTtl: 86400 * 30 })
          }
          return { token: data.access_token, source: 'refresh' }
        }
      }
    } catch { /* ignora */ }
  }

  // 3) client_credentials — sem escopo de usuário, mas funciona para alguns endpoints
  const appToken = await cache.get('ml_app_token').catch(() => null)
  if (appToken) return { token: appToken, source: 'cc_cache' }

  try {
    const res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     appId,
        client_secret: secret,
      }),
    })
    if (res.ok) {
      const data: any = await res.json()
      if (data.access_token) {
        await cache.put('ml_app_token', data.access_token, { expirationTtl: 18000 })
        return { token: data.access_token, source: 'cc_new' }
      }
    }
  } catch { /* ignora */ }

  return { token: null, source: 'none' }
}

// ── Tipo de resultado de preço ────────────────────────────────
interface PriceResult {
  price: number
  original_price: number | null
  title: string
  thumbnail: string | null
  in_stock: boolean
  permalink: string
  strategy: string
  status_code: number
}

// ── Estratégia 1: /products/{catalog_id}/items ────────────────
// Retorna lista de anúncios ativos do catálogo, pega o mais barato
async function fetchByCatalogItems(catalogId: string, token: string): Promise<PriceResult | null> {
  try {
    const res = await fetch(
      `${ML_API}/products/${catalogId}/items?limit=5`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'KainowRadar/1.0',
        },
      }
    )

    if (!res.ok) return null

    const data: any = await res.json().catch(() => null)
    const results: any[] = data?.results || data?.items || []

    if (results.length === 0) return null

    // Pega o mais barato — prefere com estoque, mas aceita sem estoque se for o único
    const active    = results.filter((r: any) => r.status !== 'closed' && r.status !== 'paused' && r.price)
    const withStock = active.filter((r: any) => (r.available_quantity || 1) > 0)
    const pool      = withStock.length > 0 ? withStock : active
    const best      = pool.sort((a: any, b: any) => (a.price || 0) - (b.price || 0))[0] || results[0]

    if (!best?.price) return null

    return {
      price:          best.price,
      original_price: best.original_price || null,
      title:          best.title || catalogId,
      thumbnail:      best.thumbnail || null,
      // Considera in_stock=true se tem preço e não está fechado (catálogo sempre tem alguém vendendo)
      in_stock:       best.status !== 'closed' && best.status !== 'paused',
      permalink:      best.permalink || `https://www.mercadolivre.com.br/p/${catalogId}`,
      strategy:       'catalog_items',
      status_code:    res.status,
    }
  } catch {
    return null
  }
}

// ── Estratégia 2: /products/{catalog_id} — buy_box_winner ─────
// Retorna o produto do catálogo com buy_box_winner (preço do vendedor mais barato)
async function fetchByCatalogProduct(catalogId: string, token: string): Promise<PriceResult | null> {
  try {
    const res = await fetch(
      `${ML_API}/products/${catalogId}?attributes=id,name,buy_box_winner,status`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'KainowRadar/1.0',
        },
      }
    )

    if (!res.ok) return null

    const data: any = await res.json().catch(() => null)
    if (!data) return null

    // buy_box_winner tem o item mais barato
    const bbw = data.buy_box_winner
    if (!bbw?.price) {
      // Tenta suggested_price como fallback
      const suggested = data.suggested_price || data.price
      if (!suggested) return null
      return {
        price:          suggested,
        original_price: null,
        title:          data.name || catalogId,
        thumbnail:      data.pictures?.[0]?.url || null,
        in_stock:       data.status !== 'inactive',
        permalink:      `https://www.mercadolivre.com.br/p/${catalogId}`,
        strategy:       'catalog_suggested_price',
        status_code:    res.status,
      }
    }

    return {
      price:          bbw.price,
      original_price: bbw.original_price || null,
      title:          data.name || catalogId,
      thumbnail:      data.pictures?.[0]?.url || null,
      in_stock:       true,
      permalink:      bbw.permalink || `https://www.mercadolivre.com.br/p/${catalogId}`,
      strategy:       'catalog_buy_box',
      status_code:    res.status,
    }
  } catch {
    return null
  }
}

// ── Estratégia 3: /items/{item_id} — item real ────────────────
// Para produtos que têm item_id real (MLB + 10+ dígitos)
async function fetchByItemId(itemId: string, token: string): Promise<PriceResult | null> {
  try {
    const res = await fetch(
      `${ML_API}/items/${itemId}?attributes=id,title,price,original_price,available_quantity,thumbnail,permalink,status`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'KainowRadar/1.0',
        },
      }
    )

    if (!res.ok) return null

    const data: any = await res.json().catch(() => null)
    if (!data?.price) return null

    return {
      price:          data.price,
      original_price: data.original_price || null,
      title:          data.title || itemId,
      thumbnail:      data.thumbnail || null,
      in_stock:       (data.available_quantity || 0) > 0 && data.status !== 'closed',
      permalink:      data.permalink || `https://www.mercadolivre.com.br/p/${itemId}`,
      strategy:       'item_direct',
      status_code:    res.status,
    }
  } catch {
    return null
  }
}

// ── Busca preço com fallback automático ───────────────────────
async function fetchPrice(mlId: string, token: string): Promise<PriceResult | { error: string; status_code?: number } | null> {
  if (isCatalogId(mlId)) {
    // É catalog_product_id — tenta estratégias em ordem
    const r1 = await fetchByCatalogItems(mlId, token)
    if (r1) return r1

    const r2 = await fetchByCatalogProduct(mlId, token)
    if (r2) return r2

    return { error: `catalog endpoints bloqueados para ${mlId} — IP de datacenter Cloudflare ou sem permissão read:catalog` }
  } else {
    // É item_id real — busca direta
    const r = await fetchByItemId(mlId, token)
    if (r) return r
    return { error: `item ${mlId} não encontrado ou sem preço` }
  }
}

// ── Scraper principal ─────────────────────────────────────────
export async function runMLPriceScraper(
  db: D1Database,
  cache: KVNamespace,
  appId = '',
  secret = '',
): Promise<ScraperStats> {
  const start = Date.now()
  const stats: ScraperStats = {
    total: 0, updated: 0, skipped: 0, errors: 0, duration_ms: 0,
    token_source: 'none',
    details: [],
  }

  // ── 1. Pega melhor token ──────────────────────────────────────
  const { token, source: tokenSource } = await getBestToken(cache, appId, secret)
  stats.token_source = tokenSource

  if (!token) {
    stats.details.push({
      ml_id: '-', name: 'ERRO',
      error: `Sem token ML — faça OAuth em /api/ml/auth (source: ${tokenSource})`,
    })
    stats.duration_ms = Date.now() - start
    await _saveLog(cache, stats)
    return stats
  }

  // ── 2. Busca produtos com ml_item_id ─────────────────────────
  const { results: products } = await db
    .prepare(`
      SELECT id, name, ml_item_id, best_price, affiliate_url
      FROM products
      WHERE is_active = 1 AND ml_item_id IS NOT NULL AND ml_item_id != ''
      ORDER BY id ASC
    `)
    .all<{ id: number; name: string; ml_item_id: string; best_price: number | null; affiliate_url: string | null }>()

  stats.total = products.length
  if (products.length === 0) {
    stats.duration_ms = Date.now() - start
    await _saveLog(cache, stats)
    return stats
  }

  // ── 3. ID da loja Mercado Livre ───────────────────────────────
  const mlStore = await db
    .prepare(`SELECT id FROM stores WHERE slug = 'mercadolivre' AND is_active = 1 LIMIT 1`)
    .first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  // ── 4. Processa cada produto ──────────────────────────────────
  for (const product of products) {
    try {
      const result = await fetchPrice(product.ml_item_id, token)

      // Erro ou sem resultado
      if (!result || 'error' in result) {
        stats.skipped++
        stats.details.push({
          ml_id:  product.ml_item_id,
          name:   product.name,
          error:  (result as any)?.error || 'sem dados',
          status: (result as any)?.status_code,
        })
        await new Promise(r => setTimeout(r, 200))
        continue
      }

      const priceData = result as PriceResult

      const discount = priceData.original_price && priceData.original_price > priceData.price
        ? Math.round(((priceData.original_price - priceData.price) / priceData.original_price) * 100)
        : 0

      // Usa affiliate_url do banco como product_url (já tem matt_word + matt_tool)
      const productUrl = product.affiliate_url || priceData.permalink
      const expiresAt  = new Date(Date.now() + 6 * 3600 * 1000).toISOString()

      // ── Upsert na tabela offers ───────────────────────────────
      const existing = await db
        .prepare(`SELECT id FROM offers WHERE product_id = ? AND store_id = ? LIMIT 1`)
        .bind(product.id, storeId)
        .first<{ id: number }>()

      if (existing) {
        await db.prepare(`
          UPDATE offers SET
            price = ?, original_price = ?, discount_percent = ?,
            in_stock = ?, image_url = ?,
            last_updated = CURRENT_TIMESTAMP, cache_expires_at = ?
          WHERE id = ?
        `).bind(
          priceData.price,
          priceData.original_price || null,
          discount,
          priceData.in_stock ? 1 : 0,
          priceData.thumbnail || null,
          expiresAt,
          existing.id,
        ).run()
      } else {
        await db.prepare(`
          INSERT INTO offers
            (product_id, store_id, external_id, title, price, original_price,
             discount_percent, free_shipping, in_stock, product_url, image_url, cache_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).bind(
          product.id,
          storeId,
          product.ml_item_id,
          priceData.title,
          priceData.price,
          priceData.original_price || null,
          discount,
          priceData.in_stock ? 1 : 0,
          productUrl,
          priceData.thumbnail || null,
          expiresAt,
        ).run()
      }

      // ── Atualiza best_price + image_url no produto ────────────
      await db.prepare(`
        UPDATE products SET
          best_price    = (SELECT MIN(price) FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1),
          best_store_id = (SELECT store_id   FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1 ORDER BY price ASC LIMIT 1),
          offer_count   = (SELECT COUNT(*)   FROM offers WHERE product_id = ? AND is_active = 1),
          image_url     = COALESCE(NULLIF(image_url, ''), ?),
          updated_at    = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(product.id, product.id, product.id, priceData.thumbnail || null, product.id).run()

      stats.updated++
      stats.details.push({
        ml_id:    product.ml_item_id,
        name:     product.name,
        price:    priceData.price,
        strategy: priceData.strategy,
      })

      // Delay entre requests
      await new Promise(r => setTimeout(r, 300))

    } catch (e: any) {
      stats.errors++
      stats.details.push({ ml_id: product.ml_item_id, name: product.name, error: e?.message || 'exception' })
    }
  }

  stats.duration_ms = Date.now() - start
  await _saveLog(cache, stats)
  return stats
}

// ── Salva log no KV ───────────────────────────────────────────
async function _saveLog(cache: KVNamespace, stats: ScraperStats) {
  await cache.put('cron_last_run', JSON.stringify({
    ran_at:       new Date().toISOString(),
    token_source: stats.token_source,
    stats,
  }), { expirationTtl: 86400 * 7 }).catch(() => {})
}
