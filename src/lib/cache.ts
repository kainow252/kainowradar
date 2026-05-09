// ============================================================
// LIB: Cache Manager (Cloudflare KV — substitui Redis)
// Módulo 1: O Coração — camada de velocidade
// ============================================================

import type { Bindings, PriceCache } from '../types'

const CACHE_TTL = 3600 // 1 hora em segundos
const CACHE_PREFIX = {
  price: 'price:',
  product: 'product:',
  search: 'search:',
  category: 'cat:',
  offers: 'offers:',
}

export class CacheManager {
  private kv: KVNamespace

  constructor(kv: KVNamespace) {
    this.kv = kv
  }

  // ── Preços (TTL curto — dado quente) ──────────────────────
  async getPrice(offerId: number): Promise<PriceCache | null> {
    const raw = await this.kv.get(`${CACHE_PREFIX.price}${offerId}`, 'json')
    return raw as PriceCache | null
  }

  async setPrice(offerId: number, data: PriceCache): Promise<void> {
    await this.kv.put(
      `${CACHE_PREFIX.price}${offerId}`,
      JSON.stringify(data),
      { expirationTtl: CACHE_TTL }
    )
  }

  async isPriceStale(offerId: number): Promise<boolean> {
    const cached = await this.getPrice(offerId)
    if (!cached) return true
    return Date.now() / 1000 > cached.expires_at
  }

  // ── Página de produto (TTL médio) ─────────────────────────
  async getProduct(slug: string): Promise<any | null> {
    return this.kv.get(`${CACHE_PREFIX.product}${slug}`, 'json')
  }

  async setProduct(slug: string, data: any): Promise<void> {
    await this.kv.put(
      `${CACHE_PREFIX.product}${slug}`,
      JSON.stringify(data),
      { expirationTtl: 1800 } // 30 min
    )
  }

  async invalidateProduct(slug: string): Promise<void> {
    await this.kv.delete(`${CACHE_PREFIX.product}${slug}`)
  }

  // ── Resultados de busca (TTL curto) ───────────────────────
  async getSearch(key: string): Promise<any | null> {
    return this.kv.get(`${CACHE_PREFIX.search}${key}`, 'json')
  }

  async setSearch(key: string, data: any): Promise<void> {
    await this.kv.put(
      `${CACHE_PREFIX.search}${key}`,
      JSON.stringify(data),
      { expirationTtl: 300 } // 5 min
    )
  }

  // ── Categoria (TTL longo) ─────────────────────────────────
  async getCategory(slug: string): Promise<any | null> {
    return this.kv.get(`${CACHE_PREFIX.category}${slug}`, 'json')
  }

  async setCategory(slug: string, data: any): Promise<void> {
    await this.kv.put(
      `${CACHE_PREFIX.category}${slug}`,
      JSON.stringify(data),
      { expirationTtl: 3600 }
    )
  }

  // ── Ofertas de um produto ─────────────────────────────────
  async getOffers(productId: number): Promise<any | null> {
    return this.kv.get(`${CACHE_PREFIX.offers}${productId}`, 'json')
  }

  async setOffers(productId: number, data: any): Promise<void> {
    await this.kv.put(
      `${CACHE_PREFIX.offers}${productId}`,
      JSON.stringify(data),
      { expirationTtl: 900 } // 15 min
    )
  }

  async invalidateOffers(productId: number): Promise<void> {
    await this.kv.delete(`${CACHE_PREFIX.offers}${productId}`)
  }

  // ── Chave genérica ────────────────────────────────────────
  async get<T>(key: string): Promise<T | null> {
    return this.kv.get(key, 'json') as Promise<T | null>
  }

  async set(key: string, data: any, ttl = CACHE_TTL): Promise<void> {
    await this.kv.put(key, JSON.stringify(data), { expirationTtl: ttl })
  }

  async del(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}
