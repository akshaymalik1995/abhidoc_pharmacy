/** New Sale: a bill at the counter, for a walk-in or a patient's visit, by hand or loaded from a prescription.
 * A sale moves stock and money, so it is saved through DocAssist; the product search and the batches are read here. */
import {
  ActionIcon, Alert, Box, Button, Collapse, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconFileImport, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api, contract } from '../api'
import type { components } from '../api-types'
import { useWorkLocation } from '../session'
import {
  day, Facts, money, notifyFailure, notifySuccess, Page, PageHeader, plain, SkeletonLines,
} from '../ui'
import { words } from './PurchaseList'
import { PrescriptionPanel, type LoadedPrescription } from './PrescriptionPanel'
import { PaymentPanel, printBill, type Bill } from './SaleShared'

type Product = components['schemas']['SaleProduct']
type Batch = components['schemas']['SaleBatch']
type Counter = components['schemas']['Counter']

export interface Line {
  key: number
  product: Product | null
  /** shown under the product, on one line: its stock, price and shelf, or the prescription it came from */
  facts: Fact[]
  batches: Batch[]
  batchId: string // '' = the batch with the earliest expiry
  packing: string
  hsn: string
  rack: string
  bin: string
  mrp: string
  quantity: string
  rate: string
  discount: string
  taxPercent: string
  prescriptionId: string | null
  prescriptionItemId: string | null
}
interface Visit { visit_type: string; visit_id?: number | null; admission_id?: number | null; visit_number?: string | null; visit_status?: string | null; doctor_id?: number | null }
interface Match extends Visit { patient_id?: number | null; mrn?: string | null; patient_name?: string | null; contact_number?: string | null; doctor_name?: string | null;
  visit_label?: string; state_code?: string; address?: string; country?: string; state?: string; district?: string; village?: string; pincode?: string }

let nextKey = 1
export const blankLine = (values: Partial<Line> = {}): Line => ({
  key: nextKey++, product: null, facts: [], batches: [], batchId: '', packing: '', hsn: '', rack: '', bin: '', mrp: '', quantity: '1',
  rate: '', discount: '0', taxPercent: '0', prescriptionId: null, prescriptionItemId: null, ...values,
})
const rupees = (cents: number | null | undefined) => (cents ? (cents / 100).toFixed(2) : '')
const paise = (value: string | number) => Math.round(Number(value || 0) * 100)
const today = () => new Date().toLocaleDateString('en-CA')
const MORE = [['doctor_name', 'Consultant'], ['referral_doctor', 'Referral doctor'], ['gst_number', 'GST number'], ['state_code', 'State code'],
  ['address', 'Address'], ['country', 'Country'], ['state', 'State'], ['district', 'District'], ['village', 'Village'], ['pincode', 'Pincode'],
  ['billed_by_name', 'Billed by'], ['packed_by_name', 'Packed by']] as const
const STATUS_CHOICES = { ESTIMATE: [['DRAFT', 'Draft'], ['CONFIRMED', 'Confirmed']], OTHER: [['DRAFT', 'Draft'], ['CONFIRMED', 'Confirmed'], ['PAID', 'Paid'], ['PENDING', 'Pending']] }
const START = {
  sales_type: 'SALE', status: 'DRAFT', document_date: today(), visit_type: 'WALK_IN', visit_query: '', patient_name: '', contact_number: '', mrn: '', patient_id: '',
  doctor_name: '', referral_doctor: '', gst_number: '', state_code: '', address: '', country: '', state: '', district: '', village: '', pincode: '',
  billed_by_name: '', packed_by_name: '', notes: '', primary_payment_mode: 'CASH', paid_amount: '',
}

/** What a row adds up to, in rupees: a discount never goes above the gross, and GST is on what is left. */
function lineTotals(line: Line) {
  const gross = Math.max(Number(line.quantity || 0) * Number(line.rate || 0), 0)
  const discount = Math.min(Math.max(Number(line.discount || 0), 0), gross)
  const gst = (gross - discount) * Number(line.taxPercent || 0) / 100
  return { gross, discount, gst, net: gross - discount + gst }
}

type Fact = { label: string; value: string }
const given = (facts: (Fact | false | null | undefined | '')[]) => facts.filter((f): f is Fact => Boolean(f && f.value))

