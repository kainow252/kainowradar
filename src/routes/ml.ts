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
const ML_API = 'https://api.mercadolibre.com'

// Mapa de categorias ML → slug interno KainowRadar
const ML_CATEGORIES: Record<string, { mlId: string; slug: string; name: string }> = {
  smartphones:      { mlId: 'MLB1051', slug: 'smartphones',      name: 'Smartphones'       },
  notebooks:        { mlId: 'MLB1648', slug: 'notebooks',         name: 'Notebooks'          },
  tv:               { mlId: 'MLB1000',  slug: 'tv',               name: 'TVs & Smart TVs'    },
  games:            { mlId: 'MLB1144', slug: 'games',             name: 'Games & Consoles'   },
  audio:            { mlId: 'MLB1003', slug: 'audio',             name: 'Áudio & Fones'      },
  cameras:          { mlId: 'MLB1008', slug: 'cameras',           name: 'Câmeras & Drones'   },
  eletrodomesticos: { mlId: 'MLB1574', slug: 'eletrodomesticos',  name: 'Eletrodomésticos'   },
  tablets:          { mlId: 'MLB1009', slug: 'tablets',           name: 'Tablets & iPads'    },
  informatica:      { mlId: 'MLB1649', slug: 'informatica',       name: 'Informática'        },
  'moda-calcados':  { mlId: 'MLB1430', slug: 'moda-calcados',     name: 'Moda & Calçados'    },
}

// ── Helper: Gera slug a partir do nome ───────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 80)
}

// ── Helper: Obtém access_token via Client Credentials ────
async function getMLToken(appId: string, secret: string): Promise<string | null> {
  try {
    const res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
      }),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    return data.access_token || null
  } catch {
    return null
  }
}

// ── Helper: Busca produtos do ML por categoria ───────────
async function fetchMLProducts(categoryId: string, token: string, offset = 0, limit = 50): Promise<any[]> {
  try {
    const url = `${ML_API}/sites/MLB/search?category=${categoryId}&limit=${limit}&offset=${offset}&sort=relevance`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (!res.ok) return []
    const data: any = await res.json()
    return data.results || []
  } catch {
    return []
  }
}

