// ============================================================
// LIB: Ingest Engine — Motor de ingestão de dados
// Módulo 2: Feeds XML/CSV + API REST com rate limiting
// ============================================================

import type { IngestItem, Bindings } from '../types'
import { MatchingEngine } from './matching'

export interface IngestStats {
  total: number
  created: number
  updated: number
  skipped: number
  errors: number
  duration_ms: number
}

export class IngestEngine {
  private db: D1Database
  private matcher: MatchingEngine

  constructor(db: D1Database) {
    this.db = db
    this.matcher = new MatchingEngine(db)
  }

  // ── Ingere um lote de itens (de feed XML/CSV ou API) ──────
  async ingestBatch(items: IngestItem[], batchSize = 50): Promise<IngestStats> {
    const start = Date.now()
    const stats: IngestStats = { total: items.length, created: 0, updated: 0, skipped: 0, errors: 0, duration_ms: 0 }

    // Busca ID da loja uma vez só
    const storeCache: Record<string, number> = {}

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)

      for (const item of batch) {
        try {
          // Resolve store_id
          if (!storeCache[item.store_slug]) {
            const store = await this.db
              .prepare('SELECT id FROM stores WHERE slug = ? AND is_active = 1')
              .bind(item.store_slug)
              .first<{ id: number }>()
            if (!store) { stats.skipped++; continue }
            storeCache[item.store_slug] = store.id
          }
          const storeId = storeCache[item.store_slug]

          // Tenta fazer matching (EAN → SKU → Similaridade)
          const match = await this.matcher.match(item, storeId)

          let productId: number
          if (match.product_id) {
            productId = match.product_id
          } else {
            // Cria produto novo
            productId = await this.matcher.createProduct(item)
            stats.created++
          }

          // Upsert da oferta
          const existed = await this.upsertOffer(item, productId, storeId)
          if (existed) stats.updated++
          else if (match.product_id) stats.updated++

          // Atualiza best_price do produto
          await this.refreshProductBestPrice(productId)

        } catch (e) {
          console.error('IngestEngine error:', e)
          stats.errors++
        }
      }
    }

    stats.duration_ms = Date.now() - start
    return stats
  }

  // ── Upsert de oferta ──────────────────────────────────────
  private async upsertOffer(item: IngestItem, productId: number, storeId: number): Promise<boolean> {
    const existing = await this.db
      .prepare('SELECT id FROM offers WHERE product_id = ? AND store_id = ? AND external_id = ?')
      .bind(productId, storeId, item.external_id)
      .first<{ id: number }>()

    const discount = item.original_price && item.original_price > item.price
      ? ((item.original_price - item.price) / item.original_price) * 100
      : item.discount_percent || 0

    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString()

    if (existing) {
      await this.db
        .prepare(`
          UPDATE offers SET
            price = ?, original_price = ?, discount_percent = ?,
            in_stock = ?, free_shipping = ?, image_url = ?,
            last_updated = CURRENT_TIMESTAMP, cache_expires_at = ?
          WHERE id = ?
        `)
        .bind(
          item.price,
          item.original_price || null,
          Math.round(discount * 10) / 10,
          item.in_stock !== false ? 1 : 0,
          item.free_shipping ? 1 : 0,
          item.image_url || null,
          expiresAt,
          existing.id
        )
        .run()
      return true
    } else {
      await this.db
        .prepare(`
          INSERT INTO offers
            (product_id, store_id, external_id, title, price, original_price,
             discount_percent, free_shipping, in_stock, product_url, image_url,
             cache_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          productId, storeId, item.external_id, item.name,
          item.price, item.original_price || null,
          Math.round(discount * 10) / 10,
          item.free_shipping ? 1 : 0,
          item.in_stock !== false ? 1 : 0,
          item.product_url || null,
          item.image_url || null,
          expiresAt
        )
        .run()
      return false
    }
  }

  // ── Atualiza best_price do produto pai ────────────────────
  private async refreshProductBestPrice(productId: number): Promise<void> {
    await this.db
      .prepare(`
        UPDATE products SET
          best_price = (SELECT MIN(price) FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1),
          best_store_id = (SELECT store_id FROM offers WHERE product_id = ? AND is_active = 1 AND in_stock = 1 ORDER BY price ASC LIMIT 1),
          offer_count = (SELECT COUNT(*) FROM offers WHERE product_id = ? AND is_active = 1),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(productId, productId, productId, productId)
      .run()
  }

  // ── Enfileira atualização de preço (prioridade alta = clicado) ──
  async queuePriceUpdate(offerId: number, priority = 5): Promise<void> {
    await this.db
      .prepare(`
        INSERT OR REPLACE INTO price_update_queue (offer_id, priority, status, scheduled_for)
        VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
      `)
      .bind(offerId, priority)
      .run()
  }

  // ── Processa fila de atualização (chamado pelo cron) ──────
  async processQueue(limit = 10): Promise<number> {
    const { results } = await this.db
      .prepare(`
        SELECT pq.id, pq.offer_id, o.external_id, s.slug as store_slug
        FROM price_update_queue pq
        JOIN offers o ON o.id = pq.offer_id
        JOIN stores s ON s.id = o.store_id
        WHERE pq.status = 'pending' AND pq.scheduled_for <= CURRENT_TIMESTAMP
        ORDER BY pq.priority ASC, pq.scheduled_for ASC
        LIMIT ?
      `)
      .bind(limit)
      .all<{ id: number; offer_id: number; external_id: string; store_slug: string }>()

    let processed = 0
    for (const job of results) {
      // Marca como processando
      await this.db
        .prepare("UPDATE price_update_queue SET status = 'processing', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(job.id)
        .run()

      // TODO: Aqui chamaria a API real (Amazon PA-API, ML API, etc.)
      // Por ora, marca como done
      await this.db
        .prepare("UPDATE price_update_queue SET status = 'done' WHERE id = ?")
        .bind(job.id)
        .run()

      processed++
    }

    return processed
  }
}
