// ============================================================
// AI EDITORIAL ENGINE — Motor de IA interna do KainowRadar
// Analisa dados do D1 e gera destaques editoriais automaticamente
// SEM chamadas a APIs externas — 100% baseado nos dados locais
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'

const editorial = new Hono<{ Bindings: Bindings }>()

// ── Tipos internos ────────────────────────────────────────────────────────────
interface ProductRow {
  id: number; name: string; slug: string; category: string; brand: string
  image_url: string | null; best_price: number | null; original_price: number | null
  offer_count: number; best_store_name: string | null
}
interface CategoryRow {
  id: number; name: string; slug: string; icon: string | null; product_count: number
}
interface OfferStat {
  category: string; offer_count: number; min_price: number
  max_price: number; avg_discount: number; store_count: number
}
interface StoreRow { id: number; name: string; slug: string }

// ── Helpers de análise ────────────────────────────────────────────────────────

/** Mapeia categoria → emoji representativo */
function categoryEmoji(slug: string): string {
  const map: Record<string, string> = {
    smartphones: '📱', notebooks: '💻', tv: '📺', 'smart-tv': '📺',
    games: '🎮', audio: '🎧', eletrodomesticos: '🏠', tablets: '📟',
    cameras: '📷', wearables: '⌚', informatica: '🖥️', perifericos: '⌨️',
    'ar-condicionado': '❄️', refrigeracao: '🧊', lavanderia: '👕',
    moda: '👗', calcados: '👟', esportes: '⚽', livros: '📚',
    beleza: '💄', saude: '💊', ferramentas: '🔧', moveis: '🛋️',
    brinquedos: '🧸', automotivo: '🚗', pet: '🐾', alimentos: '🍎',
  }
  for (const [key, emoji] of Object.entries(map)) {
    if (slug.includes(key)) return emoji
  }
  return '🛍️'
}

/** Mapeia categoria → gradiente de cor */
function categoryStyle(slug: string): { from: string; to: string; style: string } {
  const map: Record<string, { from: string; to: string; style: string }> = {
    smartphones:  { from: '#1D4ED8', to: '#7C3AED', style: 'blue'   },
    notebooks:    { from: '#0F172A', to: '#334155', style: 'dark'    },
    tv:           { from: '#0F766E', to: '#0D9488', style: 'green'   },
    'smart-tv':   { from: '#0F766E', to: '#0D9488', style: 'green'   },
    games:        { from: '#6D28D9', to: '#EC4899', style: 'purple'  },
    audio:        { from: '#1D4ED8', to: '#0284C7', style: 'blue'    },
    eletrodomesticos: { from: '#B45309', to: '#D97706', style: 'orange' },
    tablets:      { from: '#0E7490', to: '#0891B2', style: 'cyan'    },
    moda:         { from: '#BE185D', to: '#EC4899', style: 'pink'    },
    esportes:     { from: '#15803D', to: '#16A34A', style: 'green'   },
  }
  for (const [key, val] of Object.entries(map)) {
    if (slug.includes(key)) return val
  }
  return { from: '#2563EB', to: '#7C3AED', style: 'blue' }
}

/** Formata moeda BR */
function fBRL(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v)
}

