-- ============================================================
-- Migration 0029: Infraestrutura de ingestion de feeds
-- raw_links  = buffer de entrada (tudo que chega, de qualquer fonte)
-- feed_batches = rastreia cada lote de importação
-- ============================================================

-- Lotes de importação (um por upload/sessão)
CREATE TABLE IF NOT EXISTS feed_batches (
  id            TEXT    PRIMARY KEY,            -- UUID gerado no frontend
  store_id      INTEGER REFERENCES stores(id),
  network       TEXT    NOT NULL DEFAULT 'manual', -- 'meli-api'|'awin'|'lomadee'|'manual'|'csv'
  source        TEXT    NOT NULL DEFAULT 'manual', -- 'manual'|'csv'|'api'
  total_links   INTEGER NOT NULL DEFAULT 0,
  matched       INTEGER NOT NULL DEFAULT 0,     -- casou com produto existente
  created       INTEGER NOT NULL DEFAULT 0,     -- criou produto novo
  updated       INTEGER NOT NULL DEFAULT 0,     -- atualizou preço/link existente
  skipped       INTEGER NOT NULL DEFAULT 0,     -- duplicata exata, sem mudança
  errors        INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'processing', -- processing|done|partial|error
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_batches_store    ON feed_batches(store_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_batches_status   ON feed_batches(status, started_at DESC);

-- Buffer de links brutos (uma linha por link/produto recebido)
CREATE TABLE IF NOT EXISTS raw_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT    NOT NULL REFERENCES feed_batches(id),
  store_id        INTEGER NOT NULL REFERENCES stores(id),
  network         TEXT    NOT NULL DEFAULT 'manual',

  -- Dados como chegaram no feed (imutáveis após insert)
  external_id     TEXT,          -- ID do produto na rede (ASIN, item_id ML, id Lomadee...)
  ean             TEXT,          -- EAN/GTIN/barcode se vier no feed
  name            TEXT NOT NULL, -- nome como veio no feed
  price           REAL,
  original_price  REAL,
  image_url       TEXT,
  affiliate_url   TEXT NOT NULL, -- link rastreado final
  product_url     TEXT,          -- URL da página do produto (sem parâmetros de afiliado)
  category        TEXT,
  brand           TEXT,
  description     TEXT,

  -- Resultado do matching
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | matched | created | updated | skipped | error
  match_method    TEXT,
  -- 'ean' | 'external_id' | 'ml_item_id' | 'name_exact' | 'name_fuzzy' | 'new'
  match_score     REAL,          -- 0.0–1.0 (1.0 = match exato)
  product_id      INTEGER REFERENCES products(id),
  offer_id        INTEGER REFERENCES offers(id),
  error_msg       TEXT,

  imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_raw_links_batch      ON raw_links(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_raw_links_store      ON raw_links(store_id, status);
CREATE INDEX IF NOT EXISTS idx_raw_links_ean        ON raw_links(ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_links_ext_id     ON raw_links(store_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_links_status     ON raw_links(status, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_links_product    ON raw_links(product_id) WHERE product_id IS NOT NULL;

-- Garante que products tem coluna source (para rastrear origem)
-- (safe: ignora se já existir)
ALTER TABLE products ADD COLUMN source TEXT DEFAULT 'manual';
