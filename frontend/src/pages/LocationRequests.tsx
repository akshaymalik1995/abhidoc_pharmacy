/** Location Stock Requests: a ward or department asks the pharmacy for stock; the pharmacy issues it and the
 * ward receives it. Also the history of those requests. Every read and save goes through DocAssist, whose
 * endpoints here answer 200 with an `ok` flag and know what the logged-in person may do. */
import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { contract } from '../api'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import {
  type Column, ConfirmDialog, DataTable, day, EmptyState, Facts, FilterBar, notifyFailure, notifySuccess, Page, PageHeader, Pager, plain, type RowAction, RowActions, SaveButton, SidePanel, StatusBadge,
} from '../ui'
import { words } from './PurchaseList'

const BASE = '/pharmacy/api/stock/internal-issue-location-requests'

interface RequestLine { item_id: number; product_name: string; base_unit: string | null; requested_quantity: string; issued_quantity: string; received_quantity: string }
interface Request {
  stock_document_id: number
  stock_number: string
  status: string
  document_date?: string
  created_date?: string
  required_date: string | null
  from_location_name: string | null
  internal_issue_location_name: string | null
  to_location_name: string | null
  creator_name: string | null
  product_count: number
  requested_quantity_total?: string
  issued_quantity_total?: string
  received_quantity_total?: string
  requested_quantity?: string
  issued_quantity?: string
  received_quantity?: string
  issued_at?: string | null
  received_at?: string | null
  transfer_document_id: number | null
  transfer_number: string | null
  transfer_status: string | null
  notes: string | null
  lines: RequestLine[]
}
interface Place { location_id: number; location_name: string; is_internal_issue_location: number; is_stock_location: number }
interface ListReply {
  rows: Request[]
  total: number
  permissions: { create?: boolean; issue?: boolean; receive?: boolean; cancel?: boolean }
  options: { locations: Place[]; departments: { department_id: number; department_name: string }[] }
}

/** DocAssist sends some dates as "Wed, 14 Oct 2026 00:00:00 GMT" and some as "2026-10-14". */
const date = (value: string | null | undefined) => (value ? day(new Date(value.length > 10 ? value : `${value}T00:00`).toLocaleDateString('en-CA')) : '--')
const STATUSES = ['REQUESTED', 'ISSUED', 'RECEIVED', 'CANCELLED', 'CLOSED']

const LINE_COLUMNS: Column<RequestLine>[] = [
  { header: 'Product', cell: (line) => <Text size="sm" fw={500}>{line.product_name}</Text> },
  { header: 'Unit', cell: (line) => line.base_unit || '--' },
  { header: 'Requested', align: 'right', cell: (line) => plain(line.requested_quantity) },
  { header: 'Issued', align: 'right', cell: (line) => plain(line.issued_quantity) },
  { header: 'Received', align: 'right', cell: (line) => plain(line.received_quantity) },
]

function RequestView({ request, onClose }: { request: Request; onClose: () => void }) {
  return (
    <SidePanel title="Stock request" subject={request.stock_number} badge={<StatusBadge status={words(request.status)} />} size={860} onClose={onClose} viewOnly>
      <Stack gap="md">
        <Facts items={[
          { label: 'From location', value: request.from_location_name ?? '--' },
          { label: 'Requesting location', value: request.internal_issue_location_name ?? '--' },
          { label: 'Deliver to', value: request.to_location_name ?? '--' },
          { label: 'Required', value: date(request.required_date) },
          { label: 'Requested by', value: request.creator_name ?? '--' },
          ...(request.transfer_number ? [{ label: 'Transfer', value: `${request.transfer_number}${request.transfer_status ? ` (${words(request.transfer_status)})` : ''}` }] : []),
          ...(request.notes ? [{ label: 'Notes', value: request.notes }] : []),
        ]} />
        <DataTable columns={LINE_COLUMNS} rows={request.lines} rowKey={(line) => line.item_id} empty={<EmptyState title="This request has no rows." />} />
      </Stack>
    </SidePanel>
  )
}

