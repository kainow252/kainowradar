-- Migration 0024: Integração Lomadee API
-- Adiciona suporte a lojas e produtos importados via API da Lomadee

-- Coluna lomadee_org_id em stores: UUID da organização na Lomadee
ALTER TABLE stores ADD COLUMN lomadee_org_id TEXT;

-- Coluna lomadee_id em offers: ID do produto na Lomadee (campo "id" do produto)
ALTER TABLE offers ADD COLUMN lomadee_id TEXT;

-- Índices para busca rápida
CREATE INDEX IF NOT EXISTS idx_stores_lomadee_org_id ON stores(lomadee_org_id);
CREATE INDEX IF NOT EXISTS idx_offers_lomadee_id ON offers(lomadee_id);
