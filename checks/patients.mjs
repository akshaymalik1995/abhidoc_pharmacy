// Clerk check of Accounts > Patients: walks every step in patients.md and saves a screenshot per step.
// Run: node patients.mjs [workflow numbers, e.g. 1 3]   (needs :5002, :8000, :5173 running; uses the installed Chrome)
// Makes its own AKTEST data in the TEST database through the app's own requests. Never touches other records.
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const { chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright')
const APP = 'http://localhost:5173'
const DOC = 'http://localhost:5002'
const SECRETS = Object.fromEntries(readFileSync(`${process.env.USERPROFILE}/.claude/.secrets/docassist.env`, 'utf8')
  .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const ONLY = process.argv.slice(2)
const RUN = new Date().toISOString().slice(5, 19).replace(/\D/g, '')
const SHOTS = new URL('./screens/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const notes = []

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(15000)

/** Screenshot plus the checks a script can make by itself; the rest is judged by looking at the picture. */
async function shot(flow, step) {
  await page.waitForTimeout(600)
  mkdirSync(`${SHOTS}${flow}`, { recursive: true })
  await page.screenshot({ path: `${SHOTS}${flow}/${step}.png` })
  const seen = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body
    const text = main.innerText
    return {
      waitingWords: /Loading\.\.\.|Searching\.\.\./.test(text),
      pageSideways: document.documentElement.scrollWidth > innerWidth,
      sentences: [...main.querySelectorAll('p, .mantine-Alert-message, .mantine-Text-root')].map((e) => e.innerText.trim())
        .filter((t) => t.split(' ').length >= 7 && /[a-z]\.$/.test(t)).slice(0, 5),
      notices: [...document.querySelectorAll('.mantine-Notification-description')].map((e) => e.innerText),
    }
  })
  notes.push({ flow, step, ...seen })
}
const go = async (path) => { await page.goto(APP + path); await page.waitForLoadState('networkidle') }
const call = (path, method = 'GET', body) => page.evaluate(async ([path, method, body]) => {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const reply = await r.json().catch(() => ({}))
  if (!r.ok || reply.ok === false || reply.status === 'error') throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(reply).slice(0, 300)}`)
  return reply
}, [path, method, body])
async function flow(n, name, steps) {
  if (ONLY.length && !ONLY.includes(String(n))) return
  try { await steps(`${n}-${name}`) } catch (e) {
    await shot(`${n}-${name}`, 'FAILED').catch(() => {})
    notes.push({ flow: `${n}-${name}`, failed: e.message.split('\n')[0] })
  }
}

// ---- login: the saved admin login on DocAssist; its cookie serves the new app too ----
await page.goto(`${DOC}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 })
if (page.url().includes('/login')) {
  await page.locator('[name=username_or_email]').fill(SECRETS.DOCASSIST_ADMIN_EMAIL)
  await page.locator('[name=password]').fill(SECRETS.DOCASSIST_ADMIN_PASSWORD)
  await page.locator('[name=password]').press('Enter')
  await page.waitForURL((u) => !u.pathname.includes('/login')).catch(async (e) => { await page.screenshot({ path: 'login-failed.png' }); throw e })
}
await go('/')

// ---- 0. setup: one AKTEST walk-in patient with three unpaid bills ----
const MRN = `AKTEST-CC-${RUN}`
const NAME = `AKTEST Clerk ${RUN}`
const locations = await call('/api/masters/stock_locations')
const main = (locations.rows ?? locations).find((l) => /main pharmacy/i.test(l.name ?? l.location_name))
const LOCATION = main.id ?? main.location_id
// ponytail: the new app keeps the location only in the browser; DocAssist's saves need it in its own session (finding #1)
await call('/pharmacy/api/location-context', 'POST', { location_id: LOCATION })
const [item] = await call(`/api/sales/products?location_id=${LOCATION}&q=AKTEST 1106`)
await call('/pharmacy/api/stock/documents', 'POST', {
  stock_type: 'STOCK_ADJUSTMENT', document_date: new Date().toISOString().slice(0, 10), reference_number: `CHECK-${RUN}`, notes: 'clerk check', location_id: LOCATION,
  items: [{ pharmacy_item_id: item.item_id, quantity: '3', unit_cost_cents: 1000, unit_mrp_cents: 2000, batch_number: `AKTEST-CHECK-${RUN}`, expiry_date: '2028-12-31' }],
})
const [batch] = (await call(`/api/sales/products/${item.item_id}/batches?location_id=${LOCATION}`)).filter((b) => b.batch_number === `AKTEST-CHECK-${RUN}`)
const bills = []
for (let i = 0; i < 3; i++) {
  bills.push(await call('/pharmacy/api/sales', 'POST', {
    location_id: LOCATION, sales_type: 'SALE', status: 'CONFIRMED', document_date: new Date().toISOString().slice(0, 10), visit_type: 'WALK_IN',
    mrn: MRN, patient_name: NAME, contact_number: '0000000999', primary_payment_mode: 'CASH', paid_amount_cents: 0, rounded_amount_cents: 2000,
    items: [{ pharmacy_item_id: item.item_id, batch_id: batch.batch_id, quantity: '1', unit_price_cents: 2000, discount_amount_cents: 0, tax_percent: '0', unit_mrp_cents: 2000 }],
  }))
}
console.log('setup', { MRN, LOCATION, item: item.item_id, bills: bills.map((b) => b.sales_number) })

