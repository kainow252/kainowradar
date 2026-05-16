#!/usr/bin/env python3
"""
shopee_fix_prices.py
--------------------
Busca preços reais dos produtos Shopee via API interna (/api/v4/pdp/get_pc)
usando o IP do sandbox (brasileiro → sem bloqueio de geolocalização).

Gera um arquivo SQL com os UPDATEs para aplicar no D1 remoto via wrangler.
"""

import json
import time
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# ── Offers com preço R$0,01 que precisam de correção ─────────────────────────
OFFERS = [
    {"id": 1142, "external_id": "23394276680", "external_sku": "1429781525",
     "affiliate_url": "https://s.shopee.com.br/6L1KILb3ZY",
     "title": "Kit 6/12/18/24 Panos De Limpeza Aço Premium"},
    {"id": 1143, "external_id": "19399549510", "external_sku": "1127030290",
     "affiliate_url": "https://s.shopee.com.br/W3XLqQ2d9",
     "title": "Máquina Nebulizadora Portátil Inalador"},
    {"id": 1144, "external_id": "23799391942", "external_sku": "330607227",
     "affiliate_url": "https://s.shopee.com.br/3g0Z7gdyrY",
     "title": "Body Splash Feminino Ameixa Negra 200ml"},
    {"id": 1145, "external_id": "27893329314", "external_sku": "1362613236",
     "affiliate_url": "https://s.shopee.com.br/3Vh8vOeDAv",
     "title": "Smartwatch Relógio Inteligente Tela Infinita"},
    {"id": 1146, "external_id": "23093068858", "external_sku": "535866882",
     "affiliate_url": "https://s.shopee.com.br/5L8n7GqfyK",
     "title": "Conjunto 5 Potes de Vidro Hermetico Bowl"},
    {"id": 1147, "external_id": "58210082441", "external_sku": "1004806694",
     "affiliate_url": "https://s.shopee.com.br/9UyM4wIoLq",
     "title": "Kit Figurinha Álbum Copa do Mundo 2026"},
    {"id": 1148, "external_id": "23293480319", "external_sku": "1284769631",
     "affiliate_url": "https://s.shopee.com.br/5q53iYF9Ux",
     "title": "Mini Compressor de Ar Portátil 4 em 1"},
    {"id": 1149, "external_id": "23598669907", "external_sku": "1478371070",
     "affiliate_url": "https://s.shopee.com.br/2BBlLp1gsc",
     "title": "Bolsa de maternidade multifuncional térmica"},
    {"id": 1150, "external_id": "58256443834", "external_sku": "1603111326",
     "affiliate_url": "https://s.shopee.com.br/7pq86FgKgH",
     "title": "Coberdron Queen Edredon Dupla Face Sherpa"},
    {"id": 1151, "external_id": "13590189810", "external_sku": "338251868",
     "affiliate_url": "https://s.shopee.com.br/7VDHheJxeU",
     "title": "Linha Mamãe e Bebê Natura"},
]

# ── Também inclui offer 1141 que já tem preço mas pode estar desatualizado ───
# (descomente se quiser atualizar todos, não apenas R$0,01)
# OFFERS.append({"id": 1141, "external_id": "16692338189", "external_sku": "552896405", ...})


def fetch_shopee_price(shop_id: str, item_id: str) -> dict | None:
    """
    Busca dados do produto via API interna Shopee.
    Funciona de IPs brasileiros; bloqueada de IPs Cloudflare (fora do BR).
    Retorna dict com price, title, image ou None em caso de erro.
    """
    url = (
        f"https://shopee.com.br/api/v4/pdp/get_pc"
        f"?item_id={item_id}&shop_id={shop_id}"
    )
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36",
        "Referer": f"https://shopee.com.br/produto/{shop_id}/{item_id}",
        "Accept": "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "x-api-source": "pc",
        "x-shopee-language": "pt-BR",
    }

    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)

        # Verifica código de retorno
        code = data.get("error") or data.get("errcode") or 0
        if code and code != 0:
            print(f"  ⚠️  API retornou erro {code} para shop={shop_id} item={item_id}")
            return None

        item = data.get("data") or data.get("item")
        if not item:
            print(f"  ⚠️  Sem campo 'data'/'item' para shop={shop_id} item={item_id}")
            return None

        # Extrai preço (em centavos → divide por 100000)
        price_raw = None
        price_info = item.get("price_info") or []
        if price_info and isinstance(price_info, list):
            # Pega o primeiro price_info disponível
            pi = price_info[0]
            price_raw = pi.get("price")
        if price_raw is None:
            price_raw = item.get("price") or item.get("price_min")

        price = None
        if price_raw is not None:
            price = round(price_raw / 100000, 2)

        # Extrai título
        title = item.get("name") or item.get("title")

        # Extrai imagem principal
        images = item.get("images") or []
        image = None
        if images:
            img_hash = images[0]
            image = f"https://down-br.img.susercontent.com/file/{img_hash}"

        return {"price": price, "title": title, "image": image}

    except HTTPError as e:
        print(f"  ❌ HTTP {e.code} para shop={shop_id} item={item_id}: {e.reason}")
        return None
    except URLError as e:
        print(f"  ❌ URLError para shop={shop_id} item={item_id}: {e.reason}")
        return None
    except json.JSONDecodeError as e:
        print(f"  ❌ JSON inválido para shop={shop_id} item={item_id}: {e}")
        return None
    except Exception as e:
        print(f"  ❌ Erro inesperado para shop={shop_id} item={item_id}: {e}")
        return None


