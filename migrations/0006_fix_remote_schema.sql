-- ============================================================
-- MIGRATION 0006: Fix Remote Schema (idempotente)
-- Colunas de users já existem — só cria tabelas/índices
-- ============================================================

-- Copia name → full_name já não é necessário (coluna name não existe neste schema)

-- ── Tabela api_configs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  client_id TEXT,
  client_secret TEXT,
  api_key TEXT,
  partner_tag TEXT,
  endpoint_url TEXT,
  feed_url TEXT,
  feed_type TEXT DEFAULT 'api',
  rate_limit_per_min INTEGER DEFAULT 10,
  commission_rate REAL DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  last_sync_at DATETIME,
  last_sync_status TEXT,
  last_sync_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── Tabela admin_sessions ─────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_user TEXT NOT NULL DEFAULT 'admin',
  ip_hash TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  is_valid INTEGER DEFAULT 1
);

-- ── Tabela price_history ──────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  price REAL NOT NULL,
  in_stock INTEGER DEFAULT 1,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (offer_id) REFERENCES offers(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

-- ── Índices ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_price_history_offer   ON price_history(offer_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status          ON users(status);
CREATE INDEX IF NOT EXISTS idx_sessions_token        ON admin_sessions(token, is_valid);