/** Gera título editorial para banner principal */
function genMainTitle(cat: CategoryRow, stat: OfferStat, topProduct: ProductRow | null): {
  label: string; title: string; subtitle: string; searchTerm: string; statValue: string
} {
  const slug = cat.slug
  const emoji = categoryEmoji(slug)
  const savings = stat.max_price > stat.min_price
    ? fBRL(stat.max_price - stat.min_price)
    : null

  // Templates por categoria
  if (slug.includes('smartphone') || slug.includes('celular')) {
    return {
      label: `🔥 Destaque do dia`,
      title: `Smartphones\ncom o menor\npreço garantido`,
      subtitle: savings ? `Compare ${stat.store_count} lojas e economize até ${savings}` : `${stat.offer_count} ofertas comparadas em tempo real`,
      searchTerm: topProduct?.brand || 'Smartphone',
      statValue: savings || `${stat.offer_count} ofertas`,
    }
  }
  if (slug.includes('notebook') || slug.includes('laptop')) {
    const off = stat.avg_discount > 0 ? `${Math.round(stat.avg_discount)}% OFF` : 'melhores preços'
    return {
      label: `💻 Alta performance`,
      title: `Notebooks\nem ${off}\nnos melhores modelos`,
      subtitle: `${stat.offer_count} modelos comparados — do básico ao gamer`,
      searchTerm: topProduct?.brand || 'Notebook',
      statValue: off,
    }
  }
  if (slug.includes('tv') || slug.includes('televisao')) {
    return {
      label: `📺 Tela grande`,
      title: `Smart TVs\n4K e QLED\nnas melhores lojas`,
      subtitle: `Compare ${stat.store_count} lojas — economize ${savings || 'muito'}`,
      searchTerm: 'Smart TV 4K',
      statValue: savings || `${stat.offer_count} ofertas`,
    }
  }
  if (slug.includes('game') || slug.includes('console')) {
    return {
      label: `🎮 Gamer`,
      title: `Games e Consoles\ncom os\nmenores preços`,
      subtitle: `PS5, Xbox, Nintendo — compare e economize`,
      searchTerm: 'PlayStation',
      statValue: `${stat.offer_count} ofertas`,
    }
  }
  if (slug.includes('audio') || slug.includes('headphone') || slug.includes('fone')) {
    return {
      label: `🎧 Som perfeito`,
      title: `Fones e Caixas\nde som com\npreço imbatível`,
      subtitle: `${stat.offer_count} produtos monitorados — melhor preço garantido`,
      searchTerm: 'Fone Bluetooth',
      statValue: savings || `${stat.offer_count} ofertas`,
    }
  }
  // Genérico
  const catName = cat.name
  return {
    label: `⚡ Em destaque`,
    title: `${catName}\ncom o menor\npreço do mercado`,
    subtitle: savings ? `Economize até ${savings} comparando ${stat.store_count} lojas` : `${stat.offer_count} ofertas monitoradas`,
    searchTerm: catName,
    statValue: savings || `${stat.offer_count} ofertas`,
  }
}

/** Gera texto para banner secundário */
function genSecTitle(cat: CategoryRow, stat: OfferStat, idx: number): {
  label: string; title: string; style: 'secondary' | 'green'
} {
  const styles: Array<'secondary' | 'green'> = ['secondary', 'green']
  const style = styles[idx % 2]
  const off = stat.avg_discount > 0 ? `Até ${Math.round(stat.avg_discount)}% OFF` : 'Preços imperdíveis'
  return {
    label: cat.name,
    title: `${off}\nnos melhores modelos`,
    style,
  }
}

/** Gera insights textuais (frases analíticas) */
function genInsights(stats: OfferStat[], stores: StoreRow[], totalProducts: number): string[] {
  const insights: string[] = []

  // Insight 1: categoria mais aquecida
  const hotCat = stats.sort((a, b) => b.offer_count - a.offer_count)[0]
  if (hotCat) {
    insights.push(`📈 ${hotCat.category} é a categoria com mais ofertas agora — ${hotCat.offer_count} comparações ativas`)
  }

  // Insight 2: maior desconto encontrado
  const bigDiscount = stats.sort((a, b) => b.avg_discount - a.avg_discount)[0]
  if (bigDiscount && bigDiscount.avg_discount > 5) {
    insights.push(`🏷️ Descontos médios de ${Math.round(bigDiscount.avg_discount)}% em ${bigDiscount.category} — verifique antes que acabe`)
  }

  // Insight 3: cobertura de lojas
  if (stores.length > 0 && totalProducts > 0) {
    insights.push(`🔍 ${totalProducts} produtos monitorados em ${stores.length} lojas — atualizado automaticamente`)
  }

  // Insight 4: melhor momento para comprar
  const nowH = new Date().getHours()
  if (nowH >= 6 && nowH < 12) {
    insights.push(`☀️ Manhã é o melhor horário para encontrar ofertas-relâmpago — os bots atualizam preços cedo`)
  } else if (nowH >= 20) {
    insights.push(`🌙 Noite: lojas costumam liberar promoções para queimar estoque do dia`)
  } else {
    insights.push(`⚡ Compare agora: preços mudam várias vezes ao dia nas principais lojas`)
  }

  return insights.slice(0, 3)
}

// ── GET /api/editorial — Retorna destaques gerados ───────────────────────────
editorial.get('/', async (c) => {
  const { DB } = c.env
  try {
    const { results: banners } = await DB.prepare(
      `SELECT * FROM ai_editorial ORDER BY priority DESC, generated_at DESC LIMIT 10`
    ).all()
    const { results: insights } = await DB.prepare(
      `SELECT * FROM ai_insights ORDER BY generated_at DESC LIMIT 5`
    ).all()
    const lastGen = banners[0] ? (banners[0] as any).generated_at : null
    return c.json({ banners, insights, last_generated: lastGen, ok: true })
  } catch {
    return c.json({ banners: [], insights: [], last_generated: null, ok: false })
  }
})

