-- ============================================================
-- Migration 0027: Sistema de API Keys para acesso externo
-- Permite parceiros/devs acessar dados via X-API-Key
-- ============================================================

-- Tabela principal de chaves de API
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL,                    -- Nome do parceiro/app
  key_hash    TEXT NOT NULL UNIQUE,             -- SHA-256 do token (nunca armazena raw)
  key_prefix  TEXT NOT NULL,                    -- Primeiros 8 chars para identificar (ex: kr_live_ab)
  owner_email TEXT,                             -- Email do responsável
  plan        TEXT NOT NULL DEFAULT 'free',     -- free | pro | enterprise
  scopes      TEXT NOT NULL DEFAULT 'read',     -- read | read,write | admin
  rate_limit  INTEGER NOT NULL DEFAULT 100,     -- req/hora permitidas
  is_active   INTEGER NOT NULL DEFAULT 1,
  last_used_at DATETIME,
  expires_at  DATETIME,                         -- NULL = sem expiração
  total_calls INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes       TEXT
);

-- Log de uso da API (últimos 30 dias)
CREATE TABLE IF NOT EXISTS api_usage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,                    -- ex: /api/v1/products
  method      TEXT NOT NULL DEFAULT 'GET',
  status_code INTEGER NOT NULL DEFAULT 200,
  ip_hash     TEXT,                             -- Hash do IP (privacidade)
  user_agent  TEXT,
  duration_ms INTEGER,
  called_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix    ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active    ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_api_usage_key_id   ON api_usage_log(key_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_called_at ON api_usage_log(called_at);

-- Rate limit counters no KV (gerenciado em runtime, não D1)
-- Chave KV: rl:{key_id}:{hora_unix}  → contador de requisições
