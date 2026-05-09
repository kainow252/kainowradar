-- ============================================================
-- SCHEMA PRINCIPAL DO SHOPPING COMPARADOR
-- Módulo 1: Banco de Dados Híbrido (D1 = estrutura persistente)
-- ============================================================

-- Lojas parceiras e seus padrões de deeplink
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,           -- 'amazon', 'magalu', 'mercadolivre'
  name TEXT NOT NULL,                  -- 'Amazon', 'Magazine Luiza'
  logo_url TEXT,
  affiliate_network TEXT,              -- 'lomadee', 'awin', 'amazon-pa-api', 'meli-api'
  checkout_pattern TEXT,               -- URL pattern com {ID} placeholder
  deeplink_base TEXT,                  -- base para deeplinks da rede
  affiliate_id TEXT,                   -- seu ID de afiliado nessa rede
  commission_rate REAL DEFAULT 0,      -- percentual de comissão
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Produtos únicos (o "item mestre" — ex: 1 iPhone 15 128GB)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ean TEXT UNIQUE,                     -- Código EAN/GTIN (chave de matching)
  name TEXT NOT NULL,                  -- Nome normalizado do produto
  slug TEXT UNIQUE NOT NULL,           -- URL-friendly: iphone-15-128gb
  brand TEXT,                          -- 'Apple', 'Samsung'
  category TEXT,                       -- 'smartphones', 'tv', 'notebook'
  subcategory TEXT,
  description TEXT,
  image_url TEXT,
  images TEXT,                         -- JSON array de imagens
  specs TEXT,                          -- JSON com especificações técnicas
  best_price REAL,                     -- Menor preço atual (denormalizado para busca)
  best_store_id INTEGER,               -- Loja com menor preço
  offer_count INTEGER DEFAULT 0,       -- Número de ofertas ativas
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (best_store_id) REFERENCES stores(id)
);

-- Ofertas (uma por loja para cada produto)
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  external_id TEXT NOT NULL,           -- ID do produto na loja (ASIN, item_id, etc)
  external_sku TEXT,                   -- SKU adicional da loja
  title TEXT NOT NULL,                 -- Nome original na loja
  price REAL NOT NULL,
  original_price REAL,                 -- Preço "de" (antes do desconto)
  discount_percent REAL DEFAULT 0,
  installments_count INTEGER,          -- Parcelas
  installments_value REAL,
  free_shipping INTEGER DEFAULT 0,
  in_stock INTEGER DEFAULT 1,
  product_url TEXT,                    -- URL da página do produto
  checkout_url TEXT,                   -- URL de checkout direto (deeplink)
  affiliate_url TEXT,                  -- URL final com tracking de afiliado
  image_url TEXT,
  condition TEXT DEFAULT 'new',        -- 'new', 'used', 'refurbished'
  seller_name TEXT,                    -- Nome do seller (para ML/Shopee)
  seller_rating REAL,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  cache_expires_at DATETIME,           -- Quando esse preço "vence"
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  UNIQUE(product_id, store_id, external_id)
);

-- Padrões de URL por loja (tabela de deeplinks configurável)
CREATE TABLE IF NOT EXISTS url_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  pattern_type TEXT NOT NULL,          -- 'cart', 'checkout', 'product', 'deeplink'
  url_template TEXT NOT NULL,          -- Template com {ID}, {SKU}, {AFFILIATE_ID}
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

-- Fila de atualização de preços (Background Jobs)
CREATE TABLE IF NOT EXISTS price_update_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL,
  priority INTEGER DEFAULT 5,          -- 1=urgente (clicado), 5=normal, 10=baixo
  status TEXT DEFAULT 'pending',       -- 'pending', 'processing', 'done', 'failed'
  attempts INTEGER DEFAULT 0,
  last_attempt_at DATETIME,
  scheduled_for DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);

-- Log de cliques (analytics + prioridade de atualização)
CREATE TABLE IF NOT EXISTS click_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  offer_id INTEGER,
  store_id INTEGER,
  ip_hash TEXT,                        -- Hash da IP para deduplicação
  user_agent TEXT,
  referrer TEXT,
  clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);

-- Categorias para navegação
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,                           -- emoji ou classe de ícone
  parent_id INTEGER,
  product_count INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
);

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_products_ean ON products(ean);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_best_price ON products(best_price);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_offers_product_id ON offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_store_id ON offers(store_id);
CREATE INDEX IF NOT EXISTS idx_offers_price ON offers(price);
CREATE INDEX IF NOT EXISTS idx_offers_last_updated ON offers(last_updated);
CREATE INDEX IF NOT EXISTS idx_offers_external_id ON offers(external_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON price_update_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_clicks_product ON click_events(product_id, clicked_at);
