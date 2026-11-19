/** Accounts lists that only show money owed and paid: Supplier Outstanding, Payment History, the Purchase Register and the Cash Register.
 * The figures are DocAssist's own (its accounts ledger), read through it. */
import { Anchor, Button, Checkbox, Group, NumberInput, Select, Stack, Tabs, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, contract } from '../api'
import type { components } from '../api-types'
import { DataTable, day, EmptyState, Facts, FilterBar, money, Page, PageHeader, Pager, SidePanel, StatusBadge, type Column } from '../ui'
import { words } from './PurchaseList'

type Choice = components['schemas']['Choice']

interface OutstandingRow { account_document_id: number; party_type: string; supplier_id: number | null; patient_name: string | null; account_number: string | null;
  document_date: string | null; account_type: string; reference_number: string | null; net_amount_cents: number; allocated_amount_cents: number;
  unallocated_amount_cents: number; status: string }

export function SupplierOutstanding() {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const docs = useQuery({ queryKey: ['accounts-workspace'], queryFn: () => contract<{ rows: OutstandingRow[] }>('/pharmacy/api/accounts/workspace') })
  // the amount payable is the purchase side's own figure, not the account documents'; it also names the suppliers
  const owed = useQuery({ queryKey: ['supplier-outstanding'], queryFn: () => contract<{ suppliers: { supplier_id: number; supplier_name: string; outstanding_cents: number }[] }>('/pharmacy/api/accounts/supplier-outstanding') })
  const names = Object.fromEntries((owed.data?.suppliers ?? []).map((s) => [s.supplier_id, s.supplier_name]))
  const payable = (owed.data?.suppliers ?? []).reduce((sum, s) => sum + Number(s.outstanding_cents || 0), 0)
  const rows = docs.data?.rows ?? []
  const columns: Column<OutstandingRow>[] = [
    { header: 'Party', cell: (r) => <Text size="sm" fw={500}>{(r.party_type === 'SUPPLIER' ? names[r.supplier_id ?? 0] : r.patient_name) || '--'}</Text> },
    { header: 'Kind', cell: (r) => (r.party_type === 'SUPPLIER' ? 'Supplier' : 'Patient') },
    { header: 'Document no.', cell: (r) => r.account_number || '--' },
    { header: 'Date', cell: (r) => day(r.document_date?.slice(0, 10)) },
    { header: 'Particulars', cell: (r) => words(r.account_type) },
    { header: 'Reference', cell: (r) => r.reference_number || '--' },
    { header: 'Amount', align: 'right', cell: (r) => money(r.net_amount_cents) },
    { header: 'Adjusted', align: 'right', cell: (r) => money(r.allocated_amount_cents) },
    { header: 'Balance', align: 'right', cell: (r) => money(r.unallocated_amount_cents) },
    { header: 'Status', cell: (r) => <StatusBadge status={words(r.status)} /> },
  ]
  return (
    <Page header={<PageHeader title="Supplier outstanding"><Facts items={[{ label: 'Documents', value: rows.length }, { label: 'Supplier payable', value: owed.data ? money(payable) : '--' }]} /></PageHeader>}>
      <DataTable columns={columns} rows={rows.slice((page - 1) * size, page * size)} rowKey={(r) => r.account_document_id} loading={docs.isFetching} view={`${page}-${size}`}
        empty={<EmptyState title={docs.isError ? 'Could not load the documents.' : 'No outstanding documents found.'} hint={docs.error?.message} />}
        footer={<Pager page={page} pageSize={size} total={rows.length} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
    </Page>
  )
}

interface Payment { account_document_id: number; account_number: string; created_at: string | null; supplier_id: number; supplier_name: string | null;
  created_by_name: string | null; approved_by_name: string | null; net_amount_cents: number; status: string
  allocations?: { purchase_document_id: number; reference_number: string | null; allocated_amount_cents: number; document_amount_cents: number; line_status: string | null }[] }
const PAYMENT_STATUSES = [['PAID', 'Paid'], ['PENDING_APPROVAL', 'Pending approval'], ['DEFERRED', 'Deferred'], ['CANCELLED', 'Cancelled'], ['ALL', 'All statuses']]

export function PaymentHistory() {
  // the Purchase Register opens this screen on one supplier's payments with one payment marked
  const [address] = useSearchParams()
  const [filters, setFilters] = useState<Record<string, string>>({ status: address.get('status') || 'PAID', supplier_id: address.get('supplier_id') || '', date_from: '', date_to: '', amount_min: '', amount_max: '' })
  const mark = address.get('mark')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const [open, setOpen] = useState<Payment | null>(null)
  const chosen = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
  const query = new URLSearchParams([...chosen, ['limit', String(size)], ['offset', String((page - 1) * size)]])
  const list = useQuery({ queryKey: ['payment-history', query.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ rows: Payment[]; total: number }>(`/pharmacy/api/accounts/payment-history?${query}`) })
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<Choice[]>('/api/purchase/suppliers'), staleTime: 300_000 })
  const set = (name: string, value: string | null) => { setFilters({ ...filters, [name]: value ?? '' }); setPage(1) }
  const columns: Column<Payment>[] = [
    { header: 'Date', cell: (r) => day(r.created_at?.slice(0, 10)) },
    { header: 'Payment no.', cell: (r) => <Text size="sm" fw={r.account_number === mark ? 800 : 500} c={r.account_number === mark ? 'bottle.7' : undefined}>{r.account_number}</Text> },
    { header: 'Supplier', cell: (r) => r.supplier_name || '--' },
    { header: 'Created by', cell: (r) => r.created_by_name || '--' },
    { header: 'Approved by', cell: (r) => r.approved_by_name || '--' },
    { header: 'Paid', align: 'right', cell: (r) => money(r.net_amount_cents) },
    { header: 'Status', cell: (r) => <StatusBadge status={words(r.status)} /> },
    { header: 'Actions', align: 'right', cell: (r) => <Button size="xs" variant="default" onClick={() => setOpen(r)}>Documents</Button> },
  ]
  const header = (
    <>
      <PageHeader title="Payment history" actions={<>
        <Button variant="default" leftSection={<IconPrinter size={16} />} component="a" target="_blank" href={`/pharmacy/api/accounts/payment-history/print?${chosen}&view=page`}>Print</Button>
        <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/pharmacy/api/accounts/payment-history/export?${chosen}`}>Export CSV</Button>
      </>}>
        <Facts items={[{ label: 'Payments', value: list.data?.total ?? '--' }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <Select aria-label="Status" w={170} allowDeselect={false} data={PAYMENT_STATUSES.map(([value, label]) => ({ value, label }))} value={filters.status} onChange={(v) => set('status', v)} />
          <Select aria-label="Supplier" placeholder="All suppliers" w={230} clearable searchable data={suppliers.data ?? []} value={filters.supplier_id || null} onChange={(v) => set('supplier_id', v)} />
          <TextInput aria-label="From date" type="date" w={150} value={filters.date_from} onChange={(e) => set('date_from', e.currentTarget.value)} />
          <TextInput aria-label="To date" type="date" w={150} value={filters.date_to} onChange={(e) => set('date_to', e.currentTarget.value)} />
          <NumberInput aria-label="Amount from" placeholder="Amount from" w={140} min={0} hideControls value={filters.amount_min} onChange={(v) => set('amount_min', String(v))} />
          <NumberInput aria-label="Amount to" placeholder="Amount to" w={140} min={0} hideControls value={filters.amount_max} onChange={(v) => set('amount_max', String(v))} />
        </Group>
      </FilterBar>
    </>
  )
  return (
    <Page header={header}>
      <DataTable columns={columns} rows={list.data?.rows ?? []} rowKey={(r) => r.account_document_id} loading={list.isFetching} view={query.toString()}
        empty={<EmptyState title={list.isError ? 'Could not load the payments.' : 'No supplier payments found.'} hint={list.error?.message} />}
        footer={<Pager page={page} pageSize={size} total={list.data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
      {open && (
        <SidePanel title="Purchase documents paid" subject={open.account_number} size={640} onClose={() => setOpen(null)} viewOnly>
          <Stack>
            <Facts items={[{ label: 'Supplier', value: open.supplier_name || '--' }, { label: 'Paid', value: money(open.net_amount_cents) }]} />
            <div>
              <DataTable rows={open.allocations ?? []} rowKey={(a) => a.purchase_document_id} empty={<EmptyState title="No purchase documents found." />} columns={[
                { header: 'Document', cell: (a) => a.reference_number || `Document ${a.purchase_document_id}` },
                { header: 'Adjusted', align: 'right', cell: (a) => money(a.allocated_amount_cents) },
                { header: 'Document amount', align: 'right', cell: (a) => money(a.document_amount_cents) },
                { header: 'Status', cell: (a) => (a.line_status ? words(a.line_status) : '--') },
              ]} />
            </div>
          </Stack>
        </SidePanel>
      )}
    </Page>
  )
}

interface RegisterDoc { kind: string; document_id: number | null; document_number: string | null; grn_number?: string | null; document_date: string | null;
  reference: string | null; amount_cents: number; settled_cents: number; outstanding_cents: number; status: string | null }
interface RegisterSupplier { supplier_id: number; supplier_name: string; debit_cents: number; credit_cents: number; total_cents: number; documents?: RegisterDoc[] }
const DOC_GROUPS = [['PURCHASE_ORDER', 'Purchase orders'], ['GOODS_RECEIPT', 'Goods receipts'], ['SUPPLIER_INVOICE', 'Supplier invoices'],
  ['DEBIT_NOTE', 'Debit notes'], ['SUPPLIER_PAYMENT', 'Supplier payments']]
// a debit note stored as posted is one not yet adjusted
const REGISTER_WORDS: Record<string, string> = { POSTED: 'Not adjusted', PARTIALLY_ALLOCATED: 'Partly adjusted', ALLOCATED: 'Adjusted' }
const localDay = (d: Date) => d.toLocaleDateString('en-CA')

/** Purchase Register: each supplier's debit, credit and balance for a period; a supplier opens its documents. */
export function PurchaseRegister() {
  const start = () => ({ date_from: localDay(new Date(Date.now() - 30 * 86400000)), date_to: localDay(new Date()) })
  const [days, setDays] = useState(start)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 250)
  const [open, setOpen] = useState<RegisterSupplier | null>(null)
  const chosen = new URLSearchParams(Object.entries({ ...days, q }).filter(([, v]) => v))
  const list = useQuery({ queryKey: ['purchase-register', chosen.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ suppliers: RegisterSupplier[]; totals: { supplier_count?: number; debit_cents?: number; credit_cents?: number; total_cents?: number; chits_cents?: number } }>(
      `/pharmacy/api/accounts/supplier-outstanding?${chosen}`) })
  const t = list.data?.totals ?? {}
  const columns: Column<RegisterSupplier>[] = [
    { header: 'Supplier', cell: (s) => <Text size="sm" fw={500}>{s.supplier_name}</Text> },
    { header: 'Debit', align: 'right', cell: (s) => money(s.debit_cents) },
    { header: 'Credit', align: 'right', cell: (s) => money(s.credit_cents) },
    { header: 'Balance due', align: 'right', cell: (s) => <Text size="sm" fw={700}>{money(s.total_cents)}</Text> },
    { header: 'Actions', align: 'right', cell: (s) => <Button size="xs" variant="default" onClick={() => setOpen(s)}>Documents</Button> },
  ]
  const docLink = (d: RegisterDoc, s: RegisterSupplier) => (d.kind === 'DEBIT_NOTE'
    ? `/accounts/supplier-debit-notes?${new URLSearchParams({ mark: d.document_number ?? '' })}`
    : `/accounts/payment-history?${new URLSearchParams({ supplier_id: String(s.supplier_id), status: 'PAID', mark: d.document_number ?? '' })}`)
  return (
    <Page header={<>
      <PageHeader title="Purchase register" actions={<>
        <Button variant="default" leftSection={<IconPrinter size={16} />} component="a" target="_blank" href={`/pharmacy/api/accounts/purchase-register/print?${chosen}&view=page`}>Print</Button>
        <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/pharmacy/api/accounts/purchase-register/export?${chosen}`}>Export CSV</Button>
      </>}>
        <Facts items={[{ label: 'Suppliers', value: t.supplier_count ?? '--' }, { label: 'Debit', value: money(t.debit_cents) }, { label: 'Credit', value: money(t.credit_cents) },
          { label: 'Balance due', value: money(t.total_cents) }, ...(Number(t.chits_cents) > 0 ? [{ label: 'Debit notes not adjusted', value: money(t.chits_cents) }] : [])]} />
      </PageHeader>
      <FilterBar>
        <Group align="end">
          <TextInput aria-label="Search supplier" placeholder="Search supplier" leftSection={<IconSearch size={16} />} w={260} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          <TextInput aria-label="From date" type="date" w={150} value={days.date_from} onChange={(e) => setDays({ ...days, date_from: e.currentTarget.value })} />
          <TextInput aria-label="To date" type="date" w={150} value={days.date_to} onChange={(e) => setDays({ ...days, date_to: e.currentTarget.value })} />
          <Button variant="default" onClick={() => { setDays(start()); setSearch('') }}>Reset</Button>
        </Group>
      </FilterBar>
    </>}>
      <DataTable columns={columns} rows={list.data?.suppliers ?? []} rowKey={(s) => s.supplier_id} loading={list.isFetching} view={chosen.toString()}
        empty={<EmptyState title={list.isError ? list.error.message : 'No suppliers found for the selected period.'} />} />
      {open && (
        <SidePanel title="Supplier documents" subject={open.supplier_name} size={900} onClose={() => setOpen(null)} viewOnly>
          <Stack gap="md">
            <Facts items={[{ label: 'Debit', value: money(open.debit_cents) }, { label: 'Credit', value: money(open.credit_cents) }, { label: 'Balance due', value: money(open.total_cents) }]} />
            {!(open.documents ?? []).length && <Text size="sm">No documents found for the selected period.</Text>}
            {DOC_GROUPS.filter(([kind]) => open.documents?.some((d) => d.kind === kind)).map(([kind, label]) => (
              <Stack key={kind} gap={4}>
                <Text fw={600} size="sm">{label}</Text>
                <div>
                  <DataTable rows={open.documents!.filter((d) => d.kind === kind)} rowKey={(d) => `${d.kind}-${d.document_id}-${d.document_number}`} empty={null} columns={[
                    { header: 'Document no.', cell: (d) => (
                      <>{(kind === 'DEBIT_NOTE' || kind === 'SUPPLIER_PAYMENT') && d.document_number
                        ? <Anchor component={Link} to={docLink(d, open)} size="sm">{d.document_number}</Anchor> : <Text size="sm">{d.document_number || d.document_id || '--'}</Text>}
                      {d.grn_number && d.grn_number !== d.document_number && <Text size="xs" c="dimmed">GRN {d.grn_number}</Text>}</>) },
                    { header: 'Date', cell: (d) => day(d.document_date?.slice(0, 10)) },
                    { header: 'Reference no.', cell: (d) => (d.reference ? REGISTER_WORDS[d.reference] ?? words(d.reference) : '--') },
                    { header: 'Amount', align: 'right', cell: (d) => money(d.amount_cents) },
                    { header: 'Paid', align: 'right', cell: (d) => money(d.settled_cents) },
                    { header: 'Balance due', align: 'right', cell: (d) => (Number(d.outstanding_cents) ? money(d.outstanding_cents) : '--') },
                    { header: 'Status', cell: (d) => (d.status ? <StatusBadge status={REGISTER_WORDS[d.status] ?? words(d.status)} /> : '--') },
                  ]} />
                </div>
              </Stack>
            ))}
          </Stack>
        </SidePanel>
      )}
    </Page>
  )
}

