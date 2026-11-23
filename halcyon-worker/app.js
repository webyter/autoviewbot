const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100)
const productsElement = document.querySelector('#products')
const notice = document.querySelector('#notice')
const result = document.querySelector('#result')
const pay = document.querySelector('#pay')
let products = []
let basket = []
let pending = false

function element(tag, text, parent) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  parent?.append(node)
  return node
}
async function api(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'The request failed. Please try again.')
  return data
}
function selector(label, options, parent) {
  const node = element('label', label, parent)
  const select = element('select', undefined, node)
  for (const option of options) element('option', option, select)
  return select
}
function renderProducts() {
  productsElement.replaceChildren()
  const category = document.querySelector('#category').value
  const query = document.querySelector('#search').value.trim().toLowerCase()
  const sort = document.querySelector('#sort').value
  const filtered = products.filter(product => (!category || product.category === category) && (product.name + ' ' + product.material + ' ' + product.shortDescription).toLowerCase().includes(query))
  if (sort === 'low') filtered.sort((a,b) => a.price - b.price)
  if (sort === 'high') filtered.sort((a,b) => b.price - a.price)
  if (sort === 'name') filtered.sort((a,b) => a.name.localeCompare(b.name))
  notice.textContent = filtered.length + (filtered.length === 1 ? ' piece' : ' pieces') + (query ? ' matching “' + query + '”' : ' in the collection')
  if (!filtered.length) element('p', 'No pieces found. Try another search or collection.', productsElement)
  for (const product of filtered) {
    const article = element('article', undefined, productsElement)
    article.className = 'product-card'
    const photo = element('div', undefined, article)
    photo.className = 'product-photo'
    const image = element('img', undefined, photo)
    const photos = {
      'cl-overcoat': '1544022613-e87ca75a784a', 'cl-rollneck': '1434389677669-e08b4cac3105',
      'cl-slipdress': '1595777457583-95e059d581b8', 'cl-trousers': '1473966968600-fa801b869a1a',
      'sh-chelsea': '1638247025967-b4e38f787b76', 'sh-loafer': '1614252235316-8c857d38b5f4',
      'sh-sneaker': '1549298916-b41d501d3772', 'sh-ankleboot': '1543163521-1bf539c55dd2',
      'bg-tote': '1548036328-c9fa89d128fa', 'bg-crossbody': '1584917865442-de89df76afd3',
      'bg-basket': '1590874103328-eac38a683ce7', 'bg-weekender': '1553062407-98eeb64c6a62',
      'wt-meridian': '1524805444758-089113d48a6d', 'wt-regent': '1523275335684-37898b6baf30',
      'wt-chronograph': '1547996160-81dfa63595aa', 'wt-otford': '1508685096489-7aacd43bd3b1'
    }
    image.src = 'https://images.unsplash.com/photo-' + (photos[product.id] || photos['cl-overcoat']) + '?auto=format&fit=crop&w=650&q=80'
    image.alt = 'Illustrative ' + product.category + ' photography'
    image.loading = 'lazy'
    image.addEventListener('error', () => { image.hidden = true; photo.setAttribute('aria-label', 'Image unavailable') }, { once: true })
    if (product.badge) element('span', product.badge, photo).className = 'badge'
    element('h3', product.name, article)
    element('p', money(product.price), article).className = 'product-price'
    element('p', product.shortDescription, article).className = 'product-description'
    element('p', product.material, article).className = 'product-material'
    const swatches = element('div', undefined, article)
    swatches.className = 'swatches'
    for (const colour of product.colours) {
      const swatch = element('span', undefined, swatches)
      swatch.className = 'swatch'
      if (/^#[0-9a-f]{3,8}$/i.test(colour.hex)) swatch.style.backgroundColor = colour.hex
      swatch.title = colour.name
    }
    const variants = element('div', undefined, article)
    variants.className = 'variants'
    const size = selector('Size', product.sizes, variants)
    const colour = selector('Colour', product.colours.map(colour => colour.name), variants)
    const button = element('button', product.stock ? 'Add to basket' : 'Sold out', article)
    button.type = 'button'
    button.disabled = !product.stock
    button.addEventListener('click', () => {
      const total = basket.filter(line => line.productId === product.id).reduce((sum, line) => sum + line.qty, 0)
      const line = basket.find(line => line.productId === product.id && line.size === size.value && line.colour === colour.value)
      if (total >= product.stock || (line?.qty ?? 0) >= 10) {
        notice.textContent = 'The available quantity for this piece is already in your basket.'
        return
      }
      if (line) line.qty += 1
      else basket.push({ productId: product.id, size: size.value, colour: colour.value, qty: 1 })
      notice.textContent = product.name + ' added to your basket.'
      renderBasket()
    })
  }
}
function renderBasket() {
  const container = document.querySelector('#lines')
  container.replaceChildren()
  let subtotal = 0
  basket.forEach((line, index) => {
    const product = products.find(product => product.id === line.productId)
    subtotal += product.price * line.qty
    const row = element('div', undefined, container)
    row.className = 'basket-line'
    element('span', product.name + ' · ' + line.size + ' · ' + line.colour + ' · ' + money(product.price * line.qty), row)
    const quantity = element('input', undefined, row)
    quantity.type = 'number'
    quantity.min = '1'
    quantity.max = String(Math.min(10, product.stock))
    quantity.value = String(line.qty)
    quantity.setAttribute('aria-label', 'Quantity for ' + product.name)
    quantity.addEventListener('change', () => {
      const value = Number(quantity.value)
      const other = basket.filter(item => item !== line && item.productId === line.productId).reduce((sum, item) => sum + item.qty, 0)
      if (Number.isInteger(value) && value >= 1 && value <= 10 && other + value <= product.stock) line.qty = value
      renderBasket()
    })
    const remove = element('button', 'Remove', row)
    remove.type = 'button'
    remove.addEventListener('click', () => { basket.splice(index, 1); renderBasket() })
  })
  element('p', basket.length ? 'Subtotal ' + money(subtotal) + ' · Delivery and promotions calculated at checkout.' : 'Your basket is empty.', container)
  document.querySelector('#count').textContent = String(basket.reduce((sum, line) => sum + line.qty, 0))
  pay.disabled = pending || !basket.length
  try { sessionStorage.setItem('halcyon-basket', JSON.stringify(basket)) } catch {}
}
document.querySelector('#category').addEventListener('change', renderProducts)
document.querySelector('#search').addEventListener('input', renderProducts)
document.querySelector('#sort').addEventListener('change', renderProducts)
for (const control of document.querySelectorAll('[data-category]')) {
  control.addEventListener('click', () => {
    document.querySelector('#category').value = control.dataset.category
    for (const tab of document.querySelectorAll('.category-tabs button')) {
      const active = tab.dataset.category === control.dataset.category
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-pressed', String(active))
    }
    renderProducts()
  })
}
document.querySelector('#checkout').addEventListener('submit', async event => {
  event.preventDefault()
  if (pending || !basket.length) return
  pending = true
  renderBasket()
  result.textContent = 'Preparing checkout…'
  try {
    const form = Object.fromEntries(new FormData(event.currentTarget))
    const data = await api('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, items: basket }),
    })
    if (data.mode === 'stripe') {
      window.location.assign(data.url)
      return
    }
    result.textContent = 'Sandbox order ' + data.order.number + ' completed. Total ' + money(data.order.total) + '. No payment was taken.'
    basket = []
  } catch (error) {
    result.textContent = error.message
  } finally {
    pending = false
    renderBasket()
  }
})
async function load() {
  pay.disabled = true
  try {
    const [catalogue, config] = await Promise.all([api('/api/products'), api('/api/config')])
    products = catalogue.products
    try {
      const saved = JSON.parse(sessionStorage.getItem('halcyon-basket') ?? '[]')
      if (Array.isArray(saved)) basket = saved.filter(line => {
        const product = products.find(product => product.id === line?.productId)
        return product && Number.isInteger(line.qty) && line.qty >= 1 && line.qty <= Math.min(10, product.stock)
          && product.sizes.includes(line.size) && product.colours.some(colour => colour.name === line.colour)
      })
    } catch {}
    notice.textContent = products.length + ' pieces in the collection'
    document.querySelector('#payment-mode').textContent = config.stripeEnabled ? 'Continue to Stripe to pay securely.' : 'Sandbox checkout. No payment will be taken.'
    renderProducts()
    renderBasket()
    if (location.pathname === '/checkout/success') {
      const params = new URLSearchParams(location.search)
      const id = params.get('session_id')
      if (!id) throw new Error('Missing checkout session id.')
      const { order } = await api('/api/checkout/session?id=' + encodeURIComponent(id))
      if (order.status === 'paid') { basket = []; renderBasket() }
      result.textContent = 'Order ' + order.number + ' · ' + order.status + ' · ' + money(order.total)
      result.scrollIntoView()
    }
    if (new URLSearchParams(location.search).get('cancelled') === '1') result.textContent = 'Checkout cancelled. Your basket is ready to try again.'
  } catch (error) {
    notice.textContent = error.message
  }
}
load()
