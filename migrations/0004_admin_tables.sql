-- ============================================================
-- MIGRATION 0004: Tabelas de Gestão Administrativa
-- api_configs, users, admin_sessions, price_history
-- ============================================================

-- Configurações de APIs e Integrações
CREATE TABLE IF NOT EXISTS api_configs (
  id TEXT PRIMARY KEY,                  -- 'amazon', 'mercadolivre', 'lomadee'
  name TEXT NOT NULL,
  network TEXT NOT NULL,                -- 'amazon-pa-api', 'meli-api', 'lomadee', 'awin'
  client_id TEXT,
  client_secret TEXT,
  api_key TEXT,
  partner_tag TEXT,                     -- tag de afiliado (Amazon)
  endpoint_url TEXT,
  feed_url TEXT,                        -- URL do feed XML/CSV
  feed_type TEXT DEFAULT 'api',         -- 'api', 'xml', 'csv'
  rate_limit_per_min INTEGER DEFAULT 10,
  commission_rate REAL DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  last_sync_at DATETIME,
  last_sync_status TEXT,                -- 'ok', 'error', 'rate_limited'
  last_sync_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Usuários do shopping (clientes / membros)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                  -- UUID
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  password_hash TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'customer',         -- 'customer', 'admin'
  status TEXT DEFAULT 'active',         -- 'active', 'blocked', 'pending'
  wishlist TEXT DEFAULT '[]',           -- JSON array de product slugs
  price_alerts TEXT DEFAULT '[]',       -- JSON array de alertas
  last_login_at DATETIME,
  login_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessões de admin (tokens temporários)
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_user TEXT NOT NULL DEFAULT 'admin',
  ip_hash TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  is_valid INTEGER DEFAULT 1
);

-- Histórico de preços (para gráficos de evolução)
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

-- Alertas de preço
CREATE TABLE IF NOT EXISTS price_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                         -- NULL = anônimo (por email)
  email TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  target_price REAL NOT NULL,           -- Avisar quando chegar nesse preço
  status TEXT DEFAULT 'active',         -- 'active', 'triggered', 'cancelled'
  triggered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ── Índices de performance ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_price_history_offer ON price_history(offer_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_price_alerts_product ON price_alerts(product_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON admin_sessions(token, is_valid);