/** What the picker says about a product before it is picked, as labelled facts; stock and price first. */
const productFacts = (p: Product): Fact[] => given([
  { label: 'Stock', value: plain(p.dispensable_stock) },
  { label: 'Price', value: p.selling_price_cents != null ? money(p.selling_price_cents) : 'none' },
  { label: 'Generic', value: p.generic_name ?? '' },
  { label: 'Category', value: p.product_category_code ?? '' },
  { label: 'Manufacturer', value: p.manufacturer_code ?? '' },
  !!p.last_purchase_unit_mrp_cents && { label: 'Last MRP', value: money(p.last_purchase_unit_mrp_cents) },
  { label: 'Last purchase', value: p.last_purchase_date ? day(p.last_purchase_date) : '' },
  { label: 'Shelf', value: p.storage_bin ?? '' },
  { label: 'HSN', value: p.hsn_code ?? '' },
  { label: 'Pack', value: p.last_purchase_packing ?? '' },
])

export function NewSale() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { locationId, locations } = useWorkLocation()
  const locationName = locations.find((l) => l.value === locationId)?.label
  const counter = useQuery({ queryKey: ['sales-counter', locationId], enabled: Boolean(locationId), queryFn: () => api<Counter>(`/api/sales/counter?location_id=${locationId}`) })
  const may = counter.data?.permissions
  const [form, setForm] = useState(START)
  const [lines, setLines] = useState<Line[]>([blankLine()])
  const [visit, setVisit] = useState<Visit | null>(null)
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [prescription, setPrescription] = useState<{ id: string; label: string } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [rxOpen, setRxOpen] = useState(false)
  const [paying, setPaying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const set = (name: keyof typeof START, value: string | null) => setForm((f) => ({ ...f, [name]: value ?? '' }))
  const setLine = (key: number, change: Partial<Line>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)))
  const estimate = form.sales_type === 'ESTIMATE'
  const statusChoices = STATUS_CHOICES[estimate ? 'ESTIMATE' : 'OTHER']

  const totals = lines.reduce((t, l) => {
    const one = lineTotals(l)
    return { items: t.items + (l.product ? 1 : 0), qty: t.qty + Number(l.quantity || 0), gross: t.gross + one.gross, discount: t.discount + one.discount, gst: t.gst + one.gst, net: t.net + one.net }
  }, { items: 0, qty: 0, gross: 0, discount: 0, gst: 0, net: 0 })
  const rounded = Math.round(totals.net)

  function reset() {
    setForm({ ...START, document_date: today() })
    setLines([blankLine()])
    setVisit(null)
    setMatches(null)
    setPrescription(null)
    setMoreOpen(false)
    setMessage(null)
  }

  async function pickProduct(key: number, product: Product | null) {
    if (!product) return setLine(key, { product: null, facts: [], batches: [] })
    const mrp = product.default_unit_mrp_cents || product.last_purchase_unit_mrp_cents
    setLine(key, {
      product, facts: productFacts(product).filter((f) => ['Stock', 'Price', 'Shelf'].includes(f.label)), taxPercent: product.tax_percent, rate: product.selling_price_cents != null ? rupees(product.selling_price_cents) || '0.00' : '0.00',
      packing: product.last_purchase_packing ?? '', hsn: product.hsn_code ?? '', mrp: rupees(mrp), batchId: '', prescriptionId: null, prescriptionItemId: null,
    })
    await loadBatches(key, product.item_id)
  }
  async function loadBatches(key: number, itemId: number) {
    try {
      const batches = await api<Batch[]>(`/api/sales/products/${itemId}/batches?location_id=${locationId}`)
      // the shelf shown is that of the batch a sale takes first until one is chosen
      setLine(key, { batches, rack: batches[0]?.rack_code ?? '', bin: batches[0]?.bin_code ?? '' })
    } catch { /* the earliest expiry stays the only choice */ }
  }
  function pickBatch(line: Line, batchId: string | null) {
    const batch = line.batches.find((b) => String(b.batch_id) === batchId) ?? line.batches[0]
    setLine(line.key, { batchId: batchId ?? '', rack: batch?.rack_code ?? '', bin: batch?.bin_code ?? '', ...(batchId && batch?.unit_mrp_cents ? { mrp: rupees(batch.unit_mrp_cents) } : {}) })
  }

  async function findVisit() {
    if (form.visit_type !== 'OP' && form.visit_type !== 'IP') return setMessage('Select visit type OP or IP to search a visit.')
    if (form.visit_query.trim().length < 2) return setMessage('Enter at least two characters of the visit no., MRN, name or phone.')
    setMessage(null)
    try {
      const reply = await api<{ matches?: Match[] }>(`/pharmacy/api/sales/visit-lookup?visit_type=${form.visit_type}&q=${encodeURIComponent(form.visit_query.trim())}`)
      setMatches(reply.matches ?? [])
    } catch (e) { setMessage((e as Error).message) }
  }
  function applyVisit(m: Match) {
    setVisit({ visit_type: m.visit_type, visit_id: m.visit_type === 'OP' ? m.visit_id : null, admission_id: m.visit_type === 'IP' ? m.admission_id : null,
      visit_number: m.visit_number, visit_status: m.visit_status, doctor_id: m.doctor_id ?? null })
    setForm((f) => ({ ...f, patient_id: String(m.patient_id ?? ''), mrn: m.mrn ?? '', patient_name: m.patient_name ?? '', contact_number: m.contact_number ?? '',
      doctor_name: m.doctor_name ?? '', state_code: m.state_code ?? '', address: m.address ?? '', country: m.country ?? '', state: m.state ?? '',
      district: m.district ?? '', village: m.village ?? '', pincode: m.pincode ?? '' }))
    if ([m.doctor_name, m.state_code, m.address, m.country, m.state, m.district, m.village, m.pincode].some(Boolean)) setMoreOpen(true)
    setMatches(null)
  }

  function applyPrescription(loaded: LoadedPrescription) {
    setRxOpen(false)
    const p = loaded.prescription
    const typedPatient = form.patient_name.trim()
    const typedVisit = visit ? String(visit.visit_id || visit.admission_id || '') : ''
    if (p.visit_type === 'OP' || p.visit_type === 'IP') set('visit_type', p.visit_type)
    if (p.visit_id || p.admission_id) applyVisit({ ...p, visit_type: p.visit_type ?? '' })
    else setForm((f) => ({ ...f, patient_id: String(p.patient_id ?? ''), mrn: p.mrn ?? '', patient_name: p.patient_name ?? '', contact_number: p.contact_number ?? '', doctor_name: p.doctor_name ?? '' }))
    // rows already loaded from this prescription are not loaded twice; empty rows give way
    const kept = lines.filter((l) => l.product)
    const onBill = new Set(kept.filter((l) => l.prescriptionId).map((l) => `${l.prescriptionId}/${l.prescriptionItemId}`))
    const already = loaded.lines.filter((l) => onBill.has(`${l.source_prescription_id}/${l.source_prescription_item_id}`))
    const adding = loaded.lines.filter((l) => !already.includes(l))
    const added = adding.map((l) => blankLine({
      product: { item_id: l.pharmacy_item_id, item_name: l.item_name, generic_name: l.generic_name ?? null, tax_percent: String(l.tax_percent ?? 0), unit_of_measure: null,
        hsn_code: l.hsn_code ?? null, product_category_code: null, manufacturer_code: null, dispensable_stock: String(l.available_quantity ?? 0),
        selling_price_cents: l.unit_price_cents ?? null, storage_bin: null, default_unit_mrp_cents: l.unit_mrp_cents ?? null, last_purchase_unit_mrp_cents: null,
        last_purchase_date: null, last_purchase_packing: l.packing ?? null },
      facts: given([{ label: 'Stock', value: plain(l.available_quantity) }, { label: 'Generic', value: l.generic_name ?? '' },
        { label: 'Prescription', value: String(l.prescription_number || l.source_prescription_id) }]),
      quantity: String(l.quantity || '1'), rate: rupees(l.unit_price_cents), mrp: rupees(l.unit_mrp_cents), taxPercent: String(l.tax_percent ?? 0),
      hsn: l.hsn_code ?? '', packing: l.packing ?? '', prescriptionId: String(l.source_prescription_id), prescriptionItemId: String(l.source_prescription_item_id),
    }))
    setLines(kept.length + added.length ? [...kept, ...added] : [blankLine()])
    added.forEach((l) => loadBatches(l.key, l.product!.item_id))
    const label = loaded.reference.prescription_number || `Rx #${loaded.reference.prescription_id}`
    setPrescription({ id: String(loaded.reference.prescription_id), label: `${label}, ${onBill.size + added.length} medicine(s)${p.patient_name ? `, ${p.patient_name}` : ''}` })
    let notLoaded = loaded.not_loaded_note ? ` ${loaded.not_loaded_note}` : ''
    if (already.length) {
      const names = `${already.map((l) => l.medication_name || l.item_name).join(', ')} (already on this bill)`
      notLoaded = notLoaded ? `${notLoaded.replace(/\.$/, '')}; ${names}.` : ` Not loaded: ${names}.`
    }
    const nowVisit = String(p.visit_id || p.admission_id || '')
    if ((typedPatient && typedPatient !== (p.patient_name || '')) || (typedVisit && typedVisit !== nowVisit)) notLoaded += ` The patient is now the prescription's: ${p.patient_name || '--'}.`
    const text = `${added.length} row(s) loaded from prescription ${label}.${notLoaded}`
    if (loaded.skipped?.length) notifyFailure(new Error(text))
    else notifySuccess(text)
  }

  /** The bill as DocAssist takes it; throws when a row has no product. */
  function payload() {
    if (!locationId) throw new Error('Choose the working location first.')
    if (lines.some((l) => !l.product)) throw new Error('Select a product for every row.')
    if (lines.some((l) => !(Number(l.quantity) > 0))) throw new Error('Enter a quantity above 0 on every row.')
    const blank = (value: string) => value.trim() || null
    return {
      location_id: locationId, sales_type: form.sales_type, status: form.status, document_date: form.document_date, visit_type: form.visit_type,
      visit_id: visit?.visit_id ?? null, admission_id: visit?.admission_id ?? null, visit_number: visit?.visit_number ?? null,
      visit_status_snapshot: visit?.visit_status ?? null, doctor_id: visit?.doctor_id ?? null, patient_id: form.patient_id || null,
      mrn: blank(form.mrn), patient_name: blank(form.patient_name), contact_number: blank(form.contact_number),
      ...Object.fromEntries(MORE.map(([name]) => [name, blank(form[name])])),
      primary_payment_mode: form.primary_payment_mode, paid_amount_cents: paise(form.paid_amount), rounded_amount_cents: paise(rounded),
      notes: blank(form.notes), prescription_reference_id: prescription?.id ?? null,
      items: lines.map((l) => ({
        pharmacy_item_id: l.product!.item_id, batch_id: l.batchId || null, quantity: l.quantity, unit_price_cents: paise(l.rate),
        discount_amount_cents: paise(l.discount), tax_percent: l.taxPercent || '0', packing: blank(l.packing), hsn_code: blank(l.hsn), rack: blank(l.rack),
        bin: blank(l.bin), unit_mrp_cents: paise(l.mrp), source_prescription_id: l.prescriptionId, source_prescription_item_id: l.prescriptionItemId,
      })),
    }
  }
  const done = async () => {
    await Promise.all(['sales-register', 'sales-history', 'overall-stock'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })))
    navigate(estimate ? '/sales/estimates' : '/sales/sales-register')
  }
  async function save(status?: string) {
    if (saving) return
    let body
    try { body = payload() } catch (e) { return setMessage((e as Error).message) }
    if (status) body.status = status
    setSaving(true)
    setMessage(null)
    try {
      const reply = await contract<{ sales_number: string; status_now?: string }>('/pharmacy/api/sales', 'POST', body)
      const held = body.status === 'PENDING' || body.status === 'DRAFT'
      notifySuccess(estimate ? `Estimate ${reply.sales_number} saved${held ? ' as draft' : ''}.` : `${reply.sales_number} saved as ${words(reply.status_now || body.status)}.`)
      await done()
    } catch (e) { setMessage((e as Error).message) } finally { setSaving(false) }
  }
  function openPayment() {
    try { payload() } catch (e) { return setMessage((e as Error).message) }
    setMessage(null)
    setPaying(true)
  }

  const columns = ['Product', 'Batch', 'Packing', 'HSN', 'Rack / bin', 'MRP', 'Qty', 'Rate', 'Discount', 'GST %', 'GST (₹)', 'Net', '']
  const box = (line: Line, name: 'mrp' | 'quantity' | 'rate' | 'discount', label: string, scale = 2) => (
    <NumberInput aria-label={label} size="xs" min={0} decimalScale={scale} hideControls value={line[name]} onChange={(v) => setLine(line.key, { [name]: String(v) })} styles={{ input: { textAlign: 'right' } }} />
  )

  return (
    <Page header={
      <PageHeader title="New sale" actions={<Button variant="default" leftSection={<IconFileImport size={16} />} onClick={() => setRxOpen(true)}>Load prescription</Button>}>
        <Facts items={[{ label: 'Location', value: locationName ?? '--' }, ...(prescription ? [{ label: 'Prescription', value: prescription.label }] : [])]} />
      </PageHeader>
    }>
      <Stack gap="md">
        <Paper withBorder p="md">
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 2, sm: 4, lg: 8 }}>
              <Select label="Type" allowDeselect={false} value={form.sales_type} onChange={(v) => {
                const isEstimate = v === 'ESTIMATE'
                setForm((f) => ({ ...f, sales_type: v ?? 'SALE', status: STATUS_CHOICES[isEstimate ? 'ESTIMATE' : 'OTHER'].some(([c]) => c === f.status) ? f.status : 'DRAFT' }))
              }} data={[{ value: 'SALE', label: 'Sale' }, { value: 'QUICK_SALE', label: 'Quick sale' }, { value: 'ESTIMATE', label: 'Estimate' }, { value: 'PENDING_SALE', label: 'Pending sale' }]} />
              <Select label="Status" allowDeselect={false} value={form.status} onChange={(v) => set('status', v)} data={statusChoices.map(([value, label]) => ({ value, label }))} />
              <TextInput label="Date" type="date" value={form.document_date} onChange={(e) => set('document_date', e.currentTarget.value)} />
              <Select label="Visit type" allowDeselect={false} value={form.visit_type} onChange={(v) => { set('visit_type', v); setVisit(null); setMatches(null) }}
                data={[{ value: 'WALK_IN', label: 'Walk-in' }, { value: 'OP', label: 'OP' }, { value: 'IP', label: 'IP' }, { value: 'RETAIL', label: 'Retail' }, { value: 'OTHER', label: 'Other' }]} />
              <TextInput label="Patient name" value={form.patient_name} onChange={(e) => set('patient_name', e.currentTarget.value)} />
              <TextInput label="Phone" value={form.contact_number} onChange={(e) => set('contact_number', e.currentTarget.value)} />
              <TextInput label="MRN" value={form.mrn} onChange={(e) => set('mrn', e.currentTarget.value)} />
              <TextInput label="Patient ID" value={form.patient_id} onChange={(e) => set('patient_id', e.currentTarget.value)} />
            </SimpleGrid>
            {(form.visit_type === 'OP' || form.visit_type === 'IP') && (
              <Group align="end">
                <TextInput label={`${form.visit_type} visit`} placeholder="Visit no., MRN, name or phone" value={form.visit_query} style={{ flex: 1 }} maw={420}
                  onChange={(e) => set('visit_query', e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findVisit() } }} />
                <Button variant="default" leftSection={<IconSearch size={16} />} onClick={findVisit}>Search</Button>
                <Facts items={visit ? [{ label: visit.visit_type === 'IP' ? 'Admission' : 'Visit', value: visit.visit_number ?? '--' }, { label: 'Status', value: visit.visit_status ?? '--' }]
                  : [{ label: 'Visit', value: 'Walk-in' }]} />
              </Group>
            )}
            {matches && (
              <Stack gap={4}>
                {!matches.length && <Text size="sm">No {form.visit_type} visits found.</Text>}
                {matches.map((m, i) => (
                  <Button key={i} variant="default" justify="start" h="auto" py={6} onClick={() => applyVisit(m)}>
                    <Box ta="left"><Text size="sm" fw={600}>{m.patient_name || `Patient ${m.patient_id}`}, {m.visit_number}</Text>
                      <Text size="xs">{[m.mrn, m.contact_number, m.visit_label, m.doctor_name].filter(Boolean).join(', ')}</Text></Box>
                  </Button>
                ))}
              </Stack>
            )}
            <Group><Button variant="default" size="xs" onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? 'Fewer details' : 'More details'}</Button></Group>
            <Collapse expanded={moreOpen}>
              <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }}>
                {MORE.map(([name, label]) => <TextInput key={name} label={label} value={form[name]} onChange={(e) => set(name, e.currentTarget.value)} />)}
              </SimpleGrid>
            </Collapse>
          </Stack>
        </Paper>

        <Paper withBorder style={{ overflowX: 'auto' }}>
          <Table highlightOnHover={false} miw={1120}>
            <Table.Thead bg="gray.0"><Table.Tr>{columns.map((c, i) => <Table.Th key={i} ta={i >= 5 && i <= 11 ? 'right' : undefined}>{c}</Table.Th>)}</Table.Tr></Table.Thead>
            <Table.Tbody>
              {lines.map((line) => {
                const t = lineTotals(line)
                return (
                  <Table.Tr key={line.key} style={{ verticalAlign: 'top' }}>
                    <Table.Td miw={260}>
                      <SaleProductPicker locationId={locationId} value={line.product} onChange={(p) => pickProduct(line.key, p)} />
                      {line.facts.length > 0 && <Box mt={2} maw={320}><Facts compact items={line.facts} /></Box>}
                    </Table.Td>
                    <Table.Td w={190}>
                      <Select aria-label="Batch" size="xs" allowDeselect={false} value={line.batchId} onChange={(v) => pickBatch(line, v)}
                        data={[{ value: '', label: 'Earliest expiry' }, ...line.batches.map((b) => ({ value: String(b.batch_id),
                          label: `${b.batch_number || `Batch ${b.batch_id}`}, ${plain(b.quantity_on_hand)} in stock${b.expiry_date ? `, expiry ${day(b.expiry_date)}` : ''}` }))]} />
                    </Table.Td>
                    <Table.Td w={90}><TextInput aria-label="Packing" size="xs" placeholder="Pack" value={line.packing} onChange={(e) => setLine(line.key, { packing: e.currentTarget.value })} /></Table.Td>
                    <Table.Td w={90}><TextInput aria-label="HSN" size="xs" placeholder="HSN" value={line.hsn} onChange={(e) => setLine(line.key, { hsn: e.currentTarget.value })} /></Table.Td>
                    <Table.Td w={140}>
                      <Group gap={4} wrap="nowrap">
                        <TextInput aria-label="Rack" size="xs" placeholder="Rack" value={line.rack} onChange={(e) => setLine(line.key, { rack: e.currentTarget.value })} />
                        <TextInput aria-label="Bin" size="xs" placeholder="Bin" value={line.bin} onChange={(e) => setLine(line.key, { bin: e.currentTarget.value })} />
                      </Group>
                    </Table.Td>
                    <Table.Td w={90}>{box(line, 'mrp', 'MRP')}</Table.Td>
                    <Table.Td w={80}>{box(line, 'quantity', 'Quantity', 3)}</Table.Td>
                    <Table.Td w={90}>{box(line, 'rate', 'Rate')}</Table.Td>
                    <Table.Td w={90}>{box(line, 'discount', 'Discount')}</Table.Td>
                    <Table.Td w={60} ta="right">{plain(line.taxPercent)}</Table.Td>
                    <Table.Td w={80} ta="right">{money(Math.round(t.gst * 100))}</Table.Td>
                    <Table.Td w={90} ta="right" fw={600}>{money(Math.round(t.net * 100))}</Table.Td>
                    <Table.Td w={44}>
                      <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1} onClick={() => setLines(lines.filter((l) => l.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Paper>

        <Group align="start" justify="space-between" wrap="wrap">
          <Stack gap="sm" style={{ flex: 1 }} miw={280} maw={520}>
            <Group><Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, blankLine()])}>Add row</Button></Group>
            <TextInput label="Remarks" value={form.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
          </Stack>
          <Stack gap="sm" align="end">
            <Group align="end">
              <Select label="Payment mode" w={170} allowDeselect={false} value={form.primary_payment_mode} onChange={(v) => set('primary_payment_mode', v)}
                data={[['CASH', 'Cash'], ['UPI', 'UPI'], ['CREDIT_CARD', 'Credit card'], ['DEBIT_CARD', 'Debit card'], ['BANK_TRANSFER', 'Bank transfer'], ['CREDIT', 'Credit'], ['OTHER', 'Other']].map(([value, label]) => ({ value, label }))} />
              <NumberInput label="Paid amount (₹)" placeholder="0.00" w={150} min={0} decimalScale={2} hideControls value={form.paid_amount} onChange={(v) => set('paid_amount', String(v))} />
            </Group>
            <Facts items={[{ label: 'Products', value: totals.items }, { label: 'Qty', value: plain(totals.qty) }, { label: 'Gross', value: money(Math.round(totals.gross * 100)) },
              { label: 'Discount', value: money(Math.round(totals.discount * 100)) }, { label: 'GST', value: money(Math.round(totals.gst * 100)) },
              { label: 'Net', value: money(Math.round(totals.net * 100)) }, { label: 'Round off', value: money(Math.round((rounded - totals.net) * 100)) },
              { label: 'Rounded', value: <Text span fw={700}>{money(rounded * 100)}</Text> }]} />
          </Stack>
        </Group>

        {message && <Alert color="red">{message}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-3)', zIndex: 2 }}>
          <Button variant="default" onClick={reset}>Reset</Button>
          <Button variant="default" disabled={estimate} title={estimate ? 'An estimate is saved as Draft or Confirmed.' : undefined} loading={saving} onClick={() => save('PENDING')}>Save as pending</Button>
          <Button variant="default" disabled={estimate || may?.create === false} title={estimate ? 'An estimate takes no payment. Convert it to a bill first.' : undefined}
            onClick={openPayment}>Save and collect payment</Button>
          <Button loading={saving} onClick={() => save()}>Save</Button>
        </Group>
      </Stack>
      {rxOpen && <PrescriptionPanel holding={prescription} onClose={() => setRxOpen(false)} onLoaded={applyPrescription} />}
      {paying && counter.data && (
        <PaymentPanel
          subject="New bill" billCents={rounded * 100} balanceCents={rounded * 100} modes={counter.data.payment_modes} devices={counter.data.print_devices}
          saveLabel="Save and collect payment" onClose={() => setPaying(false)}
          onSave={async (pay, withPrint) => {
            // the payment is taken before the bill posts: the bill is saved confirmed with its tenders
            const reply = await contract<{ sales_document_id: number; sales_number: string; status_now?: string; balance_amount_cents?: number }>(
              '/pharmacy/api/sales', 'POST', { ...payload(), status: 'CONFIRMED', paid_amount_cents: 0, ...pay })
            notifySuccess(`${reply.sales_number} saved as ${words(reply.status_now || 'CONFIRMED')}${Number(reply.balance_amount_cents) > 0 ? `, balance due ${money(reply.balance_amount_cents)}` : ''}.`)
            if (withPrint) await printBill(await api<Bill>(`/api/sales/bills/${reply.sales_document_id}`)).catch(notifyFailure)
            await done()
            return { balance_amount_cents: 0 }
          }}
        />
      )}
    </Page>
  )
}

/** Finds a product to sell by typing part of its name; each choice shows its stock, price and shelf at the working location. */
function SaleProductPicker(props: { locationId: string | null; value: Product | null; onChange: (product: Product | null) => void }) {
  const [typed, setTyped] = useState('')
  const [q] = useDebouncedValue(typed.trim(), 250)
  const search = useQuery({
    queryKey: ['sale-products', props.locationId, q], enabled: Boolean(props.locationId),
    queryFn: () => api<Product[]>(`/api/sales/products?location_id=${props.locationId}&q=${encodeURIComponent(q)}`),
  })
  const found = search.data ?? []
  const products = props.value && !found.some((p) => p.item_id === props.value?.item_id) ? [props.value, ...found] : found
  return (
    <Select
      aria-label="Product" placeholder="Search product" size="xs" searchable searchValue={typed} onSearchChange={setTyped} filter={({ options }) => options}
      data={products.map((p) => ({ value: String(p.item_id), label: p.item_name }))}
      value={props.value ? String(props.value.item_id) : null}
      onChange={(id) => props.onChange(products.find((p) => String(p.item_id) === id) ?? null)}
      renderOption={({ option }) => {
        const p = products.find((x) => String(x.item_id) === option.value)
        if (!p) return <Text size="sm">{option.label}</Text>
        // one line a choice: stock, price, generic and GST; every other fact on pointing at the choice
        const all = [...productFacts(p), { label: 'GST', value: `${plain(p.tax_percent)}%` }]
        return (
          <Box py={2} title={all.map((f) => `${f.label}: ${f.value}`).join('\n')}>
            <Text size="sm" fw={500}>{option.label}</Text>
            <Facts compact items={all.filter((f) => ['Stock', 'Price', 'Generic', 'GST'].includes(f.label))} />
          </Box>
        )
      }}
      nothingFoundMessage={search.isFetching ? <SkeletonLines /> : 'No products found.'}
      comboboxProps={{ width: 420, position: 'bottom-start' }}
    />
  )
}
