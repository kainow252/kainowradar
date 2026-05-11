// ============================================================
// LIB: ML Scraper — Busca preços do Mercado Livre via Search API
// Estratégia: GET /sites/MLB/search?q={nome} com OAuth token
// Token vem do KV: ml_access_token (OAuth) ou ml_app_token (CC)
// ============================================================

export interface ScraperStats {
  total: number
  updated: number
  skipped: number
  errors: number
  duration_ms: number
  details: Array<{ ml_id: string; name: string; price?: number; error?: string }>
}

const ML_API = 'https://api.mercadolibre.com'

// ── Pega token disponível no KV ──────────────────────────────
async function getBestToken(
  cache: KVNamespace,
  appId: string,
  secret: string,
): Promise<{ token: string | null; source: string }> {
  // 1) OAuth do usuário (melhor)
  const oauth = await cache.get('ml_access_token').catch(() => null)
  if (oauth) return { token: oauth, source: 'oauth' }

  // 2) Tenta renovar via refresh_token
  if (secret) {
    const refresh = await cache.get('ml_refresh_token').catch(() => null)
    if (refresh) {
      try {
        const res = await fetch(`${ML_API}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: appId,
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

    // 3) client_credentials (funciona para search, não para /items/{id})
    const appToken = await cache.get('ml_app_token').catch(() => null)
    if (appToken) return { token: appToken, source: 'cc_cache' }

    try {
      const res = await fetch(`${ML_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
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
  }

  return { token: null, source: 'none' }
}

// ── Busca melhor preço via Search API do ML ──────────────────
// Usa o nome do produto como query → pega o menor preço encontrado
async function fetchPriceBySearch(
  productName: string,
  mlId: string,
  token: string,
): Promise<{ price: number; original_price: number | null; title: string; thumbnail: string | null; in_stock: boolean; permalink: string } | null> {
  // Limpa o nome para melhorar a busca: remove coisas como "100ml", "Eau de Parfum", etc.
  const query = encodeURIComponent(productName)

  try {
    const res = await fetch(
      `${ML_API}/sites/MLB/search?q=${query}&limit=5`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      }
    )

    if (!res.ok) return null

    const data: any = await res.json()
    const results: any[] = data?.results || []
    if (results.length === 0) return null

    // Prefere o resultado que tem catalog_product_id igual ao mlId
    const exact = results.find((r: any) => r.catalog_product_id === mlId)
    const best  = exact || results[0]

    if (!best?.price) return null

    return {
      price:          best.price,
      original_price: best.original_price || null,
      title:          best.title || productName,
      thumbnail:      best.thumbnail || null,
      in_stock:       (best.available_quantity || 0) > 0,
      permalink:      best.permalink || `https://www.mercadolivre.com.br/p/${mlId}`,
    }
  } catch {
    return null
  }
}

// ── Scraper principal: roda para todos os produtos com ml_item_id ─
export async function runMLPriceScraper(
  db: D1Database,
  cache: KVNamespace,
  appId = '',
  secret = '',
): Promise<ScraperStats> {
  const start  = Date.now()
  const stats: ScraperStats = {
    total: 0, updated: 0, skipped: 0, errors: 0, duration_ms: 0, details: [],
  }

  // Pega melhor token disponível
  const { token, source: tokenSource } = await getBestToken(cache, appId, secret)
  if (!token) {
    stats.details.push({ ml_id: '-', name: 'ERRO', error: `Sem token ML (source: ${tokenSource}) — faça OAuth em /api/ml/auth` })
    stats.duration_ms = Date.now() - start
    return stats
  }

  // Busca todos os produtos com ml_item_id
  const { results: products } = await db
    .prepare(`
      SELECT id, name, ml_item_id, best_price
      FROM products
      WHERE is_active = 1 AND ml_item_id IS NOT NULL AND ml_item_id != ''
      ORDER BY id ASC
    `)
    .all<{ id: number; name: string; ml_item_id: string; best_price: number | null }>()

  stats.total = products.length
  if (products.length === 0) {
    stats.duration_ms = Date.now() - start
    return stats
  }

  // ID da loja Mercado Livre no banco
  const mlStore = await db
    .prepare(`SELECT id FROM stores WHERE slug = 'mercadolivre' AND is_active = 1`)
    .first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  // Processa cada produto
  for (const product of products) {
    try {
      const priceData = await fetchPriceBySearch(product.name, product.ml_item_id, token)

      if (!priceData || !priceData.price) {
        stats.skipped++
        stats.details.push({ ml_id: product.ml_item_id, name: product.name, error: 'sem resultado no search ML' })
        continue
      }

      const discount = priceData.original_price && priceData.original_price > priceData.price
        ? Math.round(((priceData.original_price - priceData.price) / priceData.original_price) * 100)
        : 0

      // Permalink afiliado correto (já está no banco como affiliate_url)
      const aff = await db
        .prepare(`SELECT affiliate_url FROM products WHERE id = ?`)
        .bind(product.id)
        .first<{ affiliate_url: string }>()
      const productUrl = aff?.affiliate_url || priceData.permalink

      const expiresAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString()

      // Upsert da oferta
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

      // Atualiza best_price, offer_count e image_url do produto
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
      stats.details.push({ ml_id: product.ml_item_id, name: product.name, price: priceData.price })

      // Delay entre requests para não bater rate limit
      await new Promise(r => setTimeout(r, 300))

    } catch (e: any) {
      stats.errors++
      stats.details.push({ ml_id: product.ml_item_id, name: product.name, error: e?.message || 'erro' })
    }
  }

  // Salva log no KV
  await cache.put('cron_last_run', JSON.stringify({
    ran_at:       new Date().toISOString(),
    token_source: tokenSource,
    stats,
  }), { expirationTtl: 86400 * 7 }).catch(() => {})

  stats.duration_ms = Date.now() - start
  return stats
}
