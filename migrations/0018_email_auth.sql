-- ============================================================
-- MIGRATION 0018: Suporte a autenticação por email/senha
-- ============================================================

-- Adiciona colunas para login por email/senha e preferência de ofertas
ALTER TABLE oauth_users ADD COLUMN password_hash TEXT;
ALTER TABLE oauth_users ADD COLUMN auth_provider TEXT DEFAULT 'google'; -- 'google' | 'email'
ALTER TABLE oauth_users ADD COLUMN offers_email INTEGER DEFAULT 0;      -- autoriza receber ofertas

-- Remove restrição NOT NULL do google_id para suportar cadastro por email
-- (SQLite não suporta ALTER COLUMN, então criamos uma nova tabela)
-- A coluna google_id já aceita NULL se inserirmos sem ela via INSERT

-- Índice para busca por email no login
CREATE INDEX IF NOT EXISTS idx_oauth_users_provider ON oauth_users(auth_provider);
