/** Receipt Entry: one receipt from a patient set against their unpaid bills, the oldest first. Money moves, so the bills
 * and the receipt are DocAssist's, used through it. */
import { Alert, Checkbox, Group, NumberInput, Paper, SegmentedControl, Stack, Table, Text, TextInput } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'

import { contract } from '../api'
import {
  day, EmptyState, Facts, money, notifyFailure, notifySuccess, Page, PageHeader, SaveButton, SkeletonLines, StatusBadge,
} from '../ui'
import { PatientFinder, PatientLinks, usePatientAddress, type Lookup } from './PatientFinder'
import { words } from './PurchaseList'

const API = '/pharmacy/api/accounts/receipts'
interface ReceiptBill { sales_document_id: number; sales_number: string; sales_type: string; status: string; document_date: string; visit_number: string | null;
  net_amount_cents: number; paid_amount_cents: number; balance_amount_cents: number; selectable: boolean }
interface Group_ { label: string; bill_count: number; outstanding_cents: number; bills: ReceiptBill[] }
interface Workspace { ok: boolean; message?: string; matched_by?: string; patient: { patient_id: number | null; name: string | null; mrn: string | null; phone: string | null }
  totals: { bill_count?: number; selectable_bill_count?: number; outstanding_cents?: number }; current_visit: Group_ | null; previous_visits: Group_[] }
