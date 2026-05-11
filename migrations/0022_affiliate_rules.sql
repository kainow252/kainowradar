-- Migration 0022: Tabela affiliate_rules + affiliate_id nas stores
-- Permite configurar códigos de afiliado por rede e regenerar todos os links

-- Tabela de regras de afiliado por rede
CREATE TABLE IF NOT EXISTS affiliate_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  network     TEXT NOT NULL UNIQUE,   -- 'meli-api', 'awin', 'lomadee', etc.
  label       TEXT NOT NULL,          -- Nome legível: 'Mercado Livre Afiliados'
  publisher_id TEXT,                  -- código/ID do publisher nesta rede
  extra_param  TEXT,                  -- parâmetro extra (ex: matt_tool=38524122)
  link_template TEXT,                 -- template de URL: {url}?matt_word={pub}&matt_tool={extra}
  is_active   INTEGER DEFAULT 1,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed inicial — redes conhecidas (publisher_id preenchido onde já temos)
INSERT OR IGNORE INTO affiliate_rules (network, label, publisher_id, extra_param, link_template) VALUES
  ('meli-api',     'Mercado Livre Afiliados', 'cfegdhabc31955', 'matt_tool=38524122', '{url}?matt_word={pub}&{extra}&forceInApp=true'),
  ('awin',         'Awin',                    NULL,              NULL,                 '{url}?awc={pub}'),
  ('lomadee',      'Lomadee',                 NULL,              NULL,                 '{url}?sourceId={pub}'),
  ('amazon-pa-api','Amazon Associates',       NULL,              NULL,                 '{url}?tag={pub}'),
  ('shein-api',    'Shein Afiliados',         NULL,              NULL,                 '{url}?ref={pub}'),
  ('hotmart-api',  'Hotmart',                 NULL,              NULL,                 '{url}?ref={pub}'),
  ('eduzz-api',    'Eduzz',                   NULL,              NULL,                 '{url}?ref={pub}'),
  ('monetizze-api','Monetizze',               NULL,              NULL,                 '{url}?src={pub}');

-- Salva affiliate_id nas stores a partir das regras (será preenchido pelo admin)
-- A coluna já existe no schema original, só garantimos que está lá
-- (safe: já existe na tabela stores)
