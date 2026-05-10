-- Migration 0014: Add custom fields to api_configs table
-- Adds support for user-created custom integrations and richer metadata

ALTER TABLE api_configs ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_configs ADD COLUMN description TEXT;
ALTER TABLE api_configs ADD COLUMN docs_url TEXT;
ALTER TABLE api_configs ADD COLUMN color TEXT DEFAULT '#6366F1';
ALTER TABLE api_configs ADD COLUMN icon TEXT DEFAULT '🔌';
ALTER TABLE api_configs ADD COLUMN auth_type TEXT DEFAULT 'API Key';
ALTER TABLE api_configs ADD COLUMN api_group TEXT DEFAULT 'Outros';
