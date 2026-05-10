-- ============================================================
-- MIGRATION 0020: Social Media — Contas + Fila de Posts
-- ============================================================

-- Contas de redes sociais conectadas
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,           -- 'instagram'|'facebook'|'x'|'linkedin'
  account_name TEXT NOT NULL,       -- nome exibido (@handle ou Page name)
  account_id TEXT,                  -- user_id ou page_id da plataforma
  access_token TEXT,                -- token principal (criptografado XOR)
  token_secret TEXT,                -- X: access_token_secret
  refresh_token TEXT,               -- LinkedIn: refresh token
  page_id TEXT,                     -- Meta: Facebook Page ID
  ig_user_id TEXT,                  -- Instagram Business User ID
  token_expires_at DATETIME,        -- quando o token expira
  is_active INTEGER DEFAULT 1,
  last_test_at DATETIME,
  last_test_ok INTEGER DEFAULT 0,
  last_test_msg TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Fila de postagens agendadas
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,         -- FK social_accounts
  platform TEXT NOT NULL,
  content_text TEXT NOT NULL,       -- legenda/texto do post
  image_url TEXT,                   -- URL pública da imagem
  link_url TEXT,                    -- link adicional
  hashtags TEXT,                    -- hashtags separadas por espaço
  ai_generated INTEGER DEFAULT 0,  -- gerado por IA?
  ai_prompt TEXT,                   -- prompt usado
  status TEXT DEFAULT 'draft',      -- 'draft'|'scheduled'|'publishing'|'published'|'failed'|'cancelled'
  scheduled_at DATETIME,            -- quando publicar (NULL = rascunho)
  published_at DATETIME,
  error_message TEXT,
  platform_post_id TEXT,            -- ID retornado pela rede após publicação
  platform_post_url TEXT,           -- URL pública do post publicado
  created_by TEXT,                  -- admin que criou
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform ON social_accounts(platform, is_active);
CREATE INDEX IF NOT EXISTS idx_social_posts_status      ON social_posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_account     ON social_posts(account_id, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled   ON social_posts(scheduled_at, status);
