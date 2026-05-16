-- Migration 0031: preenche ml_item_id retroativamente
-- Para produtos que têm o MLB-ID embutido no slug mas ml_item_id = NULL
-- Extrai dígitos do padrão MLB-XXXXXXXX ou MLBXXXXXXXX no slug
--
-- SQLite não tem regex nativa, então usamos LIKE + SUBSTR para cobrir o padrão
-- comum: slugs do tipo "nome-produto-1234567890-abc" onde o número é o MLB-ID
--
-- Estratégia: UPDATE com subquery que extrai o ml_item_id da affiliate_url da offer
-- (que pode ter o MLB na path mesmo que o affiliate_url seja /social/)
-- Para os demais, deixa NULL — fix-names ou enrich preencherão depois

-- Passo 1: preenche ml_item_id a partir da affiliate_url das offers que TÊM MLB no path
-- Ex: affiliate_url = "https://produto.mercadolivre.com.br/MLB-5871600420-relogio..."
UPDATE products
SET ml_item_id = (
  SELECT REPLACE(
    REPLACE(
      SUBSTR(o.affiliate_url,
        INSTR(UPPER(o.affiliate_url), 'MLB-') + 4,
        12
      ),
      '-', ''
    ),
    '_', ''
  )
  FROM offers o
  WHERE o.product_id = products.id
    AND (
      UPPER(o.affiliate_url) LIKE '%/MLB-%'
      OR UPPER(o.affiliate_url) LIKE '%/P/MLB%'
    )
  LIMIT 1
)
WHERE (ml_item_id IS NULL OR ml_item_id = '')
  AND EXISTS (
    SELECT 1 FROM offers o
    WHERE o.product_id = products.id
      AND (
        UPPER(o.affiliate_url) LIKE '%/MLB-%'
        OR UPPER(o.affiliate_url) LIKE '%/P/MLB%'
      )
  );
