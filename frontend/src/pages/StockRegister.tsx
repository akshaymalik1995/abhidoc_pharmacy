/** The stock registers: Stock Issues, Transfers, Receipts, Requests, Internal Issue History, Adjustments,
 * Write-offs, Relocations and Physical Stock History are one list over stock documents, each with its own type and columns. */
import { Anchor, Button, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import {
  DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader,
  Pager, plain, printTable, RowActions, SidePanel, StatusBadge, useConfirm, type Column,
} from '../ui'
import { words } from './PurchaseList'
import { AdjustmentForm, RelocationForm, RequestFulfilForm, StockRequestForm, WriteOffForm } from './StockForms'
import { InternalIssueForm, IssueReturnForm } from './InternalIssues'
import { StockMoveForm } from './StockMoves'

type DocPage = components['schemas']['StockDocumentPage']
type Row = components['schemas']['StockDocumentRow']
type Doc = components['schemas']['StockDocument']
type Line = components['schemas']['StockLine']

const URL = '/api/stock/documents'
const stamp = (value: string | null | undefined) =>
  (value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--')
const KIND: Record<string, string> = {
  PHARMACY_STOCK_ISSUE: 'Stock issue', PHARMACY_SALE: 'Sale', PHARMACY_PURCHASE_RETURN: 'Purchase return', PHARMACY_DELIVERY: 'Delivery',
}

/** One register: which documents it lists and how it names them. */
export interface Register {
  key: string
  title: string
  number: string // what the document number is called here
  stockType: string
  fixed?: Record<string, string> // filters this register always applies
  places?: 'from-to' | 'one' // which location columns and filters it has
  kinds?: boolean // the "what it was issued for" filter
  quantity: (row: Row) => string
  quantityHeader: string
  before?: Column<Row>[] // extra columns right after the date
  after?: Column<Row>[] // extra columns after the quantity
  /** A register whose documents open on a screen of their own instead of the read-only panel. */
  openAt?: (row: Row) => string
  actions?: ReactNode
  /** The new documents that can be made from this register: a button each. */
  forms?: FormKind[]
  /** What can be done to a row. Each is one POST to DocAssist, which holds the stock rules. */
  steps?: (row: Row) => Step[]
}

type FormKind = 'issue' | 'transfer' | 'request' | 'adjustment' | 'write-off' | 'internal-issue' | 'relocation'
const FORM_NAME: Record<FormKind, string> = {
  issue: 'New stock issue', transfer: 'New stock transfer', request: 'New stock request',
  adjustment: 'New stock adjustment', 'write-off': 'New stock write-off', 'internal-issue': 'New internal stock issue',
  relocation: 'New stock relocation',
}

interface Step {
  label: string
  kind?: 'main' | 'danger'
  path: string // under /pharmacy/api/stock/; "return" and "fulfil" open a form instead
  done: string // "<number> <done>."
  reason?: boolean // ask for a reason first and send it
}

const place = (row: Row) => row.to_location_name || row.internal_issue_location_name || '--'
const reference: Column<Row> = { header: 'Reference no.', cell: (row) => row.reference_number || '--' }
const value = (header: string): Column<Row> => ({ header, align: 'right', cell: (row) => money(row.net_amount_cents) })
const receivedOn: Column<Row> = { header: 'Received on', cell: (row) => stamp(row.received_at) }
const notes: Column<Row> = { header: 'Notes', cell: (row) => row.notes || '--' }

export const REGISTERS: Record<string, Register> = {
  issues: {
    key: 'issues', title: 'Stock issues', number: 'Document no.', stockType: 'STOCK_ISSUE', places: 'from-to', kinds: true, forms: ['issue'],
    // only a plain stock issue is confirmed or cancelled here; a sale or a purchase return is handled on its own screen
    steps: (row) => (row.source_entity_type === 'PHARMACY_STOCK_ISSUE' && ['ISSUED', 'REQUESTED'].includes(row.status)
      ? [{ label: 'Confirm', kind: 'main', path: `issues/${row.stock_document_id}/confirm`, done: 'confirmed' },
        { label: 'Cancel', kind: 'danger', path: `issues/${row.stock_document_id}/cancel`, done: 'cancelled', reason: true }]
      : []),
    quantityHeader: 'Qty', quantity: (row) => plain(row.quantity_total),
    before: [{ header: 'Type', cell: (row) => KIND[row.source_entity_type ?? ''] ?? '--' }],
  },
  transfers: {
    key: 'transfers', title: 'Stock transfers', number: 'Document no.', stockType: 'STOCK_TRANSFER', places: 'from-to', forms: ['transfer'],
    // a pending transfer has moved no stock: Dispatch takes it into transit, Receive lands it
    steps: (row) => (row.status === 'PENDING'
      ? [{ label: 'Dispatch', kind: 'main', path: `transfer/${row.stock_document_id}/dispatch`, done: 'dispatched' },
        { label: 'Cancel', kind: 'danger', path: `transfer/${row.stock_document_id}/cancel`, done: 'cancelled' }]
      : row.status === 'IN_TRANSIT'
        ? [{ label: 'Receive', kind: 'main', path: `transfer/${row.stock_document_id}/receive`, done: 'received' },
          { label: 'Cancel', kind: 'danger', path: `transfer/${row.stock_document_id}/cancel`, done: 'cancelled' }]
        : []),
    quantityHeader: 'Requested / transferred', quantity: (row) => `${plain(row.requested_quantity_total)} / ${plain(row.quantity_total)}`,
    after: [receivedOn],
  },
  receipts: {
    key: 'receipts', title: 'Stock receipts', number: 'Document no.', stockType: 'STOCK_TRANSFER', places: 'from-to', fixed: { received_only: 'true' },
    quantityHeader: 'Received qty', quantity: (row) => plain(row.received_quantity_total ?? row.quantity_total),
    after: [receivedOn],
  },
  requests: {
    key: 'requests', title: 'Stock requests', number: 'Request no.', stockType: 'STOCK_INDENT', places: 'from-to',
    quantityHeader: 'Qty', quantity: (row) => plain(row.requested_quantity_total ?? row.quantity_total), after: [notes], forms: ['request'],
    steps: (row) => (row.status === 'REQUESTED'
      ? [{ label: 'Issue', kind: 'main', path: 'fulfil', done: '' },
        { label: 'Cancel', kind: 'danger', path: `indent/${row.stock_document_id}/cancel`, done: 'cancelled' }]
      : []),
  },
  'internal-issues': {
    key: 'internal-issues', title: 'Internal stock issue history', number: 'Issue no.', stockType: 'INTERNAL_ISSUE', places: 'from-to',
    quantityHeader: 'Qty / returned', quantity: (row) => `${plain(row.issued_quantity_total ?? row.quantity_total)} / ${plain(row.returned_quantity_total)}`,
    before: [reference], after: [value('Net amount')], forms: ['internal-issue'],
    // a pending issue has moved no stock; once issued, stock can come back from it
    steps: (row) => (row.status === 'PENDING'
      ? [{ label: 'Issue', kind: 'main', path: `internal-issues/${row.stock_document_id}/issue`, done: 'issued' },
        { label: 'Cancel', kind: 'danger', path: `internal-issues/${row.stock_document_id}/cancel`, done: 'cancelled', reason: true }]
      : ['ISSUED', 'PARTIALLY_RETURNED'].includes(row.status) ? [{ label: 'Return', kind: 'main', path: 'return', done: '' }] : []),
  },
  'internal-issue-returns': {
    key: 'internal-issue-returns', title: 'Internal stock issue returns', number: 'Return no.', stockType: 'INTERNAL_ISSUE_RETURN', places: 'from-to',
    quantityHeader: 'Qty', quantity: (row) => plain(row.quantity_total), before: [reference], after: [value('Net amount')],
    actions: <Button variant="default" component={Link} to="/stock/internal-stock-issue-history">Internal issues</Button>,
  },
  adjustments: {
    key: 'adjustments', title: 'Stock adjustments', number: 'Adjustment no.', stockType: 'STOCK_ADJUSTMENT', places: 'one',
    quantityHeader: 'Qty change', quantity: (row) => plain(row.quantity_total), after: [value('Value')], forms: ['adjustment', 'write-off'],
    actions: <Button variant="default" component={Link} to="/stock/stock-write-offs">Write-offs</Button>,
    steps: (row) => (row.status === 'PENDING'
      ? [{ label: 'Approve', kind: 'main', path: `adjustments/${row.stock_document_id}/approve`, done: 'approved' },
        { label: 'Reject', kind: 'danger', path: `adjustments/${row.stock_document_id}/reject`, done: 'rejected' }]
      : []),
  },
  'write-offs': {
    key: 'write-offs', title: 'Stock write-offs', number: 'Write-off no.', stockType: 'WRITE_OFF', places: 'one',
    quantityHeader: 'Qty', quantity: (row) => plain(row.quantity_total), after: [value('Value')], forms: ['write-off'],
    actions: <Button variant="default" component={Link} to="/stock/stock-adjustments">Adjustments</Button>,
    steps: (row) => (row.status === 'PENDING'
      ? [{ label: 'Approve', kind: 'main', path: `write-off/${row.stock_document_id}/approve`, done: 'approved' },
        { label: 'Reject', kind: 'danger', path: `write-off/${row.stock_document_id}/reject`, done: 'rejected' }]
      : []),
  },
  relocations: {
    key: 'relocations', title: 'Stock relocation', number: 'Relocation no.', stockType: 'STOCK_RELOCATION', places: 'from-to',
    quantityHeader: 'Qty', quantity: (row) => plain(row.quantity_total), after: [notes], forms: ['relocation'],
    // a pending relocation has moved nothing yet
    steps: (row) => (row.status === 'PENDING'
      ? [{ label: 'Confirm', kind: 'main', path: `relocations/${row.stock_document_id}/confirm`, done: 'confirmed' },
        { label: 'Cancel', kind: 'danger', path: `relocations/${row.stock_document_id}/cancel`, done: 'cancelled' }]
      : []),
  },
  counts: {
    key: 'counts', title: 'Physical stock history', number: 'Count no.', stockType: 'PHYSICAL_COUNT', places: 'one',
    quantityHeader: 'Counted / in the book', quantity: (row) => `${plain(row.quantity_total)} / ${row.status === 'DRAFT' ? '--' : plain(row.requested_quantity_total)}`,
    after: [{ header: 'Difference value', align: 'right', cell: (row) => (row.status === 'POSTED' ? money(row.net_amount_cents) : '--') }],
    openAt: (row) => `/stock/physical-stock?count=${row.stock_document_id}`,
    actions: <Button component={Link} to="/stock/physical-stock">Physical stock</Button>,
  },
}

export function StockRegister({ register }: { register: Register }) {
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [viewing, setViewing] = useState<Row | null>(null)
  const [printing, setPrinting] = useState(false)
  const [making, setMaking] = useState<FormKind | null>(null)
  const confirm = useConfirm() // every step asks first
  const [opened, setOpened] = useState<{ row: Row; form: 'return' | 'fulfil' } | null>(null) // a step's own form
  const queryClient = useQueryClient()
  const run = useMutation({
    mutationFn: async (job: { row: Row; step: Step; reason: string }) => {
      const reply = await api<{ ok?: boolean; status?: string; message?: string }>(`/pharmacy/api/stock/${job.step.path}`, 'POST', job.step.reason ? { reason: job.reason } : {})
      // DocAssist's newer endpoints answer 200 with a flag instead of an error code
      if (reply.ok === false || reply.status === 'error') throw new Error(reply.message || 'Could not do that. Try again.')
    },
    onSuccess: (_, job) => {
      notifySuccess(`${job.row.stock_number} ${job.step.done}.`)
      return Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-documents'] }), queryClient.invalidateQueries({ queryKey: ['overall-stock'] })])
    },
  })

  const asked = { stock_type: register.stockType, ...register.fixed, ...filters, q }
  const chosen = new URLSearchParams(asked)
  const query = new URLSearchParams({ ...asked, limit: String(pageSize), offset: String((page - 1) * pageSize) })
  const list = useQuery({
    queryKey: ['stock-documents', query.toString()],
    queryFn: () => api<DocPage>(`${URL}?${query}`),
    placeholderData: keepPreviousData,
  })
  function setFilter(name: string, chosenValue: string | null) {
    const next = { ...filters }
    if (chosenValue) next[name] = chosenValue
    else delete next[name]
    setFilters(next)
    setPage(1)
  }
  const locations = list.data?.locations ?? []
  const fromTo = register.places === 'from-to'
  const places: Column<Row>[] = fromTo
    ? [{ header: 'From location', cell: (row) => row.from_location_name || '--' }, { header: 'To location', cell: place }]
    : [{ header: 'Location', cell: (row) => row.from_location_name || place(row) }]

  const columns: Column<Row>[] = [
    {
      header: register.number,
      cell: (row) => (register.openAt
        ? <Anchor component={Link} to={register.openAt(row)} size="sm" fw={500} c="bottle.7">{row.stock_number || '--'}</Anchor>
        : <Anchor component="button" type="button" size="sm" fw={500} c="bottle.7" onClick={() => setViewing(row)}>{row.stock_number || '--'}</Anchor>),
    },
    { header: 'Date', cell: (row) => day(row.document_date) },
    ...(register.before ?? []),
    ...places,
    { header: 'Products', align: 'right', cell: (row) => plain(row.product_count) },
    { header: register.quantityHeader, align: 'right', cell: register.quantity },
    ...(register.after ?? []),
    { header: 'User', cell: (row) => row.creator_name || '--' },
    { header: 'Status', cell: (row) => <StatusBadge status={words(row.status)} /> },
    ...(register.steps ? [{
      header: 'Actions', align: 'right',
      cell: (row: Row) => (
        <RowActions name={row.stock_number ?? undefined} actions={register.steps!(row).map((step) => ({
          label: step.label, kind: step.kind,
          // a step with its own form opens it; every other step asks first, and the dialog waits for the answer
          onClick: () => (step.path === 'return' || step.path === 'fulfil' ? setOpened({ row, form: step.path })
            : confirm.ask({ action: step.label, subject: row.stock_number ?? '', danger: step.kind === 'danger', reason: step.reason,
              note: step.kind === 'danger' ? 'This cannot be undone here.' : undefined, run: (reason) => run.mutateAsync({ row, step, reason }) })),
        }))} />
      ),
    } as Column<Row>] : []),
  ]
  const headers = [register.number, 'Date', 'From location', 'To location', 'Products', register.quantityHeader, 'User', 'Notes', 'Status']

  async function print() {
    setPrinting(true)
    try {
      const all = await api<DocPage>(`${URL}?${chosen}&output=all`)
      printTable(register.title, headers, all.rows.map((row) => [
        row.stock_number ?? '', day(row.document_date), row.from_location_name ?? '', place(row), plain(row.product_count),
        register.quantity(row), row.creator_name ?? '', row.notes ?? '', words(row.status),
      ]))
    } catch (error) {
      notifyFailure(error as Error)
    } finally {
      setPrinting(false)
    }
  }
  const location = (name: string, label: string) => (
    <Select label={label} placeholder="All locations" data={locations} value={filters[name] ?? null} onChange={(v) => setFilter(name, v)} clearable searchable />
  )

  const header = (
    <>
      <PageHeader
        title={register.title}
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`${URL}?${chosen}&output=csv`}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} loading={printing} onClick={print}>Print</Button>
            {register.actions}
            {register.forms?.map((kind, index) => (
              <Button key={kind} variant={index === 0 ? 'filled' : 'default'} leftSection={<IconPlus size={16} />} onClick={() => setMaking(kind)}>{FORM_NAME[kind]}</Button>
            ))}
          </>
        }
      >
        <Facts items={[
          { label: 'Documents', value: list.data?.total ?? '--' },
          { label: 'Products', value: list.data?.product_count_total ?? '--' },
          { label: 'Quantity', value: plain(list.data?.quantity_total) },
        ]} />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4, lg: 7 }}>
          <TextInput label={register.number} placeholder="Search by number" leftSection={<IconSearch size={16} />} maxLength={60} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput label="From date" type="date" value={filters.from_date ?? ''} onChange={(e) => setFilter('from_date', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.to_date ?? ''} onChange={(e) => setFilter('to_date', e.currentTarget.value)} />
          <Select label="Status" placeholder="All" data={(list.data?.statuses ?? []).map((s) => ({ value: s, label: words(s) }))} value={filters.status ?? null} onChange={(v) => setFilter('status', v)} clearable />
          {register.kinds && <Select label="Type" placeholder="All types" data={Object.entries(KIND).map(([kind, label]) => ({ value: kind, label }))} value={filters.kind ?? null} onChange={(v) => setFilter('kind', v)} clearable />}
          {fromTo ? location('from_location_id', 'From location') : location('location_id', 'Location')}
          {fromTo && location('to_location_id', 'To location')}
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
        empty={list.isError
          ? <EmptyState title="Could not load this register." hint={list.error.message} />
          : <EmptyState title={`No ${register.title.toLowerCase()} found.`} hint="Change the dates or the filters." />}
        footer={<Pager page={page} pageSize={pageSize} total={list.data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(size) => { setPageSize(size); setPage(1) }} />}
      />
      {(making === 'issue' || making === 'transfer') && <StockMoveForm kind={making} onClose={() => setMaking(null)} />}
      {making === 'request' && <StockRequestForm onClose={() => setMaking(null)} />}
      {making === 'relocation' && <RelocationForm onClose={() => setMaking(null)} />}
      {making === 'internal-issue' && <InternalIssueForm onClose={() => setMaking(null)} />}
      {opened?.form === 'return' && <IssueReturnForm id={opened.row.stock_document_id} number={opened.row.stock_number ?? ''} onClose={() => setOpened(null)} />}
      {opened?.form === 'fulfil' && <RequestFulfilForm id={opened.row.stock_document_id} number={opened.row.stock_number ?? ''} onClose={() => setOpened(null)} />}
      {making === 'adjustment' && <AdjustmentForm onClose={() => setMaking(null)} />}
      {making === 'write-off' && <WriteOffForm onClose={() => setMaking(null)} />}
      {confirm.dialog}
      {viewing && <StockDocumentView id={viewing.stock_document_id} title={register.number.replace(/ no\.$/, '')} subject={viewing.stock_number ?? ''} onClose={() => setViewing(null)} />}
    </Page>
  )
}

