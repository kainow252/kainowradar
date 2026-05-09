// ============================================================
// LIB: Matching Engine — Algoritmo de deduplicação
// Módulo 3: O Algoritmo de Matching
// EAN/SKU first → Similaridade de nome como fallback
// ============================================================

import type { Product, IngestItem, MatchingResult } from '../types'

// ── Jaro-Winkler para similaridade de strings ─────────────
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1
  const len1 = s1.length, len2 = s2.length
  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0)
  const s1Matches = new Array(len1).fill(false)
  const s2Matches = new Array(len2).fill(false)
  let matches = 0, transpositions = 0

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist)
    const end = Math.min(i + matchDist + 1, len2)
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue
      s1Matches[i] = s2Matches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  let k = 0
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }

  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3
}

function jaroWinkler(s1: string, s2: string, p = 0.1): number {
  const jaroSim = jaro(s1, s2)
  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return jaroSim + prefix * p * (1 - jaroSim)
}

// ── Normaliza nome para comparação ───────────────────────
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^\w\s]/g, ' ')        // remove pontuação
    .replace(/\s+/g, ' ')            // espaços múltiplos
    .trim()
}

// ── Extrai tokens relevantes do nome ─────────────────────
function extractTokens(name: string): string[] {
  const stopwords = new Set([
    'de', 'do', 'da', 'com', 'para', 'por', 'em', 'no', 'na',
    'the', 'with', 'for', 'and', 'or', 'in',
    'preto', 'branco', 'azul', 'prata', 'dourado', 'rosa', 'cinza',
    'lacrado', 'original', 'novo', 'nf', 'garantia', 'oferta'
  ])
  return normalizeName(name)
    .split(' ')
    .filter(t => t.length > 1 && !stopwords.has(t))
}

// ── Token overlap (Jaccard) ───────────────────────────────
function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(extractTokens(a))
  const tokB = new Set(extractTokens(b))
  if (tokA.size === 0 || tokB.size === 0) return 0
  const intersection = [...tokA].filter(t => tokB.has(t)).length
  const union = new Set([...tokA, ...tokB]).size
  return intersection / union
}

// ── Similaridade combinada ────────────────────────────────
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  const jw = jaroWinkler(na, nb)
  const tok = tokenSimilarity(a, b)
  // Peso maior para token overlap em nomes de produto
  return jw * 0.4 + tok * 0.6
}

// ── Threshold de confiança ────────────────────────────────
const SIMILARITY_THRESHOLD = 0.72

// ── Matching Engine Principal ─────────────────────────────
export class MatchingEngine {
  private db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  // 1. Tenta por EAN (código de barras) — confiança 100%
  async matchByEAN(ean: string): Promise<MatchingResult> {
    if (!ean || ean.trim() === '') {
      return { product_id: null, match_type: 'none', confidence: 0 }
    }

    const product = await this.db
      .prepare('SELECT * FROM products WHERE ean = ? AND is_active = 1')
      .bind(ean.trim())
      .first<Product>()

    if (product) {
      return {
        product_id: product.id,
        match_type: 'ean',
        confidence: 1.0,
        matched_product: product
      }
    }
    return { product_id: null, match_type: 'none', confidence: 0 }
  }

  // 2. Tenta por SKU externo — confiança 95%
  async matchBySKU(externalId: string, storeId: number): Promise<MatchingResult> {
    const offer = await this.db
      .prepare(`
        SELECT p.* FROM products p
        JOIN offers o ON o.product_id = p.id
        WHERE o.external_id = ? AND o.store_id = ? AND p.is_active = 1
        LIMIT 1
      `)
      .bind(externalId, storeId)
      .first<Product>()

    if (offer) {
      return {
        product_id: offer.id,
        match_type: 'sku',
        confidence: 0.95,
        matched_product: offer
      }
    }
    return { product_id: null, match_type: 'none', confidence: 0 }
  }

  // 3. Tenta por similaridade de nome — confiança variável
  async matchByName(name: string, brand?: string, category?: string): Promise<MatchingResult> {
    // Busca candidatos filtrando por categoria/marca para reduzir comparações
    const query = brand
      ? 'SELECT * FROM products WHERE (brand = ? OR category = ?) AND is_active = 1 LIMIT 200'
      : 'SELECT * FROM products WHERE is_active = 1 LIMIT 500'

    const { results } = brand
      ? await this.db.prepare(query).bind(brand, category || '').all<Product>()
      : await this.db.prepare(query).all<Product>()

    let best: { product: Product; score: number } | null = null

    for (const product of results) {
      const score = nameSimilarity(name, product.name)
      if (score >= SIMILARITY_THRESHOLD) {
        if (!best || score > best.score) {
          best = { product, score }
        }
      }
    }

    if (best) {
      return {
        product_id: best.product.id,
        match_type: 'similarity',
        confidence: best.score,
        matched_product: best.product
      }
    }
    return { product_id: null, match_type: 'none', confidence: 0 }
  }

  // ── Orquestrador: tenta os 3 métodos em cascata ──────────
  async match(item: IngestItem, storeId: number): Promise<MatchingResult> {
    // Passo 1: EAN
    if (item.ean) {
      const result = await this.matchByEAN(item.ean)
      if (result.product_id) return result
    }

    // Passo 2: SKU
    if (item.external_id) {
      const result = await this.matchBySKU(item.external_id, storeId)
      if (result.product_id) return result
    }

    // Passo 3: Similaridade de nome
    if (item.name) {
      const result = await this.matchByName(item.name, item.brand, item.category)
      if (result.product_id) return result
    }

    return { product_id: null, match_type: 'none', confidence: 0 }
  }

  // ── Cria produto novo se não encontrou matching ───────────
  async createProduct(item: IngestItem): Promise<number> {
    const slug = this.generateSlug(item.name, item.brand)

    const result = await this.db
      .prepare(`
        INSERT OR IGNORE INTO products 
          (ean, name, slug, brand, category, image_url, best_price, offer_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .bind(
        item.ean || null,
        item.name,
        slug,
        item.brand || null,
        item.category || 'outros',
        item.image_url || null,
        item.price
      )
      .run()

    return result.meta.last_row_id as number
  }

  private generateSlug(name: string, brand?: string): string {
    const base = brand ? `${brand} ${name}` : name
    return normalizeName(base)
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 100) + '-' + Math.random().toString(36).substring(2, 7)
  }
}
