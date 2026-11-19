/** Pieces the sales screens share: reading a bill, printing it, and taking payment on it.
 * Payments move money, so they are saved through DocAssist. */
import { ActionIcon, Alert, Button, Checkbox, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { api, contract } from '../api'
import type { components } from '../api-types'
import { day, escapeHtml as esc, Facts, money, plain, printHtml, SidePanel } from '../ui'
import { words } from './PurchaseList'

export type Bill = components['schemas']['Bill']
export type PaymentMode = components['schemas']['PaymentMode']

export const useBill = (id: number | string | undefined) =>
  useQuery({ queryKey: ['bill', String(id)], queryFn: () => api<Bill>(`/api/sales/bills/${id}`), enabled: Boolean(id) })

export const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'

/** The printed slip of a bill. A quote is printed through DocAssist's estimate print first, so the print is logged like any other. */
export async function printBill(bill: Bill) {
  const estimate = bill.sales_type === 'ESTIMATE'
  if (estimate) await contract(`/pharmacy/api/estimates/${bill.sales_document_id}/print`, 'POST', {})
  const labels = Object.fromEntries(bill.payment_modes.map((m) => [m.code, m.label]))
  const field = (label: string) => bill.customer.find((c) => c.label === label)?.value
  const state = estimate ? (bill.status === 'CONFIRMED' ? 'Pending' : bill.status === 'DRAFT' ? 'Pending (draft)' : words(bill.status)) : words(bill.status)
  const address = ['Address', 'Village', 'District', 'State', 'Country', 'Pincode'].map(field).filter(Boolean).join(', ')
  const line = (left: string, right: string) => `<div class="line"><span>${left}</span><span>${right}</span></div>`
  const rows = bill.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.batch_number || '--')}${l.expiry_date ? ` exp ${esc(l.expiry_date)}` : ''}</td>` +
    `<td>${esc(l.hsn_code || '--')}${l.rack || l.bin ? ` ${esc([l.rack, l.bin].filter(Boolean).join('/'))}` : ''}</td><td class="num">${plain(l.quantity)}</td>` +
    [l.unit_mrp_cents, l.unit_price_cents, l.discount_amount_cents, l.tax_amount_cents, l.net_amount_cents].map((c) => `<td class="num">${money(c ?? 0)}</td>`).join('') + '</tr>').join('')
  printHtml(`${estimate ? 'Estimate' : 'Bill'} ${bill.sales_number ?? ''}`,
    `<h1>${estimate ? 'Estimate' : 'Pharmacy bill'} ${esc(bill.sales_number)}</h1>` +
    (estimate ? '<p>Estimate, not a tax invoice. Nothing is charged and no stock is issued until this estimate is converted to a bill.</p>' : '') +
    line(`${day(bill.document_date)}, ${estimate ? 'Estimate' : words(bill.sales_type)}, ${state}`, `${bill.visit_number ? `Visit ${esc(bill.visit_number)}, ` : ''}GST ${esc(field('GST number') || '--')}`) +
    line(`${esc(bill.patient_name || 'Walk-in')}, MRN ${esc(bill.mrn || '--')}, ${esc(field('Phone') || '--')}`, esc(field('Consultant') || '')) +
    line(esc(address || '--'), esc([bill.billed_by_name, field('Packed by')].filter(Boolean).join(' / '))) +
    '<table style="margin-top:8px"><thead><tr><th>Product</th><th>Batch</th><th>HSN</th><th class="num">Qty</th><th class="num">MRP</th><th class="num">Rate</th>' +
    `<th class="num">Discount</th><th class="num">GST</th><th class="num">Net</th></tr></thead><tbody>${rows}</tbody></table>` +
    line(`Gross ${money(bill.gross)}, Discount ${money(bill.discount)}, Tax ${money(bill.tax)}`, `Net ${money(bill.net)}, Rounded ${money(bill.rounded)}`) +
    (estimate
      ? line('Estimate only, no payment collected', 'Prices are confirmed when the estimate is billed')
      : line(`Paid ${money(bill.paid)} (${esc(labels[bill.primary_payment_mode ?? ''] || bill.primary_payment_mode || '--')})` +
          (bill.added_value > 0 ? `, Additional charge ${money(bill.added_value)}` : '') + (bill.payment_status ? `, ${words(bill.payment_status)}` : ''),
        `Balance ${money(bill.balance)}${bill.change > 0 ? `, Change ${money(bill.change)}` : ''}`) +
        bill.tenders.map((t) => line(esc(labels[t.payment_mode] || words(t.payment_mode)) + (t.transaction_reference ? `, ${esc(t.transaction_reference)}` : ''),
          money(t.amount_cents) + (t.return_amount_cents > 0 ? ` (change ${money(t.return_amount_cents)})` : ''))).join('')))
}

export interface PaymentPayload {
  tenders: { payment_mode: string; amount_cents: number; transaction_reference: string | null }[]
  added_value_cents: number
  authorized_by: number | null
  authorization_reason: string | null
  remarks: string | null
  print_bill: boolean
  print_op_label: boolean
}
interface Tender { key: number; mode: string; amount: string; reference: string }
let nextKey = 1
const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100)

/** Taking money on a bill: one or more tenders, an optional additional charge, and who authorised any balance left.
 * After a part payment the panel stays open for the rest; paid in full, it closes. */
export function PaymentPanel(props: {
  subject: string
  billCents: number
  balanceCents: number
  modes: PaymentMode[]
  devices: { bill: string | null; label: string | null }
  saveLabel: string
  /** withPrint: the "and print" button was pressed, so the slip is printed here too */
  onSave: (payload: PaymentPayload, withPrint: boolean) => Promise<{ balance_amount_cents?: number }>
  onClose: () => void
}) {
  const [base, setBase] = useState(props.balanceCents)
  const row = (amount: number, mode = props.modes[0]?.code ?? 'CASH'): Tender => ({ key: nextKey++, mode, amount: amount ? String(amount / 100) : '', reference: '' })
  const [tenders, setTenders] = useState<Tender[]>([row(props.balanceCents)])
  const [added, setAdded] = useState('')
  const [who, setWho] = useState('')
  const [reason, setReason] = useState('')
  const [remarks, setRemarks] = useState('')
  const [printBillToo, setPrintBill] = useState(false)
  const [printLabel, setPrintLabel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // a payment is still taken with no cashier session open; the panel only says so
  const session = useQuery({ queryKey: ['cashier-session'], queryFn: () => contract<{ cashier_session?: unknown }>('/pharmacy/api/cashier-sessions/current') })

  const payable = Math.max(base + Math.max(paise(added), 0), 0)
  const entered = tenders.reduce((sum, t) => sum + Math.max(paise(t.amount), 0), 0)
  const balance = Math.max(payable - entered, 0)
  const change = Math.max(entered - payable, 0)
  let running = 0
  const left = tenders.map((t) => { running = Math.min(running + Math.max(paise(t.amount), 0), payable); return payable - running })
  const set = (key: number, change: Partial<Tender>) => setTenders(tenders.map((t) => (t.key === key ? { ...t, ...change } : t)))

  async function save(withPrint: boolean) {
    setError(null)
    if (withPrint && !props.devices.bill) return setError('No bill printer is set up for this location. Save the payment, or print from the Sales Register.')
    if (entered <= 0) return setError('Enter an amount above zero in at least one row.')
    if (balance > 0 && !(who.trim() && reason.trim())) return setError(`This payment leaves a balance due of ${money(balance)}. Enter Authorized by and Authorization reason.`)
    setBusy(true)
    try {
      const reply = await props.onSave({
        tenders: tenders.filter((t) => paise(t.amount) > 0).map((t) => ({ payment_mode: t.mode, amount_cents: paise(t.amount), transaction_reference: t.reference.trim() || null })),
        added_value_cents: Math.max(paise(added), 0), authorized_by: who.trim() ? Number(who) : null, authorization_reason: reason.trim() || null,
        remarks: remarks.trim() || null, print_bill: printBillToo || withPrint, print_op_label: printLabel,
      }, withPrint)
      const still = Number(reply.balance_amount_cents ?? 0)
      if (still > 0) { // the panel keeps its place for the rest of the money
        setBase(still)
        setAdded('')
        setTenders([row(still, tenders[0]?.mode)])
      } else props.onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel title="Collect payment" subject={props.subject} size={900} onClose={props.onClose}>
      <Stack gap="md">
        {session.data && !session.data.cashier_session && (
          <Alert color="yellow">
            <Group justify="space-between">
              <Text size="sm" fw={600}>No session open</Text>
              <Button variant="default" size="xs" component={Link} to="/accounts/cashier-sessions?new=1">Open session</Button>
            </Group>
          </Alert>
        )}
        <Group gap="xl" align="flex-end" wrap="wrap">
          <Facts items={[{ label: 'Bill amount', value: money(props.billCents) }, { label: 'Bill payable', value: money(payable) },
            { label: 'Amount entered', value: money(entered) }, { label: 'Balance due', value: <Text span fw={700} c={balance > 0 ? 'red.8' : undefined}>{money(balance)}</Text> },
            ...(change > 0 ? [{ label: 'Change to return', value: money(change) }] : [])]} />
          <NumberInput label="Additional charge (₹)" w={180} min={0} decimalScale={2} hideControls value={added} onChange={(v) => setAdded(String(v))} />
        </Group>
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr><Table.Th>Payment mode</Table.Th><Table.Th w={140} ta="right">Amount (₹)</Table.Th><Table.Th>Reference no.</Table.Th><Table.Th w={120} ta="right">Balance due</Table.Th><Table.Th w={44} /></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tenders.map((t, i) => (
              <Table.Tr key={t.key}>
                <Table.Td>
                  <Select aria-label="Payment mode" size="xs" allowDeselect={false} value={t.mode} onChange={(mode) => mode && set(t.key, { mode })}
                    data={props.modes.map((m) => ({ value: m.code, label: m.configured ? `${m.label} (configured)` : m.label }))} />
                </Table.Td>
                <Table.Td>
                  <NumberInput aria-label="Amount" size="xs" min={0} decimalScale={2} hideControls value={t.amount} onChange={(v) => set(t.key, { amount: String(v) })} styles={{ input: { textAlign: 'right' } }} />
                </Table.Td>
                <Table.Td><TextInput aria-label="Reference no." size="xs" value={t.reference} onChange={(e) => set(t.key, { reference: e.currentTarget.value })} /></Table.Td>
                <Table.Td ta="right">{money(left[i])}</Table.Td>
                <Table.Td>
                  <ActionIcon variant="default" aria-label="Remove row" disabled={tenders.length === 1} onClick={() => setTenders(tenders.filter((o) => o.key !== t.key))}><IconTrash size={16} /></ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify="space-between">
          <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setTenders([...tenders, row(balance, tenders[0]?.mode)])}>Add row</Button>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label="Authorized by (user ID)" required={balance > 0} min={1} allowDecimal={false} hideControls value={who} onChange={(v) => setWho(String(v))} />
          <TextInput label="Authorization reason" required={balance > 0} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <TextInput label="Remarks" value={remarks} onChange={(e) => setRemarks(e.currentTarget.value)} />
        </SimpleGrid>
        <Group gap="lg">
          <Checkbox label="Print OP label" disabled={!props.devices.label} checked={printLabel && Boolean(props.devices.label)} onChange={(e) => setPrintLabel(e.currentTarget.checked)} />
          <Checkbox label="Print bill" disabled={!props.devices.bill} checked={printBillToo && Boolean(props.devices.bill)} onChange={(e) => setPrintBill(e.currentTarget.checked)} />
          <Text size="sm" c="dimmed">
            {props.devices.bill || props.devices.label
              ? [props.devices.bill && `Bill printer: ${props.devices.bill}`, props.devices.label && `OP label printer: ${props.devices.label}`].filter(Boolean).join(', ')
              : 'No bill or OP label printer is set up for this location.'}
          </Text>
        </Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
          <Button variant="default" loading={busy} onClick={() => save(true)}>{props.saveLabel} and print</Button>
          <Button loading={busy} onClick={() => save(false)}>{props.saveLabel}</Button>
        </Group>
      </Stack>
    </SidePanel>
  )
}

