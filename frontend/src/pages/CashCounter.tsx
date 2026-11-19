/** Cash Counter: the unpaid bills, oldest first; tick bills to collect money on them (or take it from the patient's
 * advance), or refund one. Money moves, so the list and the postings are DocAssist's, used through it. */
import { Alert, Badge, Button, Checkbox, Group, NumberInput, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { contract } from '../api'
import { useWorkLocation } from '../session'
import {
  type Column, DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, Pager, RowActions, SaveButton, SidePanel,
} from '../ui'
import { words } from './PurchaseList'

interface Unpaid { sales_document_id: number; sales_number: string; document_date: string | null; patient_id: number | null; patient_name_snapshot: string | null;
  mrn: string | null; balance_amount_cents: number; visit_number: string | null; sales_type: string; billed_by_name: string | null; location_name: string | null }
const MODES = [['CASH', 'Cash'], ['UPI', 'UPI'], ['CREDIT_CARD', 'Credit card'], ['DEBIT_CARD', 'Debit card'], ['BANK_TRANSFER', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other'], ['ADVANCE', 'Patient advance']]
const TYPES: Record<string, string> = { SALE: 'Sale', QUICK_SALE: 'Quick sale' }

export function CashCounter() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { locationId } = useWorkLocation()
  // the location starts on the working location and follows it until one is picked here
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const location = picked === undefined ? locationId : picked
  const [filters, setFilters] = useState({ date_from: '', date_to: '', document_type: '' })
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  // per bill: ticked, and the amount typed (rupees); a tick and an amount survive a page change
  const [ticked, setTicked] = useState<Record<number, boolean>>({})
  const [amounts, setAmounts] = useState<Record<number, string>>({})
  const [mode, setMode] = useState('CASH')
  const [refunding, setRefunding] = useState<Unpaid | null>(null)
  const params = new URLSearchParams(Object.entries({ days: '365', q, ...filters, location_id: location ?? '' }).filter(([, v]) => v))
  const list = useQuery({ queryKey: ['cash-counter', params.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ rows: Unpaid[]; totals: { bills?: number; owed_cents?: number }; locations: { location_id: number; location_name: string }[] }>(`/pharmacy/api/accounts/cash-counter?${params}`) })
  const session = useQuery({ queryKey: ['cashier-session'], queryFn: () => contract<{ cashier_session?: unknown }>('/pharmacy/api/cashier-sessions/current') })
  const rows = list.data?.rows ?? []
  const amountOf = (r: Unpaid) => Math.round(Number(amounts[r.sales_document_id] ?? r.balance_amount_cents / 100) * 100)
  const chosen = rows.filter((r) => ticked[r.sales_document_id])
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['cash-counter'] }), queryClient.invalidateQueries({ queryKey: ['sales-history'] })])
  const setFilter = (name: keyof typeof filters, value: string | null) => { setFilters({ ...filters, [name]: value ?? '' }); setPage(1) }

  const collect = useMutation({
    mutationFn: () => contract<{ posted?: { sales_document_id: number; paid_now_cents: number; balance_amount_cents: number }[]; failed?: { sales_document_id: number; message?: string }[]; message?: string }>(
      '/pharmacy/api/accounts/cash-counter/collect', 'POST', {
        // the balance as this page shows it: a bill that moved meanwhile is refused, not paid twice
        bills: chosen.map((r) => ({ sales_document_id: r.sales_document_id, amount_cents: amountOf(r), expected_balance_cents: r.balance_amount_cents })),
        ...(mode === 'ADVANCE' ? { from_advance: true } : { payment_mode: mode }) }),
    onSuccess: (d) => {
      const name = (id: number) => rows.find((r) => r.sales_document_id === id)?.sales_number ?? `#${id}`
      const posted = d.posted ?? []
      if (posted.length) notifySuccess(`Collected ${money(posted.reduce((s, p) => s + p.paid_now_cents, 0))} on ${posted.length} bill${posted.length === 1 ? '' : 's'}.`)
      // a refused bill is named with its own reason
      for (const f of d.failed ?? []) notifyFailure(new Error(`${name(f.sales_document_id)}: ${f.message || 'Could not save. Try again.'}`))
      if (!posted.length && !(d.failed ?? []).length) notifyFailure(new Error(d.message || 'No payment was collected.'))
      setTicked({})
      setAmounts({})
      return refresh()
    },
    onError: notifyFailure,
  })

  const columns: Column<Unpaid>[] = [
    { header: 'Bill', cell: (r) => (
      <Group gap="sm" wrap="nowrap">
        <Checkbox aria-label={`Select ${r.sales_number}`} checked={Boolean(ticked[r.sales_document_id])} onChange={(e) => setTicked({ ...ticked, [r.sales_document_id]: e.currentTarget.checked })} />
        <Text size="sm" fw={500}>{r.sales_number}</Text>
      </Group>
    ) },
    { header: 'Date', cell: (r) => day(r.document_date?.slice(0, 10)) },
    { header: 'Patient', cell: (r) => <><Text size="sm">{r.patient_name_snapshot || 'Walk-in'}</Text><Text size="xs" c="dimmed">{r.mrn || '--'}</Text></> },
    { header: 'Visit', cell: (r) => r.visit_number || '--' },
    { header: 'Type', cell: (r) => TYPES[r.sales_type] ?? words(r.sales_type) },
    { header: 'Billed by', cell: (r) => r.billed_by_name || '--' },
    { header: 'Location', cell: (r) => r.location_name || '--' },
    { header: 'Balance due', align: 'right', cell: (r) => money(r.balance_amount_cents) },
    { header: 'Amount (₹)', align: 'right', cell: (r) => (
      <NumberInput aria-label={`Amount for ${r.sales_number}`} size="xs" w={110} min={0} decimalScale={2} hideControls
        value={amounts[r.sales_document_id] ?? (r.balance_amount_cents / 100).toFixed(2)} onChange={(v) => setAmounts({ ...amounts, [r.sales_document_id]: String(v) })} styles={{ input: { textAlign: 'right' } }} />
    ) },
    { header: 'Actions', align: 'right', cell: (r) => <RowActions name={r.sales_number} actions={[
      Boolean(r.patient_id || r.mrn) && { label: 'Bills', onClick: () => navigate(`/accounts/patient-bills?${new URLSearchParams(r.mrn ? { mrn: r.mrn } : { patient_id: String(r.patient_id) })}`) },
      { label: 'Refund', kind: 'danger', onClick: () => setRefunding(r) },
    ]} /> },
  ]

  return (
    <Page header={<>
      <PageHeader title="Cash counter" actions={session.data && !session.data.cashier_session && <>
        <Badge color="orange" variant="light" miw="max-content">No session open</Badge>
        <Button variant="default" component={Link} to="/accounts/cashier-sessions?new=1">Open session</Button>
      </>}>
        <Facts items={[{ label: 'Bills', value: list.data?.totals.bills ?? '--' }, { label: 'Balance due', value: money(list.data?.totals.owed_cents) }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <TextInput aria-label="Search" placeholder="Bill, patient, MRN or visit" leftSection={<IconSearch size={16} />} w={240} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput aria-label="From date" type="date" w={150} value={filters.date_from} onChange={(e) => setFilter('date_from', e.currentTarget.value)} />
          <TextInput aria-label="To date" type="date" w={150} value={filters.date_to} onChange={(e) => setFilter('date_to', e.currentTarget.value)} />
          <Select aria-label="Location" placeholder="All locations" w={190} clearable value={location || null} onChange={(v) => { setPicked(v); setPage(1) }}
            data={(list.data?.locations ?? []).map((l) => ({ value: String(l.location_id), label: l.location_name }))} />
          <Select aria-label="Document type" placeholder="All types" w={150} clearable value={filters.document_type || null} onChange={(v) => setFilter('document_type', v)}
            data={[{ value: 'SALE', label: 'Sale' }, { value: 'QUICK_SALE', label: 'Quick sale' }]} />
          <Button variant="default" onClick={() => { setFilters({ date_from: '', date_to: '', document_type: '' }); setSearch(''); setPicked(undefined); setPage(1) }}>Reset</Button>
        </Group>
        {chosen.length > 0 && (
          <Group mt="sm" align="end" wrap="wrap">
            <Facts items={[{ label: 'Selected', value: chosen.length }, { label: 'Amount', value: money(chosen.reduce((s, r) => s + amountOf(r), 0)) }]} />
            <SegmentedControl size="xs" value={mode} onChange={setMode} data={MODES.map(([value, label]) => ({ value, label }))} />
            <Button loading={collect.isPending} onClick={() => collect.mutate()}>Collect payment</Button>
          </Group>
        )}
      </FilterBar>
    </>}>
      <DataTable columns={columns} rows={rows.slice((page - 1) * size, page * size)} rowKey={(r) => r.sales_document_id} loading={list.isFetching} view={`${params}-${page}-${size}`}
        empty={<EmptyState title={list.isError ? list.error.message : 'No unpaid bills found.'} />}
        footer={<Pager page={page} pageSize={size} total={rows.length} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
      {refunding && <Refund bill={refunding} amount={amountOf(refunding)} onClose={() => setRefunding(null)} onDone={() => { setTicked({}); return refresh() }} />}
    </Page>
  )
}

/** Returning money on one bill to the patient, with the reason, by the chosen payment mode (never into the advance). */
function Refund({ bill, amount, onClose, onDone }: { bill: Unpaid; amount: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [mode, setMode] = useState('CASH')
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => contract<{ message?: string; refundable_cents?: number }>('/pharmacy/api/accounts/cash-counter/refund', 'POST', {
      sales_document_id: bill.sales_document_id, amount_cents: amount, payment_mode: mode, reason: reason.trim(), expected_balance_cents: bill.balance_amount_cents }),
    onSuccess: async (d) => {
      notifySuccess(`${bill.sales_number}: ${d.message || 'Refunded.'} ${Number(d.refundable_cents) ? `Still refundable ${money(d.refundable_cents)}.` : 'Nothing more to refund.'}`)
      await onDone()
      onClose()
    },
  })
  const problem = !reason.trim() ? 'Enter the refund reason.' : null
  return (
    <SidePanel title="Refund" subject={bill.sales_number} size={480} onClose={onClose}>
      <Stack>
        <Facts items={[{ label: 'Refund', value: money(amount) }, { label: 'Balance due', value: money(bill.balance_amount_cents) }]} />
        <Select label="Payment mode" allowDeselect={false} value={mode} onChange={(v) => setMode(v ?? 'CASH')}
          data={MODES.filter(([c]) => c !== 'ADVANCE').map(([value, label]) => ({ value, label }))} />
        <TextInput label="Refund reason" placeholder="Enter reason for refund" required value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end"><SaveButton problem={problem} variant="danger" loading={save.isPending} onClick={() => save.mutate()}>Refund</SaveButton></Group>
      </Stack>
    </SidePanel>
  )
}