// ── POST /api/editorial/generate — Motor principal de análise e geração ───────
// Chamado pelo cron interno (Cloudflare Scheduled Worker) ou manualmente pelo admin
editorial.post('/generate', async (c) => {
  const { DB } = c.env

  // ── 1. Coleta dados do D1 ─────────────────────────────────────────────────
  const [catStats, topProducts, storesRes, totalRes, categoriesRes] = await Promise.all([
    // Estatísticas por categoria: preços, descontos, qtd ofertas, qtd lojas
    DB.prepare(`
      SELECT
        p.category,
        COUNT(DISTINCT o.id)       AS offer_count,
        MIN(o.price)               AS min_price,
        MAX(o.price)               AS max_price,
        AVG(COALESCE(o.discount_percent, 0)) AS avg_discount,
        COUNT(DISTINCT o.store_id) AS store_count
      FROM offers o
      JOIN products p ON p.id = o.product_id
      WHERE o.is_active = 1 AND p.is_active = 1
      GROUP BY p.category
      ORDER BY offer_count DESC
      LIMIT 20
    `).all<OfferStat>(),

    // Top produtos por número de ofertas (com maior cobertura)
    DB.prepare(`
      SELECT p.id, p.name, p.slug, p.category, p.brand, p.image_url,
             p.best_price, p.offer_count,
             s.name AS best_store_name
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.is_active = 1 AND p.best_price IS NOT NULL
      ORDER BY p.offer_count DESC, p.best_price ASC
      LIMIT 20
    `).all<ProductRow>(),

    // Lojas ativas
    DB.prepare(`SELECT id, name, slug FROM stores WHERE is_active = 1 ORDER BY name ASC`).all<StoreRow>(),

    // Total de produtos ativos
    DB.prepare(`SELECT COUNT(*) AS total FROM products WHERE is_active = 1`).first<{ total: number }>(),

    // Categorias ativas com produto_count
    DB.prepare(`SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 30`).all<CategoryRow>(),
  ])

  const stats       = catStats.results
  const products    = topProducts.results
  const stores      = storesRes.results
  const totalProds  = totalRes?.total || 0
  const categories  = categoriesRes.results

  if (stats.length === 0 && products.length === 0) {
    return c.json({ ok: false, message: 'Sem dados suficientes no banco para gerar destaques. Adicione produtos e ofertas primeiro.' })
  }

  // ── 2. Analisa e seleciona melhores categorias ────────────────────────────
  // Ordena por (offer_count * 2) + (avg_discount) para priorizar as mais quentes
  const rankedStats = [...stats].sort((a, b) =>
    (b.offer_count * 2 + b.avg_discount) - (a.offer_count * 2 + a.avg_discount)
  )

  // Mapeia categoria slug → dados da tabela categories
  const catMap: Record<string, CategoryRow> = {}
  for (const cat of categories) catMap[cat.slug] = cat

  // Resolve categoria com fallback inteligente
  function resolveCat(statRow: OfferStat): CategoryRow {
    return catMap[statRow.category] || {
      id: 0, name: statRow.category, slug: statRow.category,
      icon: categoryEmoji(statRow.category), product_count: statRow.offer_count
    }
  }

  // ── 3. Gera banner PRINCIPAL ──────────────────────────────────────────────
  const mainStat = rankedStats[0]
  let bannerMain = null

  if (mainStat) {
    const mainCat  = resolveCat(mainStat)
    const topProd  = products.find(p => p.category === mainStat.category) || products[0] || null
    const content  = genMainTitle(mainCat, mainStat, topProd)
    const colStyle = categoryStyle(mainStat.category)

    bannerMain = {
      slot:          'banner_main',
      type:          'banner',
      title:         content.title,
      subtitle:      content.subtitle,
      label:         content.label,
      emoji:         categoryEmoji(mainStat.category),
      search_term:   content.searchTerm,
      category_slug: mainStat.category,
      product_id:    topProd?.id || null,
      stat_value:    content.statValue,
      color_from:    colStyle.from,
      color_to:      colStyle.to,
      style:         colStyle.style,
      priority:      100,
      meta_json:     JSON.stringify({
        offer_count:  mainStat.offer_count,
        store_count:  mainStat.store_count,
        min_price:    mainStat.min_price,
        max_price:    mainStat.max_price,
        avg_discount: Math.round(mainStat.avg_discount),
        top_product:  topProd ? { id: topProd.id, name: topProd.name, slug: topProd.slug } : null,
      }),
    }
  }

  // ── 4. Gera banners SECUNDÁRIOS (2 cards menores) ─────────────────────────
  const secStats = rankedStats.filter((_, i) => i > 0).slice(0, 2)
  const bannerSecs = secStats.map((stat, idx) => {
    const cat     = resolveCat(stat)
    const content = genSecTitle(cat, stat, idx)
    const colStyle = categoryStyle(stat.category)
    return {
      slot:          `banner_sec${idx + 1}`,
      type:          'banner',
      title:         content.title,
      subtitle:      null,
      label:         content.label,
      emoji:         categoryEmoji(stat.category),
      search_term:   cat.name,
      category_slug: stat.category,
      product_id:    null,
      stat_value:    stat.avg_discount > 0 ? `${Math.round(stat.avg_discount)}% OFF` : `${stat.offer_count} ofertas`,
      color_from:    colStyle.from,
      color_to:      colStyle.to,
      style:         content.style,
      priority:      50 - idx,
      meta_json:     JSON.stringify({
        offer_count:  stat.offer_count,
        store_count:  stat.store_count,
        avg_discount: Math.round(stat.avg_discount),
      }),
    }
  })

  // Fallback: se não houver dados suficientes para sec banners, usa categorias do banco
  while (bannerSecs.length < 2) {
    const fallbackCats = categories.filter(c =>
      !rankedStats.slice(0, bannerSecs.length + 2).map(s => s.category).includes(c.slug)
    )
    const fc = fallbackCats[bannerSecs.length] || categories[bannerSecs.length + 1]
    if (!fc) break
    const colStyle = categoryStyle(fc.slug)
    bannerSecs.push({
      slot:          `banner_sec${bannerSecs.length + 1}`,
      type:          'banner',
      title:         `Explore\n${fc.name}\nno melhor preço`,
      subtitle:      null,
      label:         fc.name,
      emoji:         fc.icon || categoryEmoji(fc.slug),
      search_term:   fc.name,
      category_slug: fc.slug,
      product_id:    null,
      stat_value:    'Ver ofertas',
      color_from:    colStyle.from,
      color_to:      colStyle.to,
      style:         bannerSecs.length % 2 === 0 ? 'secondary' : 'green',
      priority:      30,
      meta_json:     '{}',
    })
  }

  // ── 5. Gera insights textuais ─────────────────────────────────────────────
  const insightTexts = genInsights([...stats], stores, totalProds)

  // ── 6. Persiste no D1 com UPSERT ─────────────────────────────────────────
  const now   = new Date().toISOString()
  const valid = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() // válido por 6h

  const allBanners = bannerMain ? [bannerMain, ...bannerSecs] : bannerSecs

  for (const b of allBanners) {
    await DB.prepare(`
      INSERT INTO ai_editorial
        (slot, type, title, subtitle, label, emoji, search_term, category_slug,
         product_id, stat_value, color_from, color_to, style, priority,
         generated_at, valid_until, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slot) DO UPDATE SET
        type=excluded.type, title=excluded.title, subtitle=excluded.subtitle,
        label=excluded.label, emoji=excluded.emoji, search_term=excluded.search_term,
        category_slug=excluded.category_slug, product_id=excluded.product_id,
        stat_value=excluded.stat_value, color_from=excluded.color_from,
        color_to=excluded.color_to, style=excluded.style, priority=excluded.priority,
        generated_at=excluded.generated_at, valid_until=excluded.valid_until,
        meta_json=excluded.meta_json
    `).bind(
      b.slot, b.type, b.title, b.subtitle ?? null, b.label, b.emoji,
      b.search_term, b.category_slug, b.product_id ?? null, b.stat_value,
      b.color_from, b.color_to, b.style, b.priority,
      now, valid, b.meta_json
    ).run()
  }

  // Salva insights
  if (insightTexts.length > 0) {
    await DB.prepare(`DELETE FROM ai_insights`).run()
    for (const txt of insightTexts) {
      await DB.prepare(`
        INSERT INTO ai_insights (insight_text, insight_type, generated_at)
        VALUES (?, 'tip', ?)
      `).bind(txt, now).run()
    }
  }

  return c.json({
    ok: true,
    generated_at: now,
    valid_until: valid,
    slots_generated: allBanners.map(b => b.slot),
    insights_count: insightTexts.length,
    data_summary: {
      categories_analyzed: stats.length,
      products_total: totalProds,
      stores_active: stores.length,
      top_category: mainStat?.category || null,
      top_category_offers: mainStat?.offer_count || 0,
    },
  })
})

// ── POST /api/editorial/reset — Limpa destaques (admin) ──────────────────────
editorial.post('/reset', async (c) => {
  const { DB } = c.env
  await DB.prepare(`DELETE FROM ai_editorial`).run()
  await DB.prepare(`DELETE FROM ai_insights`).run()
  return c.json({ ok: true })
})

export default editorial
