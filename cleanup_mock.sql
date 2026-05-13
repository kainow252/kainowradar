-- Limpeza completa dos dados mockados — ordem correta sem PRAGMA
-- 1. price_update_queue referencia offers
DELETE FROM price_update_queue WHERE offer_id IN (SELECT id FROM offers WHERE product_id IN (1,2,3,4,5,6,7,92,129));
-- 2. click_events referencia offers E products
DELETE FROM click_events WHERE offer_id IN (SELECT id FROM offers WHERE product_id IN (1,2,3,4,5,6,7,92,129));
DELETE FROM click_events WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 3. price_history referencia offers E products
DELETE FROM price_history WHERE offer_id IN (SELECT id FROM offers WHERE product_id IN (1,2,3,4,5,6,7,92,129));
DELETE FROM price_history WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 4. price_alerts referencia products
DELETE FROM price_alerts WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 5. user_price_alerts referencia products
DELETE FROM user_price_alerts WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 6. ml_affiliate_imports referencia products
DELETE FROM ml_affiliate_imports WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 7. ai_editorial referencia products
DELETE FROM ai_editorial WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 8. offers referencia products
DELETE FROM offers WHERE product_id IN (1,2,3,4,5,6,7,92,129);
-- 9. finalmente, deletar os produtos mockados
DELETE FROM products WHERE id IN (1,2,3,4,5,6,7,92,129);