interface RegisterLine { account_document_id?: number; account_number: string; payment_date: string | null; account_type: string; payment_mode: string | null;
  reference_number: string | null; sales_document_id: number | null; patient_name: string | null; mrn: string | null; user_name: string | null;
  store_name: string | null; net_amount_cents: number; unallocated_amount_cents: number | null }
interface ModeBucket { payment_mode: string; in_cents: number; out_cents: number }
interface CashRegisterReply {
  lines: RegisterLine[]; date_from: string; date_to: string; location_name: string | null; locations: { location_id: number; location_name: string }[]
  no_store: { count: number; in_cents: number; out_cents: number } | null
  totals: { in_cents?: number; out_cents?: number; net_cents?: number; cash_net_cents?: number; outstanding_cents?: number; by_mode?: ModeBucket[];
    by_date?: { date: string; in_cents: number; out_cents: number; net_cents: number }[];
    by_user?: { user_id: number; user_name: string | null; collected_cents: number; modes?: ModeBucket[] }[] }
}
// one column per family of payment modes; whatever is left is Other
const TENDER_GROUPS: [string, string[]][] = [['Cash', ['CASH']], ['Card', ['CREDIT_CARD', 'DEBIT_CARD']], ['Cheque', ['CHEQUE']], ['EFT', ['EFT', 'BANK_TRANSFER']],
  ['UPI', ['UPI']], ['RTGS', ['RTGS']], ['NEFT', ['NEFT']], ['IMPS', ['IMPS']]]