/** One stock document, read only. Quantity columns with nothing in them on any line are left out. */
export function StockDocumentView({ id, title, subject, onClose }: { id: number; title: string; subject: string; onClose: () => void }) {
  const found = useQuery({ queryKey: ['stock-document', id], queryFn: () => api<Doc>(`${URL}/${id}`) })
  const doc = found.data
  const quantity = (header: string, pick: (line: Line) => string | null | undefined): Column<Line>[] =>
    (doc?.lines.some((line) => Number(pick(line) ?? 0) !== 0) ? [{ header, align: 'right', cell: (line) => plain(pick(line)) }] : [])
  const columns: Column<Line>[] = [
    { header: 'Product', cell: (line) => <><Text size="sm" fw={500}>{line.description}</Text><Text size="xs" c="dimmed">{[line.rack_code, line.bin_code].filter(Boolean).join(' / ')}</Text></> },
    { header: 'Batch / expiry', cell: (line) => `${line.batch_number || '--'}, ${day(line.expiry_date)}` },
    ...quantity('Requested', (line) => line.requested_quantity),
    ...quantity('Transferred', (line) => line.transfer_quantity),
    ...quantity('Issued', (line) => line.issued_quantity),
    ...quantity('Received', (line) => line.received_quantity),
    ...quantity('Returned', (line) => line.return_quantity),
    { header: 'MRP', align: 'right', cell: (line) => money(line.unit_mrp_cents) },
    { header: 'Net', align: 'right', cell: (line) => money(line.net_amount_cents) },
    { header: 'Reason', cell: (line) => line.reason || '--' },
    { header: 'Status', cell: (line) => (line.line_status ? <StatusBadge status={words(line.line_status)} /> : '--') },
  ]
  return (
    <SidePanel title={title} subject={subject} badge={doc && <StatusBadge status={words(doc.status)} />} size={1080} onClose={onClose} loading={found.isPending} error={found.error}>
      {doc && (
        <Stack gap="md">
          <Facts items={[
            { label: 'Date', value: day(doc.document_date) },
            { label: 'User', value: doc.creator_name ?? '--' },
            { label: 'From location', value: doc.from_location_name ?? '--' },
            { label: 'To location', value: place(doc) },
            ...(doc.department_name ? [{ label: 'Department', value: doc.department_name }] : []),
            ...(doc.referral_doctor_name ? [{ label: 'Referral doctor', value: doc.referral_doctor_name }] : []),
            ...(doc.reference_number ? [{ label: 'Reference no.', value: doc.reference_number }] : []),
            ...(doc.received_at ? [{ label: 'Received on', value: stamp(doc.received_at) }] : []),
            { label: 'Net amount', value: money(doc.net_amount_cents) },
            ...(doc.notes ? [{ label: 'Notes', value: doc.notes }] : []),
          ]} />
          <DataTable columns={columns} rows={doc.lines} rowKey={(line) => line.stock_item_id} empty={<EmptyState title="This document has no lines." />} />
        </Stack>
      )}
    </SidePanel>
  )
}