const MODES = [['CASH', 'Cash'], ['UPI', 'UPI'], ['CREDIT_CARD', 'Credit card'], ['DEBIT_CARD', 'Debit card'], ['BANK_TRANSFER', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']]
const oldestFirst = (a: ReceiptBill, b: ReceiptBill) => (a.document_date !== b.document_date ? (a.document_date < b.document_date ? -1 : 1) : a.sales_document_id - b.sales_document_id)

export function ReceiptEntry() {
  const queryClient = useQueryClient()
  // the patient in the address; a receipt finds the bills by visit no. or MRN
  const [lookup, setLookup] = usePatientAddress()
  const q = lookup?.visit_number ?? lookup?.mrn ?? ''
  const ws = useQuery({ queryKey: ['receipt-workspace', q], enabled: Boolean(q), queryFn: () => contract<Workspace>(`${API}/workspace?q=${encodeURIComponent(q)}`) })
  const data = ws.data
  const bills = data ? [...(data.current_visit?.bills ?? []), ...data.previous_visits.flatMap((g) => g.bills)] : []
  // per ticked bill, the amount set against it (paise)
  const [lines, setLines] = useState<Record<number, number>>({})
  const [total, setTotal] = useState<string>('') // the receipt total the cashier typed; empty when the screen fills it
  const [mode, setMode] = useState('CASH')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const picked = bills.filter((b) => lines[b.sales_document_id] !== undefined)
  const sum = picked.reduce((s, b) => s + (lines[b.sales_document_id] || 0), 0)

  /** The entered total fills the oldest ticked bill first and stops at each balance. */
  function spread(totalCents: number, ticked: ReceiptBill[]) {
    let left = Math.max(totalCents, 0)
    const next: Record<number, number> = {}
    for (const b of [...ticked].sort(oldestFirst)) { const take = Math.min(left, b.balance_amount_cents); next[b.sales_document_id] = take; left -= take }
    setLines(next)
  }
  function tick(b: ReceiptBill, on: boolean) {
    const ticked = on ? [...picked, b] : picked.filter((p) => p.sales_document_id !== b.sales_document_id)
    if (total) return spread(Math.round(Number(total) * 100), ticked)
    // a tick adds the bill's balance; an untick takes it off
    const next = { ...lines }
    if (on) next[b.sales_document_id] = b.balance_amount_cents
    else delete next[b.sales_document_id]
    setLines(next)
  }
  function selectAll() {
    const unpaid = bills.filter((b) => b.selectable)
    spread(total ? Math.round(Number(total) * 100) : unpaid.reduce((s, b) => s + b.balance_amount_cents, 0), unpaid)
  }
  function choose(next: Lookup) {
    setLookup(next)
    setLines({})
    setTotal('')
  }

  const post = useMutation({
    mutationFn: () => {
      const billLines = picked.map((b) => ({ sales_document_id: b.sales_document_id, amount_cents: lines[b.sales_document_id] || 0 })).filter((l) => l.amount_cents > 0)
      return contract<{ receipt?: { account_number?: string }; totals?: { allocated_cents?: number; bill_count?: number }; allocations?: { sales_number: string; allocated_amount_cents: number; balance_after_cents: number }[] }>(API, 'POST', {
        bills: billLines, amount_cents: billLines.reduce((s, l) => s + l.amount_cents, 0), payment_mode: mode, reference_number: reference.trim(), notes: notes.trim(),
        patient_id: data?.patient.patient_id ?? null, mrn: data?.patient.mrn ?? null })
    },
    onSuccess: (d) => {
      const n = Number(d.totals?.bill_count ?? 0)
      notifySuccess(`Receipt ${d.receipt?.account_number ?? ''}: ${money(d.totals?.allocated_cents)} across ${n} bill${n === 1 ? '' : 's'}. ` +
        (d.allocations ?? []).map((l) => `${l.sales_number} ${money(l.allocated_amount_cents)} (${l.balance_after_cents ? `balance due ${money(l.balance_after_cents)}` : 'paid in full'})`).join(', '))
      setLines({}); setTotal(''); setReference(''); setNotes('')
      return Promise.all([queryClient.invalidateQueries({ queryKey: ['receipt-workspace'] }), queryClient.invalidateQueries({ queryKey: ['cash-counter'] })])
    },
    onError: notifyFailure,
  })
  const unpaid = bills.filter((b) => b.selectable)
  const groupRows = (label: string, g: Group_ | null) => g && g.bills.length ? (
    <Fragment key={label + g.label}>
      <Table.Tr bg="gray.0"><Table.Td colSpan={10}><Text size="sm"><b>{label}</b> {g.label}, {g.bill_count} bill{Number(g.bill_count) === 1 ? '' : 's'}, {money(g.outstanding_cents)} balance due</Text></Table.Td></Table.Tr>
      {g.bills.map((b) => (
        <Table.Tr key={b.sales_document_id}>
          <Table.Td><Checkbox aria-label={`Select ${b.sales_number}`} disabled={!b.selectable} checked={lines[b.sales_document_id] !== undefined} onChange={(e) => tick(b, e.currentTarget.checked)} /></Table.Td>
          <Table.Td><Text size="sm" fw={500}>{b.sales_number}</Text></Table.Td>
          <Table.Td>{words(b.sales_type)}</Table.Td>
          <Table.Td><StatusBadge status={words(b.status)} /></Table.Td>
          <Table.Td>{day(b.document_date?.slice(0, 10))}</Table.Td>
          <Table.Td>{b.visit_number || '--'}</Table.Td>
          <Table.Td ta="right">{money(b.net_amount_cents)}</Table.Td>
          <Table.Td ta="right">{money(b.paid_amount_cents)}</Table.Td>
          <Table.Td ta="right" fw={700}>{money(b.balance_amount_cents)}</Table.Td>
          <Table.Td w={130}>{b.selectable
            ? <NumberInput aria-label={`Amount for ${b.sales_number}`} size="xs" min={0} decimalScale={2} hideControls value={((lines[b.sales_document_id] || 0) / 100).toFixed(2)}
              onChange={(v) => { setTotal(''); setLines({ ...lines, [b.sales_document_id]: Math.round(Number(v || 0) * 100) }) }} styles={{ input: { textAlign: 'right' } }} />
            : <Text size="sm" c="dimmed">Paid</Text>}</Table.Td>
        </Table.Tr>
      ))}
    </Fragment>
  ) : null

  return (
    <Page header={
      <PageHeader title="Receipt entry" actions={<PatientLinks lookup={lookup} here="receipt" />}>
        {data?.ok && <Facts items={[{ label: 'Patient', value: data.patient.name || '--' }, { label: 'MRN', value: data.patient.mrn || 'No MRN' }, ...(data.patient.phone ? [{ label: 'Phone', value: data.patient.phone }] : []),
          { label: 'Matched by', value: data.matched_by === 'VISIT_NUMBER' ? 'visit no.' : 'MRN' }, { label: 'Bills', value: data.totals.bill_count ?? 0 },
          { label: 'Unpaid', value: data.totals.selectable_bill_count ?? 0 }, { label: 'Balance due', value: money(data.totals.outstanding_cents) }]} />}
      </PageHeader>
    }>
      <Stack gap="md">
        <PatientFinder onPick={choose} />
        {lookup && !q && <Alert color="yellow">No visit no. or MRN for this patient.</Alert>}
        {ws.isFetching && !data && <SkeletonLines count={6} />}
        {(ws.isError || data?.ok === false) && <Alert color="yellow">{ws.error?.message || data?.message}</Alert>}
        {data?.ok && !bills.length && <Text size="sm">No bills found.</Text>}
        {data?.ok && bills.length > 0 && (
          <>
            <Paper withBorder style={{ overflowX: 'auto' }}>
              <Table highlightOnHover={false}>
                <Table.Thead bg="gray.0"><Table.Tr>
                  <Table.Th w={40}><Checkbox aria-label="Select all unpaid" disabled={!unpaid.length} checked={unpaid.length > 0 && unpaid.every((b) => lines[b.sales_document_id] !== undefined)}
                    onChange={(e) => (e.currentTarget.checked ? selectAll() : setLines({}))} /></Table.Th>
                  {['Bill', 'Type', 'Status', 'Date', 'Visit', 'Bill amount', 'Paid', 'Balance', 'Amount (₹)'].map((h, i) => <Table.Th key={h} ta={i >= 5 ? 'right' : undefined}>{h}</Table.Th>)}
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {groupRows('Current visit', data.current_visit)}
                  {data.previous_visits.map((g) => groupRows('Previous visit', g))}
                </Table.Tbody>
              </Table>
            </Paper>
            <Group align="end" wrap="wrap">
              <Stack gap={4}><Text size="sm" fw={500}>Payment mode</Text><SegmentedControl value={mode} onChange={setMode} data={MODES.map(([value, label]) => ({ value, label }))} /></Stack>
              <TextInput label="Reference no." placeholder="Enter reference no." w={200} value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
              <TextInput label="Remarks" placeholder="Enter remarks (optional)" style={{ flex: 1 }} miw={180} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
              <NumberInput label="Receipt total (₹)" placeholder="0.00" w={160} min={0} decimalScale={2} hideControls value={total || (sum ? (sum / 100).toFixed(2) : '')}
                onChange={(v) => { setTotal(String(v)); spread(Math.round(Number(v || 0) * 100), picked.length ? picked : unpaid) }} />
            </Group>
            <Group justify="flex-end">
              <SaveButton problem={sum > 0 ? null : 'Select an unpaid bill and enter the amount.'} loading={post.isPending} onClick={() => post.mutate()}>Save</SaveButton>
            </Group>
          </>
        )}
        {!lookup && <EmptyState title="Find the patient by visit number or MRN." />}
      </Stack>
    </Page>
  )
}
