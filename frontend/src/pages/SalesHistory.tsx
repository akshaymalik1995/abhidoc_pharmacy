/** Sales History: the bills of the counter, one tab at a time, with the filters of the counter and the totals
 * of the Sales Register for the same days. Cancelling a bill and approving a sale return save through DocAssist. */
import { Button, Collapse, Group, Select, SimpleGrid, Tabs, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconAdjustmentsHorizontal, IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api, contract } from '../api'
import type { components } from '../api-types'
import {
  type Column, DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, Pager, type RowAction, RowActions, StatusBadge, useConfirm,
} from '../ui'
import { words } from './PurchaseList'
import { SaleReturnForm } from './SaleReturnForm'
import { dateTime, printBill, type Bill } from './SaleShared'

type History = components['schemas']['SalesHistory']
type Row = History['rows'][number]

const TABS = [
  { value: 'sales', label: 'Sales', empty: 'No posted sales bills match these filters. Draft and pending bills are listed under Pending entries.' },
  { value: 'returns', label: 'Sale returns', empty: 'No sale returns match these filters.' },
  { value: 'pending', label: 'Pending entries', empty: 'No draft or pending sale entries match these filters.' },
  { value: 'return_requests', label: 'Medicine return requests', empty: 'No medicine return requests match these filters.' },
]
const PRESETS = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' }, { value: 'this_month', label: 'This month' }, { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
]
const STATUSES = ['DRAFT', 'PENDING', 'CONFIRMED', 'CONVERTED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED', 'PARTIAL', 'PAID', 'WRITTEN_OFF']
const three = (all: string, only: string, exclude: string) => [{ value: 'all', label: all }, { value: 'only', label: only }, { value: 'exclude', label: exclude }]
const START = { tab: 'sales', date_preset: 'last_30_days', cancelled: 'exclude', quick_sale: 'all', landed_cost: 'all', discounted: 'all' }

/** returns: the Sale Returns screen, the same list kept to sale returns and return requests, where a bill's
 * "Sale return" opens the return of that bill (?sale=<id>) */