const RECEIPT_TYPES: Record<string, string> = { CUSTOMER_RECEIPT: 'Receipt', CUSTOMER_REFUND: 'Refund', CUSTOMER_ADVANCE: 'Advance', CUSTOMER_ADVANCE_RETURN: 'Advance refund' }
const MODES = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'UPI', 'CHEQUE', 'BANK_TRANSFER', 'EFT', 'RTGS', 'NEFT', 'IMPS', 'OTHER']
// a mixed mode ("UPI + CASH") word by word
const modeWords = (code: string | null) => (code ?? '').split(' + ').map((m) => words(m.trim())).join(' + ') || '--'

/** Cash Register: the money taken and paid out at the counter for a period, by receipt, by day and by user. */
export function CashRegister() {
  const today = () => ({ date_from: localDay(new Date()), date_to: localDay(new Date()), user_id: '', location_id: '', payment_mode: '', outstanding: '' })
  const [filters, setFilters] = useState<Record<string, string>>(today)
  const [tab, setTab] = useState<string | null>('receipts')
  const chosen = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
  const list = useQuery({ queryKey: ['cash-register', chosen.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<CashRegisterReply>(`/pharmacy/api/accounts/register?${chosen}`) })
  const d = list.data
  const t = d?.totals ?? {}
  const set = (name: string, value: string | null) => setFilters({ ...filters, [name]: value ?? '' })
  const tender = (u: NonNullable<typeof t.by_user>[number], modes: string[]) =>
    modes.reduce((sum, mode) => { const b = u.modes?.find((m) => m.payment_mode === mode); return sum + (b ? Number(b.in_cents || 0) - Number(b.out_cents || 0) : 0) }, 0)
  const lineColumns: Column<RegisterLine>[] = [
    { header: 'Receipt no.', cell: (l) => <Text size="sm" fw={500}>{l.account_number}</Text> },
    { header: 'Date', cell: (l) => day(l.payment_date?.slice(0, 10)) },
    { header: 'Type', cell: (l) => RECEIPT_TYPES[l.account_type] ?? words(l.account_type) },
    { header: 'Payment mode', cell: (l) => modeWords(l.payment_mode) },
    { header: 'Bill', cell: (l) => l.reference_number || (l.sales_document_id ? `Bill ${l.sales_document_id}` : '--') },
    { header: 'Patient', cell: (l) => l.patient_name || l.mrn || '--' },
    { header: 'User', cell: (l) => l.user_name || '--' },
    { header: 'Location', cell: (l) => l.store_name || '--' },
    { header: 'Received', align: 'right', cell: (l) => (['CUSTOMER_RECEIPT', 'CUSTOMER_ADVANCE'].includes(l.account_type) ? money(l.net_amount_cents) : '--') },
    { header: 'Paid out', align: 'right', cell: (l) => (['CUSTOMER_RECEIPT', 'CUSTOMER_ADVANCE'].includes(l.account_type) ? '--' : money(l.net_amount_cents)) },
    { header: 'Unadjusted', align: 'right', cell: (l) => (Number(l.unallocated_amount_cents) > 0 ? money(l.unallocated_amount_cents) : '--') },
  ]
  const users = t.by_user ?? []
  const header = (
    <>
      <PageHeader title="Cash register" actions={<>
        <Button variant="default" leftSection={<IconPrinter size={16} />} component="a" target="_blank" href={`/pharmacy/api/accounts/register/print?${chosen}&view=page`}>Print</Button>
        <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/pharmacy/api/accounts/register?${chosen}&format=CSV`}>Export CSV</Button>
      </>}>
        <Facts items={[{ label: 'Received', value: money(t.in_cents) }, { label: 'Paid out', value: money(t.out_cents) }, { label: 'Net', value: money(t.net_cents) },
          { label: 'Cash in hand', value: money(t.cash_net_cents) }, { label: 'Unadjusted', value: money(t.outstanding_cents) }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <TextInput aria-label="From date" type="date" w={150} value={filters.date_from} onChange={(e) => set('date_from', e.currentTarget.value)} />
          <TextInput aria-label="To date" type="date" w={150} value={filters.date_to} onChange={(e) => set('date_to', e.currentTarget.value)} />
          <Select aria-label="User" placeholder="All users" w={180} clearable value={filters.user_id || null} onChange={(v) => set('user_id', v)}
            data={users.map((u) => ({ value: String(u.user_id), label: u.user_name || `User ${u.user_id}` }))} />
          <Select aria-label="Location" placeholder="All locations" w={190} clearable value={filters.location_id || null} onChange={(v) => set('location_id', v)}
            data={(d?.locations ?? []).map((l) => ({ value: String(l.location_id), label: l.location_name }))} />
          <Select aria-label="Payment mode" placeholder="All modes" w={160} clearable value={filters.payment_mode || null} onChange={(v) => set('payment_mode', v)}
            data={MODES.map((m) => ({ value: m, label: words(m) }))} />
          <Checkbox label="Unadjusted only" checked={filters.outstanding === '1'} onChange={(e) => set('outstanding', e.currentTarget.checked ? '1' : '')} mb={8} />
          <Button variant="default" onClick={() => setFilters(today())}>Reset</Button>
        </Group>
      </FilterBar>
      {(t.by_mode ?? []).length > 0 && <Facts items={(t.by_mode ?? []).flatMap((b) => [{ label: `${modeWords(b.payment_mode)} in`, value: money(b.in_cents) },
        ...(b.out_cents ? [{ label: `${modeWords(b.payment_mode)} out`, value: money(b.out_cents) }] : [])])} />}
      {/* money with no location is counted only under All locations */}
      {d?.no_store && <Facts items={[{ label: 'No location', value: `${d.no_store.count} ${d.no_store.count === 1 ? 'entry' : 'entries'}` },
        { label: 'In', value: money(d.no_store.in_cents) }, { label: 'Out', value: money(d.no_store.out_cents) }]} />}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List><Tabs.Tab value="receipts">Receipts ({d?.lines.length ?? 0})</Tabs.Tab><Tabs.Tab value="days">By day</Tabs.Tab><Tabs.Tab value="users">By user</Tabs.Tab></Tabs.List>
      </Tabs>
    </>
  )
  const nothing = d ? `No receipts found between ${day(d.date_from)} and ${day(d.date_to)}${d.location_name ? ` at ${d.location_name}` : ''}.` : ''
  return (
    <Page header={header}>
      {tab === 'receipts' && <DataTable columns={lineColumns} rows={d?.lines ?? []} rowKey={(l) => l.account_number} loading={list.isFetching} view={chosen.toString()}
        empty={<EmptyState title={list.isError ? 'Could not load the register.' : nothing} hint={list.error?.message} />} />}
      {tab === 'days' && <DataTable rows={t.by_date ?? []} rowKey={(r) => r.date} loading={list.isFetching} empty={<EmptyState title="No receipts found." />} columns={[
        { header: 'Date', cell: (r) => day(r.date) }, { header: 'Received', align: 'right', cell: (r) => money(r.in_cents) },
        { header: 'Paid out', align: 'right', cell: (r) => money(r.out_cents) }, { header: 'Net', align: 'right', cell: (r) => <Text size="sm" fw={700}>{money(r.net_cents)}</Text> }]} />}
      {tab === 'users' && <DataTable rows={users} rowKey={(u) => u.user_id} loading={list.isFetching} empty={<EmptyState title="No collections found." />} columns={[
        { header: 'User', cell: (u) => u.user_name || `User ${u.user_id}` },
        ...TENDER_GROUPS.map(([label, modes]): Column<(typeof users)[number]> => ({ header: label, align: 'right', cell: (u) => money(tender(u, modes)) })),
        { header: 'Other', align: 'right', cell: (u) => money(Number(u.collected_cents || 0) - TENDER_GROUPS.reduce((s, [, modes]) => s + tender(u, modes), 0)) },
        { header: 'Collected', align: 'right', cell: (u) => <Text size="sm" fw={700}>{money(u.collected_cents)}</Text> }]} />}
    </Page>
  )
}
