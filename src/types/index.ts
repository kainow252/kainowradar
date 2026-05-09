// ============================================================
// TYPES: Tipos TypeScript para todo o sistema
// ============================================================

export type Bindings = {
  DB: D1Database
  CACHE: KVNamespace
  // Segredos (configurar via wrangler secret put)
  AMAZON_ACCESS_KEY?: string
  AMAZON_SECRET_KEY?: string
  AMAZON_PARTNER_TAG?: string
  LOMADEE_SOURCE_ID?: string
  AWIN_PUBLISHER_ID?: string
  MELI_ACCESS_TOKEN?: string
}

export interface Store {
  id: number
  slug: string
  name: string
  logo_url?: string
  affiliate_network: string
  checkout_pattern?: string
  deeplink_base?: string
  affiliate_id?: string
  commission_rate: number
  is_active: number
}

export interface Product {
  id: number
  ean?: string
  name: string
  slug: string
  brand?: string
  category?: string
  subcategory?: string
  description?: string
  image_url?: string
  images?: string
  specs?: string
  best_price?: number
  best_store_id?: number
  offer_count: number
  rating: number
  review_count: number
  is_active: number
  created_at: string
  updated_at: string
  // Joins
  best_store_name?: string
  best_store_slug?: string
}

export interface Offer {
  id: number
  product_id: number
  store_id: number
  external_id: string
  external_sku?: string
  title: string
  price: number
  original_price?: number
  discount_percent: number
  installments_count?: number
  installments_value?: number
  free_shipping: number
  in_stock: number
  product_url?: string
  checkout_url?: string
  affiliate_url?: string
  image_url?: string
  condition: string
  seller_name?: string
  seller_rating?: number
  last_updated: string
  cache_expires_at?: string
  is_active: number
  // Joins
  store_name?: string
  store_slug?: string
  store_logo?: string
}

export interface Category {
  id: number
  slug: string
  name: string
  icon?: string
  parent_id?: number
  product_count: number
  sort_order: number
}

export interface SearchResult {
  products: Product[]
  total: number
  page: number
  per_page: number
  query?: string
  category?: string
}

export interface PriceCache {
  price: number
  in_stock: boolean
  updated_at: number // Unix timestamp
  expires_at: number
}

export interface DeeplinkResult {
  store: string
  store_name: string
  url: string
  type: 'cart' | 'checkout' | 'product' | 'deeplink'
}

export interface MatchingResult {
  product_id: number | null
  match_type: 'ean' | 'sku' | 'similarity' | 'none'
  confidence: number
  matched_product?: Product
}

export interface IngestItem {
  ean?: string
  sku?: string
  name: string
  brand?: string
  category?: string
  price: number
  original_price?: number
  image_url?: string
  product_url: string
  external_id: string
  store_slug: string
  free_shipping?: boolean
  in_stock?: boolean
  discount_percent?: number
}
