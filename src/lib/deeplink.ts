// ============================================================
// LIB: Deeplink Engine — Gera URLs de checkout direto
// Módulo: Sistema de deeplinks por loja
// ============================================================

import type { Offer, Store, DeeplinkResult } from '../types'

// Padrões hardcoded como fallback (também vêm do DB)
const CHECKOUT_PATTERNS: Record<string, { cart: string; product: string }> = {
  amazon: {
    cart: 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1={ID}&Quantity.1=1&tag={AFFILIATE_ID}',
    product: 'https://www.amazon.com.br/dp/{ID}?tag={AFFILIATE_ID}',
  },
  magalu: {
    cart: 'https://www.magazineluiza.com.br/carrinho/adicionar/{ID}/',
    product: 'https://www.magazineluiza.com.br/produto/{ID}/',
  },
  mercadolivre: {
    cart: 'https://www.mercadolivre.com.br/checkout/buy?item_id={ID}&quantity=1',
    product: 'https://produto.mercadolivre.com.br/{ID}',
  },
  shopee: {
    cart: 'https://shopee.com.br/product/{ID}',
    product: 'https://shopee.com.br/product/{ID}',
  },
  americanas: {
    cart: 'https://www.americanas.com.br/produto/{ID}/add-to-cart',
    product: 'https://www.americanas.com.br/produto/{ID}',
  },
  casasbahia: {
    cart: 'https://www.casasbahia.com.br/produto/{ID}/carrinho',
    product: 'https://www.casasbahia.com.br/produto/{ID}',
  },
  submarino: {
    cart: 'https://www.submarino.com.br/produto/{ID}',
    product: 'https://www.submarino.com.br/produto/{ID}',
  },
  aliexpress: {
    cart: 'https://www.aliexpress.com/item/{ID}.html',
    product: 'https://www.aliexpress.com/item/{ID}.html',
  },
}

export class DeeplinkEngine {
  /**
   * Gera a melhor URL de checkout direto para uma oferta.
   * Prioridade: checkout_url salvo no DB → padrão da loja → product_url
   */
  static generate(offer: Offer, store: Store, preferCart = true): DeeplinkResult {
    const storeSlug = store.slug

    // 1. Usa checkout_url já calculado no DB (mais direto)
    if (offer.checkout_url) {
      return {
        store: storeSlug,
        store_name: store.name,
        url: offer.checkout_url,
        type: 'cart',
      }
    }

    // 2. Gera a partir do padrão hardcoded
    const patterns = CHECKOUT_PATTERNS[storeSlug]
    if (patterns) {
      const template = preferCart ? patterns.cart : patterns.product
      const url = DeeplinkEngine.fillTemplate(template, {
        ID: offer.external_id,
        SKU: offer.external_sku || offer.external_id,
        AFFILIATE_ID: store.affiliate_id || '',
      })
      return {
        store: storeSlug,
        store_name: store.name,
        url,
        type: preferCart ? 'cart' : 'product',
      }
    }

    // 3. Fallback: product_url direta
    return {
      store: storeSlug,
      store_name: store.name,
      url: offer.product_url || '#',
      type: 'product',
    }
  }

  /**
   * Gera deeplink via rede de afiliados (Lomadee, Awin, etc.)
   * Injeta seu ID de afiliado na URL final
   */
  static generateAffiliateUrl(
    productUrl: string,
    store: Store,
    network?: string
  ): string {
    const net = network || store.affiliate_network

    switch (net) {
      case 'amazon-pa-api':
        // Amazon: tag já está na URL
        return productUrl.includes('tag=')
          ? productUrl
          : `${productUrl}${productUrl.includes('?') ? '&' : '?'}tag=${store.affiliate_id}`

      case 'lomadee':
        // Lomadee: encapsula a URL dentro do redirect da rede
        return store.affiliate_id
          ? `https://www.lomadee.com/link/${store.affiliate_id}/?url=${encodeURIComponent(productUrl)}`
          : productUrl

      case 'awin':
        // Awin: deeplink direto
        return store.affiliate_id
          ? `https://www.awin1.com/cread.php?awinmid=${store.affiliate_id}&awinaffid=YOUR_AFFIL_ID&ued=${encodeURIComponent(productUrl)}`
          : productUrl

      case 'meli-api':
        // ML: adiciona parâmetro de rastreio
        return `${productUrl}${productUrl.includes('?') ? '&' : '?'}ref=shopping_comparador`

      default:
        return productUrl
    }
  }

  /**
   * Substitui placeholders no template
   * Ex: {ID} → 'B0CHX2LQBS', {AFFILIATE_ID} → 'seupartner-20'
   */
  static fillTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '')
  }

  /**
   * Gera URL de rastreamento de clique (passa pelo backend antes de redirecionar)
   */
  static trackingUrl(offerId: number, productSlug: string): string {
    return `/go/${productSlug}/${offerId}`
  }
}