const dialog = () => page.getByRole('dialog')
const button = (name, where = page.locator('main')) => where.getByRole('button', { name, exact: true })
const field = (label, where = dialog()) => where.getByRole('textbox', { name: new RegExp(`^${label.replace(/[()₹+−]/g, '.')}`) })
// a press is done when the network is quiet and no button still shows its working state
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForFunction(() => !document.querySelector('[data-loading]'), null, { timeout: 30000 }) }
async function findPatient(by, text) {
  await page.locator('main').getByText(by, { exact: true }).click()
  await page.getByLabel('Find patient').fill(text)
  await page.getByLabel('Find patient').press('Enter')
  await settle()
}
const sessionId = async () => { const s = (await call(`/pharmacy/api/cashier-sessions/current?location_id=${LOCATION}`)).cashier_session; return s?.cashier_session_id ?? s?.id }

await flow(1, 'cashier-sessions', async (f) => {
  await go('/accounts/cashier-sessions'); await shot(f, '1.1-list')
  const id = await sessionId()
  if (id) { notes.push({ flow: f, step: '1.2', note: 'a session was already open; did not open another' }); await go(`/accounts/cashier-sessions/${id}`) }
  else {
    await button('Open cashier session').click(); await shot(f, '1.2a-open-form')
    await field('Opening float (₹)').fill('0'); await field('Remarks').fill(`clerk check ${RUN}`)
    await button('Open session', dialog()).click(); await settle()
  }
  await shot(f, '1.3-session-page')
  await page.getByRole('link', { name: 'Cashier sessions' }).click(); await settle(); await shot(f, '1.4-back-to-list')
})

await flow(2, 'patient-advance', async (f) => {
  await go('/accounts/patient-advance'); await shot(f, '2.1-empty')
  await findPatient('MRN', MRN); await shot(f, '2.2-found')
  await button('Collect advance').click(); await shot(f, '2.3a-collect-form')
  await field('Amount (₹)').fill('10'); await button('Collect advance', dialog()).click()
  await dialog().waitFor({ state: 'hidden' }); await shot(f, '2.3b-collected')
  await button('Refund advance').click(); await field('Amount (₹)').fill('2'); await shot(f, '2.4a-refund-form')
  await button('Refund advance', dialog()).click(); await dialog().waitFor({ state: 'hidden' }); await shot(f, '2.4b-refunded')
  await page.getByRole('link', { name: 'Bills', exact: true }).click(); await settle(); await shot(f, '2.5-bills-same-patient')
})

await flow(3, 'cash-counter', async (f) => {
  await go('/accounts/cash-counter'); await shot(f, '3.1-open')
  await page.getByLabel('Search', { exact: true }).fill(MRN); await settle(); await page.waitForTimeout(800); await shot(f, '3.2-searched')
  const [b1, b2] = bills.map((b) => b.sales_number)
  await page.getByLabel(`Select ${b1}`).check(); await page.getByLabel(`Amount for ${b1}`).fill('2')
  await page.locator('main').getByText('UPI', { exact: true }).click(); await shot(f, '3.3a-ticked')
  await button('Collect payment').click(); await settle(); await shot(f, '3.3b-collected')
  await page.getByLabel(`Select ${b2}`).check(); await page.locator('main').getByText('Patient advance', { exact: true }).click()
  await button('Collect payment').click(); await settle(); await shot(f, '3.4-from-advance')
  // the refund amount is whatever the row's Amount box says: a clerk must type it there first (finding)
  await page.getByLabel(`Amount for ${b1}`).fill('1')
  await page.getByRole('row', { name: new RegExp(b1) }).getByRole('button', { name: 'Refund' }).click(); await shot(f, '3.5a-refund-form')
  await field('Refund reason').fill('clerk check'); await button('Refund', dialog()).click(); await settle(); await shot(f, '3.5b-refunded')
  await page.getByRole('row', { name: new RegExp(b1) }).getByRole('button', { name: 'Bills' }).click(); await settle(); await shot(f, '3.6-bills')
})

