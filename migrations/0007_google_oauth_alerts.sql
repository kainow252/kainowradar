-- ============================================================
-- MIGRATION 0007: Google OAuth + Store Preferences + Alertas
-- ============================================================

-- Tabela principal de usuários OAuth (Google)
CREATE TABLE IF NOT EXISTS oauth_users (
  id TEXT PRIMARY KEY,                    -- UUID gerado no cadastro
  google_id TEXT UNIQUE NOT NULL,         -- ID único do Google
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  email_verified INTEGER DEFAULT 1,
  -- Preferências de notificação
  notify_email INTEGER DEFAULT 1,         -- alertas por email
  notify_whatsapp INTEGER DEFAULT 0,      -- alertas por whatsapp
  whatsapp_number TEXT,                   -- ex: 5511999999999
  -- Onboarding
  onboarding_done INTEGER DEFAULT 0,      -- já fez onboarding de lojas?
  -- Sessão
  session_token TEXT,                     -- token de sessão atual
  session_expires_at DATETIME,
  -- Metadata
  last_login_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  login_count INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Preferências de lojas por usuário
-- "quais lojas o usuário já tem conta"
CREATE TABLE IF NOT EXISTS user_store_prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  has_account INTEGER DEFAULT 1,         -- 1 = tem conta, 0 = não tem
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, store_id),
  FOREIGN KEY (user_id) REFERENCES oauth_users(id),
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

-- Alertas de preço (versão completa com OAuth)
CREATE TABLE IF NOT EXISTS user_price_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,                  -- referencia oauth_users
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,             -- denormalizado para email
  product_slug TEXT NOT NULL,
  product_image TEXT,
  target_price REAL NOT NULL,             -- avisar quando <= esse preço
  current_price REAL,                     -- preço no momento do alerta
  status TEXT DEFAULT 'active',           -- 'active', 'triggered', 'paused', 'deleted'
  triggered_at DATETIME,
  triggered_price REAL,                   -- preço que disparou
  triggered_store TEXT,                   -- loja que baixou o preço
  notify_email INTEGER DEFAULT 1,
  notify_whatsapp INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES oauth_users(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Log de emails/notificações enviadas
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  alert_id INTEGER,
  type TEXT NOT NULL,                     -- 'price_alert', 'welcome', 'weekly_deals'
  channel TEXT NOT NULL,                  -- 'email', 'whatsapp'
  recipient TEXT NOT NULL,               -- email ou número
  subject TEXT,
  status TEXT DEFAULT 'sent',            -- 'sent', 'failed', 'bounced'
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_oauth_users_google    ON oauth_users(google_id);
CREATE INDEX IF NOT EXISTS idx_oauth_users_email     ON oauth_users(email);
CREATE INDEX IF NOT EXISTS idx_oauth_users_session   ON oauth_users(session_token);
CREATE INDEX IF NOT EXISTS idx_store_prefs_user      ON user_store_prefs(user_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_user     ON user_price_alerts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_price_alerts_product  ON user_price_alerts(product_id, status);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active   ON user_price_alerts(status, target_price);