// ── Helper: Busca detalhes de um item ML ─────────────────
async function fetchMLItem(itemId: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${ML_API}/items/${itemId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Helper: Salva produto no D1 ──────────────────────────
async function saveProductToDB(DB: D1Database, item: any, categorySlug: string, categoryName: string): Promise<{ id: number | null; action: 'created' | 'updated' | 'skipped' }> {
  try {
    const mlId = item.id
    const name = item.title || ''
    const brand = item.attributes?.find((a: any) => a.id === 'BRAND')?.value_name || ''
    const ean = item.attributes?.find((a: any) => a.id === 'GTIN')?.value_name || ''
    const slug = slugify(name)
    const price = item.price || 0
    const image = item.thumbnail?.replace('-I.jpg', '-O.jpg') || item.thumbnail || ''
    const permalink = item.permalink || ''
    const affiliate_url = permalink ? `${permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow` : ''
    const freeShipping = item.shipping?.free_shipping ? 1 : 0
    const condition = item.condition === 'used' ? 'used' : 'new'

    // Verifica se já existe pelo ml_item_id
    const existing = await DB.prepare('SELECT id FROM products WHERE ml_item_id = ?').bind(mlId).first<{ id: number }>()

    if (existing) {
      // Atualiza preço e affiliate_url
      await DB.prepare(`
        UPDATE products SET
          best_price = ?,
          affiliate_url = ?,
          affiliate_updated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE ml_item_id = ?
      `).bind(price, affiliate_url, mlId).run()
      return { id: existing.id, action: 'updated' }
    }

    // Insere novo produto
    const result = await DB.prepare(`
      INSERT INTO products (ean, name, slug, brand, category, subcategory, description, image_url,
        best_price, offer_count, ml_item_id, affiliate_url, affiliate_updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, 1)
    `).bind(
      ean || null,
      name,
      slug,
      brand || null,
      categorySlug,
      categorySlug,
      `${name}${brand ? ' — ' + brand : ''}. Encontrado no Mercado Livre.`,
      image || null,
      price,
      mlId,
      affiliate_url
    ).run()

    return { id: result.meta.last_row_id as number, action: 'created' }
  } catch (e: any) {
    console.error('saveProductToDB error:', e.message)
    return { id: null, action: 'skipped' }
  }
}

// ── GET /api/ml/auth — Inicia OAuth2 ─────────────────────
ml.get('/auth', (c) => {
  const appId = c.env.ML_APP_ID || '3098423019766450'
  const redirectUri = 'https://kainowradar.com.br/api/ml-callback'
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
  return c.redirect(url)
})

// ── GET /api/ml-callback — Recebe código OAuth2 ──────────
ml.get('/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')

  if (error || !code) {
    return c.html(`<h2>❌ Erro OAuth ML: ${error || 'código ausente'}</h2>`)
  }

  const appId = c.env.ML_APP_ID || '3098423019766450'
  const secret = c.env.ML_SECRET || ''
  const redirectUri = 'https://kainowradar.com.br/api/ml-callback'

  try {
    const res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: secret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    const data: any = await res.json()

    if (!res.ok) {
      return c.html(`<h2>❌ Erro ao obter token: ${JSON.stringify(data)}</h2>`)
    }

    // Salva token no KV para uso futuro
    if (c.env.CACHE) {
      await c.env.CACHE.put('ml_access_token', data.access_token, { expirationTtl: data.expires_in || 21600 })
      await c.env.CACHE.put('ml_refresh_token', data.refresh_token || '', { expirationTtl: 86400 * 30 })
      await c.env.CACHE.put('ml_user_id', String(data.user_id || ''), { expirationTtl: 86400 * 30 })
    }

    return c.html(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-green-50 flex items-center justify-center min-h-screen">
        <div class="bg-white rounded-2xl p-8 shadow-xl text-center max-w-md">
          <div class="text-5xl mb-4">✅</div>
          <h2 class="text-2xl font-bold text-green-700 mb-2">Conectado ao Mercado Livre!</h2>
          <p class="text-gray-600 mb-1">User ID: <strong>${data.user_id}</strong></p>
          <p class="text-gray-600 mb-4">Token válido por ${Math.round((data.expires_in || 21600) / 3600)}h</p>
          <a href="/admin" class="bg-blue-600 text-white px-6 py-2 rounded-xl font-semibold hover:bg-blue-700">
            → Ir para o Admin
          </a>
        </div>
      </body></html>
    `)
  } catch (e: any) {
    return c.html(`<h2>❌ Erro: ${e.message}</h2>`)
  }
})

// ── POST /api/ml-webhook — Recebe notificações do ML ─────
ml.post('/webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { DB } = c.env

  const topic = (body as any).topic || ''
  const resource = (body as any).resource || ''

  // Notificações de preço/estoque de item
  if (topic === 'items' && resource) {
    const itemId = resource.replace('/items/', '').split('?')[0]
    // Atualiza preço do produto no banco
    try {
      const token = await c.env.CACHE?.get('ml_access_token') || ''
      if (token && itemId) {
        const item = await fetchMLItem(itemId, token)
        if (item) {
          const affiliate_url = `${item.permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow`
          await DB.prepare(`
            UPDATE products SET best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
            WHERE ml_item_id = ?
          `).bind(item.price, affiliate_url, itemId).run()
        }
      }
    } catch {}
  }

  return c.json({ ok: true })
})

// ── GET /admin/api/ml/status — Status da integração ──────
ml.get('/status', async (c) => {
  const token = await c.env.CACHE?.get('ml_access_token').catch(() => null)
  const userId = await c.env.CACHE?.get('ml_user_id').catch(() => null)
  const appId = c.env.ML_APP_ID || '3098423019766450'

  return c.json({
    connected: !!token,
    user_id: userId,
    app_id: appId,
    publisher_id: PUBLISHER_ID,
    categories: Object.keys(ML_CATEGORIES),
  })
})

// ── POST /admin/api/ml/import — Importa produtos por categoria ─
ml.post('/import', async (c) => {
  const { DB } = c.env
  const { category, limit = 50, offset = 0 } = await c.req.json().catch(() => ({}))

  const appId = c.env.ML_APP_ID || '3098423019766450'
  const secret = c.env.ML_SECRET || ''

  // Obtém token via Client Credentials
  const token = await getMLToken(appId, secret)
  if (!token) {
    return c.json({ error: 'Falha ao obter token do ML. Verifique APP_ID e SECRET.' }, 500)
  }

  // Se category === 'all', importa todas as categorias
  const categoriesToImport = category === 'all'
    ? Object.values(ML_CATEGORIES)
    : ML_CATEGORIES[category]
      ? [ML_CATEGORIES[category]]
      : null

  if (!categoriesToImport) {
    return c.json({ error: `Categoria inválida: ${category}. Válidas: ${Object.keys(ML_CATEGORIES).join(', ')}` }, 400)
  }

  let totalCreated = 0
  let totalUpdated = 0
  let totalSkipped = 0
  const errors: string[] = []

  for (const cat of categoriesToImport) {
    try {
      const items = await fetchMLProducts(cat.mlId, token, offset, Math.min(limit, 50))

      for (const item of items) {
        const { action } = await saveProductToDB(DB, item, cat.slug, cat.name)
        if (action === 'created') totalCreated++
        else if (action === 'updated') totalUpdated++
        else totalSkipped++

        // Pausa para não sobrecarregar
        await new Promise(r => setTimeout(r, 50))
      }
    } catch (e: any) {
      errors.push(`${cat.slug}: ${e.message}`)
    }
  }

  return c.json({
    ok: true,
    created: totalCreated,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors: errors.slice(0, 5),
    message: `${totalCreated} criados, ${totalUpdated} atualizados, ${totalSkipped} ignorados`,
  })
})

// ── POST /admin/api/ml/import-item — Importa item específico por ID ─
ml.post('/import-item', async (c) => {
  const { ml_id } = await c.req.json().catch(() => ({}))
  if (!ml_id) return c.json({ error: 'ml_id obrigatório' }, 400)

  const { DB } = c.env
  const appId = c.env.ML_APP_ID || '3098423019766450'
  const secret = c.env.ML_SECRET || ''

  const token = await getMLToken(appId, secret)
  if (!token) return c.json({ error: 'Falha ao obter token ML' }, 500)

  const item = await fetchMLItem(ml_id, token)
  if (!item) return c.json({ error: `Item ${ml_id} não encontrado no ML` }, 404)

  // Detecta categoria
  const catSlug = Object.entries(ML_CATEGORIES).find(([, v]) => item.category_id?.startsWith(v.mlId.substring(0, 6)))?.[0] || 'outros'
  const catName = ML_CATEGORIES[catSlug]?.name || 'Outros'

  const { id, action } = await saveProductToDB(DB, item, catSlug, catName)

  return c.json({
    ok: true,
    action,
    product_id: id,
    ml_id: item.id,
    name: item.title,
    price: item.price,
    affiliate_url: `${item.permalink}?partner_id=${PUBLISHER_ID}&source_id=kainow`,
  })
})

export default ml
export { ML_CATEGORIES }