await flow(4, 'receipt-entry', async (f) => {
  await go('/accounts/receipt-entry'); await shot(f, '4.1-empty')
  await findPatient('MRN', MRN); await shot(f, '4.2-found')
  await button('Save').click(); await shot(f, '4.5a-save-nothing-selected')
  await page.getByLabel('Select all unpaid').check(); await shot(f, '4.3-all-selected')
  await page.getByLabel('Receipt total (₹)').fill('1'); await page.getByLabel('Receipt total (₹)').blur(); await shot(f, '4.4-smaller-total')
  await button('Save').click(); await settle(); await shot(f, '4.5b-saved')
})

await flow(5, 'patient-bills', async (f) => {
  await go('/accounts/patient-bills'); await shot(f, '5.1a-empty')
  await findPatient('Name or phone', NAME); await shot(f, '5.1b-matches')
  await button('Choose').first().click(); await settle(); await shot(f, '5.2-statement')
  const b3 = bills[2].sales_number
  await page.getByRole('row', { name: new RegExp(b3) }).getByRole('button', { name: 'Write off' }).click(); await shot(f, '5.3a-write-off-form')
  await button('Send for approval', dialog()).click(); await shot(f, '5.3b-no-reason')
  await field('Write-off reason').fill('clerk check'); await button('Send for approval', dialog()).click(); await settle(); await shot(f, '5.3c-sent')
})

await flow(9, 'payment-approvals', async (f) => {
  // the write-off sent in flow 5: ask to approve (and back out), then reject it, which puts the bill back
  await go('/accounts/payment-approvals'); await shot(f, '9.1-list')
  const row = page.getByRole('row', { name: new RegExp(bills[2].sales_number) })
  await row.getByRole('button', { name: 'Approve' }).click(); await shot(f, '9.2a-approve-ask')
  await button('Not now', dialog()).click()
  const reject = async (r) => { await r.getByRole('button', { name: /^More actions/ }).click(); await page.getByRole('menuitem', { name: 'Reject' }).click() }
  await reject(row); await shot(f, '9.2b-reject-ask')
  await button('Reject', dialog()).click(); await settle(); await shot(f, '9.3-rejected')
  // write-offs this check sent on earlier runs are rejected too
  for (let left = page.getByRole('row').filter({ hasText: 'AKTEST Clerk' }).filter({ hasText: 'clerk check' }); await left.count();) {
    await reject(left.first()); await button('Reject', dialog()).click(); await settle()
  }
  await shot(f, '9.4-own-write-offs-cleared')
})

await flow(6, 'session-closing', async (f) => {
  const id = await sessionId()
  if (!id) throw new Error('no open session to close')
  await go(`/accounts/cashier-sessions/${id}`); await shot(f, '6.1-session')
  await button('New cash transfer').click(); await field('Amount (₹)').fill('1'); await field('Transfer reference').fill(`CHK-${RUN}`); await shot(f, '6.2a-transfer-form')
  await button('Save', dialog()).click(); await settle(); await shot(f, '6.2b-transfer-saved')
  await button('Confirm').first().click(); await shot(f, '6.2c-confirm-ask')
  if (await dialog().isVisible()) await button('Confirm', dialog()).click()
  await settle(); await shot(f, '6.2d-confirmed')
  await button('Close session').click(); await field('Notes of ₹10').fill('7'); await shot(f, '6.3a-close-form')
  await button('Close session', dialog()).click(); await settle(); await shot(f, '6.3b-variance')
  await page.getByLabel('Variance approval reason').fill('clerk check'); await button('Approve variance and close').click(); await settle(); await shot(f, '6.4-approved')
  await button('New adjustment').click(); await field('Amount (₹, + or −)').fill('1'); await field('Reason').fill('clerk check'); await shot(f, '6.5a-adjustment-form')
  await button('Save', dialog()).click(); await settle(); await shot(f, '6.5b-adjusted')
})

await flow(7, 'cash-register', async (f) => {
  await go('/accounts/cash-register'); await shot(f, '7.1-today')
  await page.getByRole('tab', { name: 'By day' }).click(); await shot(f, '7.2a-by-day')
  await page.getByRole('tab', { name: 'By user' }).click(); await shot(f, '7.2b-by-user')
})

await flow(8, 'payer-claims', async (f) => {
  await go('/accounts/payer-claims'); await shot(f, '8.1-open')
})

await browser.close()
mkdirSync(SHOTS, { recursive: true })
writeFileSync(`${SHOTS}notes-${RUN}.json`, JSON.stringify(notes, null, 1))
console.log(JSON.stringify(notes.filter((n) => n.failed || n.waitingWords || n.pageSideways || n.sentences?.length || n.notices?.length), null, 1))