def resolve_short_url(short_url: str) -> tuple[str | None, str | None]:
    """
    Resolve link curto Shopee via facebookexternalhit para extrair
    shop_id e item_id do meta tag al:web:url.
    Fallback caso external_sku já esteja preenchido.
    """
    import re

    headers = {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
    }

    try:
        req = Request(short_url, headers=headers)
        with urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # Extrai al:web:url
        match = re.search(r'<meta\s+property=["\']al:web:url["\'][^>]+content=["\']([^"\']+)["\']', html)
        if not match:
            match = re.search(r'<meta\s+content=["\']([^"\']+)["\'][^>]+property=["\']al:web:url["\']', html)

        if match:
            web_url = match.group(1)
            # Formato: https://shopee.com.br/produto-ITEM_ID.SHOP_ID
            # ou https://shopee.com.br/SHOP_ID/ITEM_ID
            m2 = re.search(r'shopee\.com\.br/(?:[^/]+/)?(\d+)/(\d+)', web_url)
            if m2:
                shop_id = m2.group(1)
                item_id = m2.group(2)
                return shop_id, item_id

            # Tenta padrão com hífens: ...produto-SHOP_ID-ITEM_ID.html
            m3 = re.search(r'-(\d+)\.(\d+)', web_url)
            if m3:
                return m3.group(1), m3.group(2)

        print(f"  ⚠️  Não encontrou al:web:url em {short_url}")
        return None, None

    except Exception as e:
        print(f"  ❌ Erro ao resolver {short_url}: {e}")
        return None, None


def main():
    print("=" * 65)
    print("  shopee_fix_prices.py — Correção de preços R$0,01")
    print("=" * 65)
    print()

    results = []
    sql_lines = []
    sql_lines.append("-- Correção de preços Shopee gerada por shopee_fix_prices.py")
    sql_lines.append(f"-- Data: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    sql_lines.append("")

    for offer in OFFERS:
        offer_id  = offer["id"]
        item_id   = offer["external_id"]    # id do produto Shopee
        shop_id   = offer["external_sku"]   # id da loja Shopee
        short_url = offer["affiliate_url"]
        title_db  = offer["title"]

        print(f"[{offer_id}] {title_db[:55]}...")
        print(f"       shop_id={shop_id}  item_id={item_id}")

        # ── Tenta buscar preço via API interna ────────────────────────────
        result = fetch_shopee_price(shop_id, item_id)

        if result is None:
            # Fallback: resolve link curto para obter IDs corretos
            print(f"  🔄 Tentando resolver link curto: {short_url}")
            resolved_shop, resolved_item = resolve_short_url(short_url)

            if resolved_shop and resolved_item:
                print(f"  🔗 IDs resolvidos: shop={resolved_shop} item={resolved_item}")
                result = fetch_shopee_price(resolved_shop, resolved_item)
                if result:
                    shop_id = resolved_shop
                    item_id = resolved_item

        if result is None:
            print(f"  ❌ Sem dados para offer {offer_id}\n")
            results.append({"offer_id": offer_id, "status": "failed", "price": None})
            continue

        price = result.get("price")
        title = result.get("title") or title_db
        image = result.get("image")

        if price is None:
            print(f"  ⚠️  API retornou dados mas sem preço para offer {offer_id}")
            price_display = "sem preço"
        else:
            price_display = f"R$ {price:.2f}"

        print(f"  ✅ price={price_display}")
        if title and title != title_db:
            print(f"  📝 title={title[:60]}")
        if image:
            print(f"  🖼️  image={image[:60]}...")

        results.append({
            "offer_id": offer_id,
            "status": "ok",
            "price": price,
            "title": title,
            "image": image,
            "shop_id": shop_id,
            "item_id": item_id,
        })

        # Gera SQL de UPDATE
        if price is not None and price > 0.01:
            title_escaped = (title or "").replace("'", "''")
            image_sql = f"'{image}'" if image else "image_url"
            sql_lines.append(
                f"UPDATE offers SET "
                f"price={price}, "
                f"image_url={image_sql}, "
                f"title='{title_escaped}', "
                f"last_updated=CURRENT_TIMESTAMP "
                f"WHERE id={offer_id};"
            )

        print()
        time.sleep(0.8)  # delay gentil para não sobrecarregar a API

    # ── Salva arquivo SQL ──────────────────────────────────────────────────
    sql_path = "/home/user/webapp/scripts/fix_shopee_prices.sql"
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sql_lines) + "\n")

    # ── Resumo ─────────────────────────────────────────────────────────────
    print("=" * 65)
    print("RESUMO:")
    ok      = [r for r in results if r["status"] == "ok" and r["price"] and r["price"] > 0.01]
    no_price = [r for r in results if r["status"] == "ok" and (not r["price"] or r["price"] <= 0.01)]
    failed  = [r for r in results if r["status"] == "failed"]

    print(f"  ✅ Com preço válido : {len(ok)}")
    print(f"  ⚠️  Sem preço        : {len(no_price)}")
    print(f"  ❌ Falha na API     : {len(failed)}")
    print()

    if ok:
        print("Preços obtidos:")
        for r in ok:
            print(f"  offer {r['offer_id']}: R$ {r['price']:.2f}")
        print()
        print(f"✅ SQL salvo em: {sql_path}")
        print()
        print("Execute para aplicar no D1 remoto:")
        print(f"  cd /home/user/webapp && npx wrangler d1 execute webapp-production --remote --file=./scripts/fix_shopee_prices.sql")
    else:
        print("⚠️  Nenhum preço válido obtido.")
        if failed:
            print("   Verifique se a API Shopee está acessível do sandbox.")
            print("   Possível causa: IP bloqueado ou rate limit.")

    print("=" * 65)

    # Salva JSON com resultados para debug
    json_path = "/home/user/webapp/scripts/fix_shopee_prices_result.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"📊 Resultado completo em: {json_path}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