export function SalesHistory({ returns = false }: { returns?: boolean }) {
  const tabs = returns ? TABS.filter((t) => t.value === 'returns' || t.value === 'return_requests') : TABS
  const start = { ...START, tab: tabs[0].value }
  const [address, setAddress] = useSearchParams()
  const returning = returns ? address.get('sale') : null
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<Record<string, string>>(start)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [comparing, setComparing] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const confirm = useConfirm()
  const chosen = new URLSearchParams(Object.entries({ ...filters, ...(q ? { q } : {}) }).filter(([, v]) => v))
  const query = new URLSearchParams([...chosen, ['limit', String(size)], ['offset', String((page - 1) * size)]])
  const list = useQuery({ queryKey: ['sales-history', query.toString()], queryFn: () => api<History>(`/api/sales/history?${query}`), placeholderData: keepPreviousData })
  const data = list.data
  const may = data?.permissions
  // how many of the filters behind the Filters button are set
  const hidden = ['location_id', 'visit_type'].filter((k) => filters[k]).length
    + ['quick_sale', 'landed_cost', 'discounted'].filter((k) => filters[k] !== 'all').length + (filters.cancelled !== 'exclude' ? 1 : 0)
  function setFilter(name: string, value: string | null) {
    const next = { ...filters, [name]: value ?? '' }
    // typing a date makes the range custom; choosing a preset clears typed dates
    if (name === 'date_from' || name === 'date_to') next.date_preset = 'custom'
    if (name === 'date_preset' && value !== 'custom') { next.date_from = ''; next.date_to = '' }
    setFilters(next)
    setPage(1)
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sales-history'] })
  const step = useMutation({
    mutationFn: (job: { row: Row; path: string; done: string }) => contract(job.path, 'POST', {}),
    onSuccess: (_, job) => { notifySuccess(`${job.row.sales_number} ${job.done}.`); return refresh() },
  })
  const print = async (row: Row) => { try { await printBill(await api<Bill>(`/api/sales/bills/${row.sales_document_id}`)) } catch (e) { notifyFailure(e as Error) } }

  function actions(r: Row): RowAction[] {
    const posted = ['CONFIRMED', 'PAID', 'PARTIAL'].includes(r.status)
    const returnable = ['SALE', 'QUICK_SALE'].includes(r.sales_type) && posted
    // a draft or pending bill has moved no stock or money yet, so it can still be cancelled; a posted bill is reversed by a sale return
    const cancellable = (r.sales_type === 'ESTIMATE' && ['DRAFT', 'CONFIRMED'].includes(r.status))
      || (['SALE', 'QUICK_SALE', 'PENDING_SALE'].includes(r.sales_type) && ['DRAFT', 'PENDING'].includes(r.status))
    const id = r.sales_document_id
    return [
      { label: 'View', to: `/sales/bills/${id}` },
      r.status !== 'DRAFT' && r.status !== 'CANCELLED' && may?.print && { label: 'Print', onClick: () => print(r) },
      returnable && r.balance > 0 && may?.pay && { label: 'Collect payment', to: `/sales/bills/${id}?pay=1` },
      returnable && Number(r.quantity_total) > Number(r.returned_quantity_total) && { label: 'Sale return', to: `/sales/sale-returns?sale=${id}` },
      returnable && { label: 'Delivery', to: `/sales/deliveries?sale=${id}` },
      r.sales_type === 'SALE_RETURN' && r.status === 'PENDING' && may?.credit
        && { label: 'Approve', kind: 'main', onClick: () => confirm.ask({ action: 'Approve', subject: r.sales_number ?? '',
          run: () => step.mutateAsync({ row: r, path: `/pharmacy/api/sale-returns/${id}/approve`, done: 'approved' }) }) },
      cancellable && may?.cancel && { label: 'Cancel', kind: 'danger', onClick: () => confirm.ask({ action: 'Cancel', subject: r.sales_number ?? '', danger: true,
        note: 'It has moved no stock or money yet.', run: () => step.mutateAsync({ row: r, path: `/pharmacy/api/sales/${id}/cancel`, done: 'cancelled' }) }) },
    ].filter(Boolean) as RowAction[]
  }

  const notes = (r: Row) => [r.is_discounted && 'Discounted', r.has_prescription && 'Prescription', r.is_landed_cost_sale && 'Landed cost', r.is_free_bill && 'Free'].filter(Boolean).join(', ')
  const columns: Column<Row>[] = [
    { header: 'Bill no.', cell: (r) => <><Text size="sm" fw={500}>{r.sales_number}</Text>{r.original_sales_number && <Text size="xs" c="dimmed">of {r.original_sales_number}</Text>}</> },
    { header: 'Date and time', cell: (r) => (r.billed_at ? dateTime(r.billed_at) : day(r.document_date)) },
    { header: 'Patient', cell: (r) => <><Text size="sm">{r.patient_name || 'Walk-in'}</Text><Text size="xs" c="dimmed">{[r.mrn, r.gender].filter(Boolean).join(', ') || '--'}</Text></> },
    { header: 'Visit', cell: (r) => <><Text size="sm">{r.visit_number || '--'}</Text><Text size="xs" c="dimmed">{words(r.visit_type) || '--'}</Text></> },
    { header: 'Type', cell: (r) => <><Text size="sm">{words(r.sales_type)}</Text>{notes(r) && <Text size="xs" c="dimmed">{notes(r)}</Text>}</> },
    { header: 'Status', cell: (r) => <StatusBadge status={words(r.status)} /> },
    // gross, discount and tax are on pointing at Net (and in the export), so the row fits without scrolling sideways
    { header: 'Net / rounded', align: 'right', cell: (r) => (
      <div title={`Gross ${money(r.gross)}, discount ${money(r.discount)}, tax ${money(r.tax)}`}>
        <Text size="sm">{money(r.net)}</Text><Text size="xs" c="dimmed">{money(r.rounded)}</Text>
      </div>
    ) },
    { header: 'Paid', align: 'right', cell: (r) => <><Text size="sm">{money(r.paid)}</Text>{r.refunded > 0 && <Text size="xs" c="dimmed">refund {money(r.refunded)}</Text>}</> },
    { header: 'Balance due', align: 'right', cell: (r) => money(r.balance) },
    { header: 'Billed by', cell: (r) => r.billed_by_name || '--' },
    { header: 'Actions', align: 'right', cell: (r) => <RowActions name={r.sales_number ?? ''} actions={actions(r)} /> },
  ]

  const totals = data?.totals
  const register = data?.register_totals
  const historyPrint = useMutation({
    mutationFn: () => contract(`/pharmacy/api/sales/history/print?${chosen}`, 'POST', {}),
    onSuccess: () => notifySuccess('Sent to the counter printer.'),
    onError: notifyFailure,
  })
  const header = (
    <>
      <PageHeader
        title={returns ? 'Sale returns' : 'Sales history'}
        actions={<>
          {register && <Button variant="default" onClick={() => setComparing(!comparing)}>{comparing ? 'Hide' : 'Compare with'} Sales Register</Button>}
          <Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!data?.rows.length} loading={historyPrint.isPending} onClick={() => historyPrint.mutate()}>Print</Button>
          <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/api/sales/history?${chosen}&output=csv`}>Export CSV</Button>
        </>}
      >
        <Facts items={[
          { label: 'Bills', value: totals?.count ?? '--' }, { label: 'Net', value: money(totals?.net) }, { label: 'Paid', value: money(totals?.paid) },
          { label: 'Balance due', value: money(totals?.balance) },
        ]} />
      </PageHeader>
      <Collapse expanded={comparing && Boolean(register)}>
        {register && <Facts items={[{ label: 'Register bills', value: register.sales_count }, { label: 'Register returns', value: register.returns_count },
          { label: 'Register net', value: money(register.net) }, { label: 'Register paid', value: money(register.paid) },
          { label: 'Register balance due', value: money(register.balance) }, { label: 'This list net', value: money(totals?.net) }]} />}
      </Collapse>
      <Tabs value={filters.tab} onChange={(tab) => setFilter('tab', tab)}>
        <Tabs.List>
          {tabs.map((t) => <Tabs.Tab key={t.value} value={t.value}>{t.label} ({data?.tab_counts[t.value] ?? 0})</Tabs.Tab>)}
        </Tabs.List>
      </Tabs>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <TextInput aria-label="Search bills" placeholder="Bill no., patient, MRN, visit, phone" leftSection={<IconSearch size={16} />}
            value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} style={{ flex: 1 }} miw={220} />
          <Select aria-label="Billed date" data={PRESETS} value={filters.date_preset} onChange={(v) => setFilter('date_preset', v ?? 'last_30_days')} allowDeselect={false} w={150} />
          <TextInput aria-label="From date" type="date" value={filters.date_from || data?.date_from || ''} onChange={(e) => setFilter('date_from', e.currentTarget.value)} w={150} />
          <TextInput aria-label="To date" type="date" value={filters.date_to || data?.date_to || ''} onChange={(e) => setFilter('date_to', e.currentTarget.value)} w={150} />
          <Select aria-label="Status" placeholder="All statuses" clearable data={STATUSES.map((s) => ({ value: s, label: words(s) }))} value={filters.status || null} onChange={(v) => setFilter('status', v)} w={170} />
          <Button variant="default" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={() => setMoreOpen(!moreOpen)}>Filters{hidden ? ` (${hidden})` : ''}</Button>
        </Group>
        <Collapse expanded={moreOpen}>
          <SimpleGrid cols={{ base: 1, sm: 3, lg: 6 }} mt="md">
            <Select label="Location" placeholder="All locations" clearable searchable data={data?.locations ?? []} value={filters.location_id || null} onChange={(v) => setFilter('location_id', v)} />
            <Select label="Visit type" placeholder="All" clearable value={filters.visit_type || null} onChange={(v) => setFilter('visit_type', v)}
              data={[{ value: 'OP', label: 'OP' }, { value: 'IP', label: 'IP' }, { value: 'RETAIL', label: 'Retail' }, { value: 'WALK_IN', label: 'Walk-in' }, { value: 'OTHER', label: 'Other' }]} />
            <Select label="Cancelled bills" allowDeselect={false} value={filters.cancelled} onChange={(v) => setFilter('cancelled', v)}
              data={[{ value: 'exclude', label: 'Exclude cancelled' }, { value: 'all', label: 'Include cancelled' }, { value: 'only', label: 'Cancelled only' }]} />
            <Select label="Quick sale" allowDeselect={false} value={filters.quick_sale} onChange={(v) => setFilter('quick_sale', v)} data={three('All', 'Quick sales only', 'Regular sales only')} />
            <Select label="Landed cost" allowDeselect={false} value={filters.landed_cost} onChange={(v) => setFilter('landed_cost', v)} data={three('All', 'Landed-cost bills only', 'Exclude landed-cost bills')} />
            <Select label="Discount" allowDeselect={false} value={filters.discounted} onChange={(v) => setFilter('discounted', v)} data={three('All', 'Discounted bills only', 'Exclude discounted bills')} />
          </SimpleGrid>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => { setFilters(start); setSearch(''); setPage(1) }}>Reset</Button>
          </Group>
        </Collapse>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={(r) => r.sales_document_id}
        loading={list.isFetching}
        view={query.toString()}
        empty={list.isError ? <EmptyState title="Could not load the bills." hint={list.error.message} /> : <EmptyState title={TABS.find((t) => t.value === filters.tab)?.empty ?? ''} />}
        footer={<Pager page={page} pageSize={size} total={data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />}
      />
      {returning && <SaleReturnForm saleId={returning} onClose={() => setAddress({}, { replace: true })} />}
      {confirm.dialog}
    </Page>
  )
}
