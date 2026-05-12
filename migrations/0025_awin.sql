-- Migration 0025: Integração Awin API
-- Tabela de programas Awin + vinculação com stores

-- Tabela de programas/anunciantes da Awin (cache local)
CREATE TABLE IF NOT EXISTS awin_programmes (
  id              INTEGER PRIMARY KEY,        -- advertiser ID da Awin
  name            TEXT NOT NULL,
  logo_url        TEXT,
  primary_region  TEXT DEFAULT 'Brazil',
  status          TEXT DEFAULT 'Active',
  relationship    TEXT DEFAULT 'notjoined',   -- 'joined' | 'notjoined' | 'pending'
  joined_at       DATETIME,
  synced_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_awin_programmes_status ON awin_programmes(status, relationship);

-- Vincula stores à Awin pelo advertiser ID
ALTER TABLE stores ADD COLUMN awin_advertiser_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_stores_awin_id ON stores(awin_advertiser_id);

-- Atualiza as lojas já conhecidas com seus advertiser IDs da Awin BR
UPDATE stores SET awin_advertiser_id = 17629 WHERE slug = 'casasbahia';
UPDATE stores SET awin_advertiser_id = 17874 WHERE slug = 'extra';
UPDATE stores SET awin_advertiser_id = 17621 WHERE slug = 'pontofrio';   -- Pontofrio = ponto
UPDATE stores SET awin_advertiser_id = 17621 WHERE slug = 'ponto';
UPDATE stores SET awin_advertiser_id = 17590 WHERE slug = 'fastshop';
UPDATE stores SET awin_advertiser_id = 17729 WHERE slug = 'kabum';
UPDATE stores SET awin_advertiser_id = 17806 WHERE slug = 'centauro';

-- Atualiza affiliate_rules com publisher_id da Awin (será preenchido via secret)
-- network 'awin' já existe — apenas garante que o template está correto
UPDATE affiliate_rules
SET link_template = 'https://www.awin1.com/cread.php?awinmid={advertiser_id}&awinaffid={pub}&ued={url}'
WHERE network = 'awin';