export function LocationStockRequests() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Request | null>(null)
  const [adding, setAdding] = useState(false)
  const [asking, setAsking] = useState<{ row: Request; label: string; path: string; done: string } | null>(null)

  const query = new URLSearchParams(status ? { status } : {})
  const list = useQuery({ queryKey: ['location-requests', query.toString()], queryFn: () => contract<ListReply>(`${BASE}?${query}`), placeholderData: keepPreviousData })
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['location-requests'] }), queryClient.invalidateQueries({ queryKey: ['overall-stock'] })])
  const may = list.data?.permissions ?? {}

  const run = useMutation({
    mutationFn: (job: { row: Request; path: string; done: string }) => contract<{ transfer_number?: string }>(job.path, 'POST', {}),
    onSuccess: (reply, job) => { notifySuccess(`Stock request ${job.row.stock_number} ${job.done}${reply.transfer_number ? `; transfer ${reply.transfer_number}` : ''}.`); return refresh() },
    onError: notifyFailure,
    onSettled: () => setAsking(null),
  })

  function actions(row: Request): RowAction[] {
    const ask = (label: string, path: string, done: string, kind?: 'main' | 'danger'): RowAction => ({ label, kind, onClick: () => setAsking({ row, label, path, done }) })
    return [
      row.status === 'REQUESTED' && may.issue && ask('Issue', `${BASE}/${row.stock_document_id}/issue`, 'issued', 'main'),
      row.status === 'ISSUED' && may.receive && ask('Receive', `${BASE}/${row.stock_document_id}/receive`, 'received', 'main'),
      { label: 'View', onClick: () => setViewing(row) },
      row.status === 'REQUESTED' && may.cancel && ask('Cancel', `/pharmacy/api/stock/indent/${row.stock_document_id}/cancel`, 'cancelled', 'danger'),
      row.status === 'ISSUED' && row.transfer_document_id && row.transfer_status === 'IN_TRANSIT' && may.cancel
        && ask('Cancel transfer', `/pharmacy/api/stock/transfer/${row.transfer_document_id}/cancel`, 'transfer cancelled', 'danger'),
    ].filter(Boolean) as RowAction[]
  }

  const columns: Column<Request>[] = [
    { header: 'Request no.', cell: (row) => <Text size="sm" fw={500}>{row.stock_number}</Text> },
    { header: 'Date', cell: (row) => date(row.document_date) },
    { header: 'From location', cell: (row) => row.from_location_name || '--' },
    { header: 'To location', cell: (row) => row.to_location_name || row.internal_issue_location_name || '--' },
    { header: 'Requested by', cell: (row) => row.creator_name || '--' },
    { header: 'Products', cell: (row) => row.product_count },
    { header: 'Quantity', align: 'right', cell: (row) => plain(row.requested_quantity_total) },
    { header: 'Transfer', cell: (row) => (row.transfer_number ? `${row.transfer_number}${row.transfer_status ? `, ${words(row.transfer_status).toLowerCase()}` : ''}` : '--') },
    { header: 'Status', cell: (row) => <StatusBadge status={words(row.status)} /> },
    { header: 'Actions', align: 'right', cell: (row) => <RowActions name={row.stock_number} actions={actions(row)} /> },
  ]

  const header = (
    <>
      <PageHeader
        title="Location stock requests"
        actions={
          <>
            <Button variant="default" component={Link} to="/stock/location-stock-request-history">History</Button>
            {may.create && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>New stock request</Button>}
          </>
        }
      >
        <Facts items={[{ label: 'Requests', value: list.data?.total ?? '--' }]} />
      </PageHeader>
      <FilterBar>
        <Select label="Status" placeholder="All" data={STATUSES.map((s) => ({ value: s, label: words(s) }))} value={status} onChange={setStatus} clearable w={200} />
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(row) => row.stock_document_id}
        loading={list.isFetching}
        view={query.toString()}
        empty={list.isError ? <EmptyState title="Could not load the requests." hint={list.error.message} /> : <EmptyState title="No stock requests found." />}
      />
      {viewing && <RequestView request={viewing} onClose={() => setViewing(null)} />}
      {adding && list.data && <NewRequest options={list.data.options} onClose={() => setAdding(false)} onSaved={refresh} />}
      <ConfirmDialog
        opened={Boolean(asking)} title={`${asking?.label} ${asking?.row.stock_number ?? ''}`} confirm={asking?.label ?? ''} keep="Not now" loading={run.isPending}
        onConfirm={() => asking && run.mutate(asking)} onClose={() => setAsking(null)}
      >
        {asking?.label} stock request {asking?.row.stock_number}?
      </ConfirmDialog>
    </Page>
  )
}

