// ============================================================
// ROUTES: Onboarding — Página de seleção de lojas pós-login
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'
import { renderLayout } from './pages'

const onboarding = new Hono<{ Bindings: Bindings }>()

onboarding.get('/', async (c) => {
  const { DB } = c.env

  // Busca todas as lojas ativas
  const { results: stores } = await DB.prepare(
    `SELECT id, slug, name, logo_url FROM stores WHERE is_active = 1 ORDER BY name ASC`
  ).all<any>()

  const storesJSON = JSON.stringify(stores)

  const content = `
  <div class="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center px-4 py-12">
    <div class="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8">

      <!-- Header -->
      <div class="text-center mb-8">
        <div class="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <span class="text-white text-2xl font-bold">S</span>
        </div>
        <h1 class="text-2xl font-extrabold text-gray-900 mb-2">Bem-vindo ao ShoppingCompare! 🎉</h1>
        <p class="text-gray-500 text-sm leading-relaxed">
          Em quais lojas você <strong>já tem conta</strong>?<br>
          Vamos destacar onde é mais fácil para você comprar.
        </p>
      </div>

      <!-- Seleção de lojas -->
      <div id="stores-grid" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        ${stores.map((s: any) => `
          <button
            onclick="toggleStore(${s.id}, this)"
            data-store-id="${s.id}"
            class="store-btn flex flex-col items-center gap-2 p-3 rounded-2xl border-2 border-gray-200
                   hover:border-blue-400 hover:bg-blue-50 transition-all cursor-pointer relative"
          >
            <img src="${s.logo_url || ''}" alt="${s.name}"
                 class="h-8 object-contain" onerror="this.style.display='none'">
            <span class="text-xs font-semibold text-gray-700">${s.name}</span>
            <span class="check-icon hidden absolute top-1 right-1 w-5 h-5 bg-blue-600 rounded-full
                         flex items-center justify-center text-white text-xs">✓</span>
          </button>
        `).join('')}
      </div>

      <!-- Alertas de preço -->
      <div class="bg-blue-50 rounded-2xl p-5 mb-6 border border-blue-100">
        <h3 class="font-bold text-gray-900 mb-1">🔔 Alertas de preço gratuitos</h3>
        <p class="text-sm text-gray-600 mb-4">
          Te avisamos quando o preço de qualquer produto cair para o valor que você definir.
        </p>
        <div class="flex flex-col gap-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" id="notify-email" checked
              class="w-4 h-4 accent-blue-600 rounded">
            <span class="text-sm font-medium text-gray-700">📧 Receber alertas por <strong>email</strong></span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" id="notify-whatsapp"
              class="w-4 h-4 accent-green-600 rounded"
              onchange="toggleWhatsapp(this.checked)">
            <span class="text-sm font-medium text-gray-700">📱 Receber alertas por <strong>WhatsApp</strong></span>
          </label>
          <div id="whatsapp-field" class="hidden mt-1">
            <input type="tel" id="whatsapp-number"
              placeholder="Ex: 11999999999 (só números)"
              class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-green-400 focus:ring-2 focus:ring-green-100">
          </div>
        </div>
      </div>

      <!-- Botão continuar -->
      <button onclick="saveOnboarding()"
        class="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold
               py-4 rounded-2xl text-base transition-colors flex items-center justify-center gap-2">
        <span id="btn-text">Continuar para o ShoppingCompare</span>
        <svg id="btn-spinner" class="hidden animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
        </svg>
      </button>

      <p class="text-center text-xs text-gray-400 mt-4">
        Você pode alterar suas preferências a qualquer momento no seu perfil.
      </p>
    </div>
  </div>

  <script>
    const selectedStores = new Set()

    function toggleStore(id, btn) {
      if (selectedStores.has(id)) {
        selectedStores.delete(id)
        btn.classList.remove('border-blue-500', 'bg-blue-50')
        btn.classList.add('border-gray-200')
        btn.querySelector('.check-icon').classList.add('hidden')
      } else {
        selectedStores.add(id)
        btn.classList.add('border-blue-500', 'bg-blue-50')
        btn.classList.remove('border-gray-200')
        btn.querySelector('.check-icon').classList.remove('hidden')
      }
    }

    function toggleWhatsapp(checked) {
      document.getElementById('whatsapp-field').classList.toggle('hidden', !checked)
    }

    async function saveOnboarding() {
      const btn     = document.querySelector('button[onclick="saveOnboarding()"]')
      const btnText = document.getElementById('btn-text')
      const spinner = document.getElementById('btn-spinner')

      btnText.textContent = 'Salvando...'
      spinner.classList.remove('hidden')
      btn.disabled = true

      const body = {
        store_ids:       Array.from(selectedStores),
        notify_email:    document.getElementById('notify-email').checked,
        notify_whatsapp: document.getElementById('notify-whatsapp').checked,
        whatsapp_number: document.getElementById('whatsapp-number')?.value || null,
      }

      try {
        const res = await fetch('/auth/onboarding', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })
        if (res.ok) {
          window.location.href = '/'
        } else {
          throw new Error('Erro ao salvar')
        }
      } catch {
        btnText.textContent = 'Continuar para o ShoppingCompare'
        spinner.classList.add('hidden')
        btn.disabled = false
        alert('Erro ao salvar preferências. Tente novamente.')
      }
    }
  </script>
  `

  return c.html(renderLayout('Bem-vindo — ShoppingCompare', content, { hideHeader: true }))
})

export default onboarding