function NewRequest(props: { options: ListReply['options']; onClose: () => void; onSaved: () => Promise<unknown> }) {
  interface Line { key: number; product: OrderProduct | null; quantity: string }
  const blank = (): Line => ({ key: Math.random(), product: null, quantity: '' })
  const [head, setHead] = useState({ requester: '', to: '', date: new Date().toLocaleDateString('en-CA'), department: '', reference: '', notes: '' })
  const [lines, setLines] = useState<Line[]>([blank()])
  const setField = (name: keyof typeof head, value: string | null) => setHead({ ...head, [name]: value ?? '' })
  const setLine = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const places = (only: (place: Place) => unknown) => props.options.locations.filter(only).map((place) => ({ value: String(place.location_id), label: place.location_name }))
  const used = lines.filter((line) => line.product)
  const problem = !head.requester ? 'Select the requesting location.'
    : !used.length ? 'Add at least one row.'
      : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.' : null
  const save = useMutation({
    mutationFn: () => contract<{ stock_number?: string }>(BASE, 'POST', {
      internal_issue_location_id: head.requester, to_location_id: head.to || head.requester, requested_date: head.date,
      department_id: head.department || null, reference_number: head.reference.trim(), notes: head.notes.trim(),
      items: used.map((line) => ({ item_id: line.product!.item_id, quantity: Number(line.quantity), unit: line.product!.unit_of_measure })),
    }),
    onSuccess: async (reply) => { await props.onSaved(); notifySuccess(`Stock request ${reply.stock_number ?? ''} saved.`); props.onClose() },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New stock request" size={860} onClose={props.onClose}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select label="Requesting location" required placeholder="Select location" data={places((p) => p.is_internal_issue_location)} value={head.requester || null} onChange={(v) => setField('requester', v)} searchable />
            <Select label="Deliver to" placeholder="Same as requesting location" data={places(() => true)} value={head.to || null} onChange={(v) => setField('to', v)} clearable searchable />
            <TextInput label="Date" required type="date" value={head.date} onChange={(e) => setField('date', e.currentTarget.value)} />
            <Select label="Department" placeholder="Optional" clearable searchable value={head.department || null} onChange={(v) => setField('department', v)}
              data={props.options.departments.map((d) => ({ value: String(d.department_id), label: d.department_name }))} />
            <TextInput label="Reference no." value={head.reference} onChange={(e) => setField('reference', e.currentTarget.value)} />
            <TextInput label="Notes" value={head.notes} onChange={(e) => setField('notes', e.currentTarget.value)} />
          </SimpleGrid>
          <Table withTableBorder highlightOnHover={false}>
            <Table.Thead bg="gray.0"><Table.Tr><Table.Th>Product</Table.Th><Table.Th w={120} ta="right">Quantity</Table.Th><Table.Th w={100}>Unit</Table.Th><Table.Th w={44} /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {lines.map((line) => (
                <Table.Tr key={line.key}>
                  <Table.Td><ProductPicker label="Product" value={line.product} onChange={(product) => setLine(line.key, { product })} /></Table.Td>
                  <Table.Td>
                    <NumberInput aria-label="Quantity" size="xs" min={0} allowNegative={false} decimalScale={3} hideControls value={line.quantity}
                      onChange={(value) => setLine(line.key, { quantity: String(value) })} styles={{ input: { textAlign: 'right' } }} />
                  </Table.Td>
                  <Table.Td>{line.product?.unit_of_measure || '--'}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1} onClick={() => setLines(lines.filter((other) => other.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group><Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, blank()])}>Add row</Button></Group>
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <SaveButton problem={problem} type="submit" loading={save.isPending}>Save request</SaveButton>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}

interface Named { location_id: number; location_name: string }
interface HistoryReply {
  rows: Request[]
  total: number
  totals: { documents?: number; product_count?: number; requested_quantity?: string; issued_quantity?: string; received_quantity?: string }
  options: { from_locations: Named[]; internal_locations: Named[] }
}
const PAGE_SIZE = 25

export function LocationRequestHistory() {
  const [filters, setFilters] = useState<Record<string, string>>({ cancelled: 'all' })
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [viewing, setViewing] = useState<Request | null>(null)
  const chosen = new URLSearchParams({ ...filters, ...(q ? { q } : {}) })
  const query = new URLSearchParams({ ...filters, ...(q ? { q } : {}), limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
  const list = useQuery({ queryKey: ['location-request-history', query.toString()], queryFn: () => contract<HistoryReply>(`${BASE}/history?${query}`), placeholderData: keepPreviousData })
  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }
  const totals = list.data?.totals ?? {}
  const choices = (rows: Named[] | undefined) => (rows ?? []).map((row) => ({ value: String(row.location_id), label: row.location_name }))

  const columns: Column<Request>[] = [
    { header: 'Request no.', cell: (row) => <Text size="sm" fw={500}>{row.stock_number}</Text> },
    { header: 'Date / required', cell: (row) => <><Text size="sm">{date(row.created_date)}</Text><Text size="xs" c="dimmed">required {date(row.required_date)}</Text></> },
    { header: 'Requesting location', cell: (row) => row.internal_issue_location_name || '--' },
    { header: 'Deliver to', cell: (row) => row.to_location_name || '--' },
    { header: 'Products', align: 'right', cell: (row) => row.product_count },
    { header: 'Requested', align: 'right', cell: (row) => plain(row.requested_quantity) },
    // the quantity with its date under it: two columns fewer, so the table fits without scrolling sideways
    { header: 'Issued', align: 'right', cell: (row) => <><Text size="sm">{plain(row.issued_quantity)}</Text>{row.issued_at && <Text size="xs" c="dimmed">{date(row.issued_at)}</Text>}</> },
    { header: 'Received', align: 'right', cell: (row) => <><Text size="sm">{plain(row.received_quantity)}</Text>{row.received_at && <Text size="xs" c="dimmed">{date(row.received_at)}</Text>}</> },
    { header: 'Status', cell: (row) => <StatusBadge status={words(row.status)} /> },
    { header: 'Transfer no.', cell: (row) => row.transfer_number || '--' },
    { header: 'Actions', align: 'right', cell: (row) => <RowActions name={row.stock_number} actions={[{ label: 'View', onClick: () => setViewing(row) }]} /> },
  ]

  const header = (
    <>
      <PageHeader
        title="Location stock request history"
        actions={
          <>
            <Button variant="default" component={Link} to="/stock/location-stock-requests">Requests</Button>
            <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`${BASE}/export?${chosen}`}>Export CSV</Button>
          </>
        }
      >
        <Facts items={[
          { label: 'Requests', value: totals.documents ?? '--' }, { label: 'Products', value: totals.product_count ?? '--' },
          { label: 'Requested', value: plain(totals.requested_quantity) }, { label: 'Issued', value: plain(totals.issued_quantity) },
          { label: 'Received', value: plain(totals.received_quantity) },
        ]} />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4, lg: 7 }}>
          <TextInput label="Search" placeholder="Request no. or product" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput label="From date" type="date" value={filters.from_date ?? ''} onChange={(e) => setFilter('from_date', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.to_date ?? ''} onChange={(e) => setFilter('to_date', e.currentTarget.value)} />
          <Select label="Status" placeholder="All" data={STATUSES.map((s) => ({ value: s, label: words(s) }))} value={filters.status ?? null} onChange={(v) => setFilter('status', v)} clearable />
          <Select label="Cancelled" value={filters.cancelled} onChange={(v) => setFilter('cancelled', v ?? 'all')} allowDeselect={false}
            data={[{ value: 'all', label: 'Show' }, { value: 'exclude', label: 'Hide' }, { value: 'only', label: 'Only cancelled' }]} />
          <Select label="From location" placeholder="All locations" data={choices(list.data?.options.from_locations)} value={filters.from_location_id ?? null} onChange={(v) => setFilter('from_location_id', v)} clearable searchable />
          <Select label="Requesting location" placeholder="All locations" data={choices(list.data?.options.internal_locations)} value={filters.internal_issue_location_id ?? null} onChange={(v) => setFilter('internal_issue_location_id', v)} clearable searchable />
        </SimpleGrid>
      </FilterBar>
    </>
  )
  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(row) => row.stock_document_id}
        loading={list.isFetching}
        view={query.toString()}
        empty={list.isError ? <EmptyState title="Could not load the history." hint={list.error.message} /> : <EmptyState title="No stock requests found." hint="Change the dates or the filters." />}
        footer={<Pager page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />}
      />
      {viewing && <RequestView request={viewing} onClose={() => setViewing(null)} />}
    </Page>
  )
}
