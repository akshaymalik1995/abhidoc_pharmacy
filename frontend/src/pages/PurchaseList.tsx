import { Anchor, Button, Group, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPlus, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import { GoodsReceiptForm, PurchaseReturnForm } from './PurchaseActions'
import { PurchaseOrderForm } from './PurchaseOrderForm'
import {
  DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, Page, PageHeader, Pager, plain, printTable,
  RowActions, SidePanel, StatusBadge, type Column,
} from '../ui'

type DocumentPage = components['schemas']['DocumentPage']
type Row = components['schemas']['DocumentRow']
type Document = components['schemas']['Document']

export type Kind = 'orders' | 'receipts' | 'returns'
const TITLE: Record<Kind, string> = { orders: 'Purchase orders', receipts: 'Goods receipts', returns: 'Purchase returns' }
const URL = '/api/purchase/documents'
const PAGE_SIZE = 25
const NO_FILTERS: Record<string, string> = {}

/** A stored code in plain words (PENDING_APPROVAL -> Pending approval); anything that is not a code (a document number) stays as it is. */
export const words = (code: string | null | undefined) =>
  code === 'DIRECT_PO' ? 'Direct PO' : !/^[A-Z_]+$/.test(code ?? '') || ABBREVIATIONS.has(code ?? '') ? code ?? ''
    : (code ?? '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
// codes that are names in their own right and read as they are written
const ABBREVIATIONS = new Set(['UPI', 'EFT', 'RTGS', 'NEFT', 'IMPS', 'OP', 'IP', 'MRN', 'GST', 'HSN'])

export function PurchaseList({ kind }: { kind: Kind }) {
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  // the Dashboard opens the order list on its open orders: ?status=ALL_OPEN
  const [address] = useSearchParams()
  const [filters, setFilters] = useState<Record<string, string>>(address.get('status') ? { status: address.get('status')! } : NO_FILTERS)
  const [page, setPage] = useState(1)
  const [viewing, setViewing] = useState<Row | null>(null)
  const [printing, setPrinting] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [acting, setActing] = useState<Row | null>(null) // the order being received, or the receipt being returned
  // the Reports summary opens a near-expiry batch's purchase return here: ?return=<goods receipt id>
  const navigate = useNavigate()
  const asked = kind === 'receipts' ? Number(address.get('return')) || 0 : 0

  const chosen = new URLSearchParams({ kind, ...filters, q })
  const query = new URLSearchParams({ kind, ...filters, q, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
  const list = useQuery({
    queryKey: ['purchase-documents', query.toString()],
    queryFn: () => api<DocumentPage>(`${URL}?${query}`),
    placeholderData: keepPreviousData,
  })

  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }

  async function print() {
    setPrinting(true)
    try {
      const all = await api<DocumentPage>(`${URL}?${chosen}&output=all`)
      printTable(
        TITLE[kind],
        ['Number', 'Date', 'Supplier', 'Type', 'Status', 'Quantity', 'Received', 'Net amount'],
        all.rows.map((row) => [
          row.purchase_number ?? '', day(row.document_date), row.supplier_name ?? '', words(row.purchase_type),
          words(row.status), plain(row.quantity_total), plain(row.received_quantity_total), money(row.net_amount_cents),
        ]),
      )
    } catch (error) {
      notifyFailure(error as Error)
    } finally {
      setPrinting(false)
    }
  }

  const columns: Column<Row>[] = [
    {
      header: 'Number',
      cell: (row) => <Anchor component="button" type="button" size="sm" fw={500} c="bottle.7" onClick={() => setViewing(row)}>{row.purchase_number || '--'}</Anchor>,
    },
    { header: 'Date', cell: (row) => day(row.document_date) },
    { header: 'Supplier', cell: (row) => row.supplier_name || '--' },
    { header: 'Type', cell: (row) => words(row.purchase_type) },
    { header: 'Status', cell: (row) => <StatusBadge status={words(row.status)} /> },
    { header: 'Products', align: 'right', cell: (row) => plain(row.product_count) },
    { header: 'Quantity', align: 'right', cell: (row) => plain(row.quantity_total) },
    ...(kind === 'returns' ? [] : [{ header: 'Received', align: 'right', cell: (row: Row) => plain(row.received_quantity_total) } as Column<Row>]),
    { header: 'Net amount', align: 'right', cell: (row) => <Text size="sm" fw={600}>{money(row.net_amount_cents)}</Text> },
    ...(kind === 'receipts' ? [{ header: 'Outstanding', align: 'right', cell: (row: Row) => money(row.outstanding_amount_cents) } as Column<Row>] : []),
    ...(kind === 'returns' ? [] : [{
      header: 'Actions', align: 'right',
      cell: (row: Row) => {
        if (kind === 'orders' && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(row.status)) return <RowActions actions={[{ label: 'Receive', kind: 'main', onClick: () => setActing(row) }]} />
        if (kind === 'receipts' && row.purchase_type === 'GOODS_RECEIPT' && Number(row.received_quantity_total) > Number(row.returned_quantity_total)) return <RowActions actions={[{ label: 'Return', kind: 'main', onClick: () => setActing(row) }]} />
        return null
      },
    } as Column<Row>]),
  ]
  const summary = list.data?.summary

  const header = (
    <>
      <PageHeader
        title={TITLE[kind]}
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`${URL}?${chosen}&output=csv`}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} loading={printing} onClick={print}>Print</Button>
            {kind === 'orders' && <Button leftSection={<IconPlus size={16} />} onClick={() => setOrdering(true)}>New direct PO</Button>}
          </>
        }
      >
        <Facts
          items={[
            { label: 'Open purchase orders', value: summary?.open_po_count ?? '--' },
            { label: 'Wanted list lines', value: summary?.wanted_line_count ?? '--' },
            { label: 'Pending receipts', value: summary?.pending_receipt_count ?? '--' },
            { label: 'Payable to suppliers', value: money(summary?.supplier_payable_cents) },
          ]}
        />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }}>
          <TextInput label="Number" placeholder="Search by number" leftSection={<IconSearch size={16} />} maxLength={60}
            value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput label="From date" type="date" value={filters.from_date ?? ''} onChange={(e) => setFilter('from_date', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.to_date ?? ''} onChange={(e) => setFilter('to_date', e.currentTarget.value)} />
          <Select label="Supplier" placeholder="All suppliers" data={list.data?.suppliers ?? []} value={filters.supplier_id ?? null}
            onChange={(value) => setFilter('supplier_id', value)} clearable searchable />
          <Select label="Status" placeholder="All statuses" data={[...(kind === 'orders' ? [{ value: 'ALL_OPEN', label: 'Open' }] : []), ...(list.data?.statuses ?? []).map((s) => ({ value: s, label: words(s) }))]}
            value={filters.status ?? null} onChange={(value) => setFilter('status', value)} clearable />
        </SimpleGrid>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(row) => row.purchase_document_id}
        view={query.toString()}
        loading={list.isFetching}
        empty={list.isError
          ? <EmptyState title="Could not load this list." hint={list.error.message} />
          : <EmptyState title={`No ${TITLE[kind].toLowerCase()} found.`} hint="Change the dates or the filters." />}
        footer={<Pager page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />}
      />
      {acting && kind === 'orders' && <GoodsReceiptForm id={acting.purchase_document_id} onClose={() => setActing(null)} />}
      {acting && kind === 'receipts' && <PurchaseReturnForm id={acting.purchase_document_id} onClose={() => setActing(null)} />}
      {!acting && asked > 0 && <PurchaseReturnForm id={asked} onClose={() => navigate('/purchase/goods-receipts', { replace: true })} />}
      {ordering && <PurchaseOrderForm onClose={() => setOrdering(false)} />}
      {viewing && <DocumentView id={viewing.purchase_document_id} title={words(viewing.purchase_type)} subject={viewing.purchase_number ?? ''} onClose={() => setViewing(null)} />}
    </Page>
  )
}

/** One purchase document, read only. */
function DocumentView({ id, title, subject, onClose }: { id: number; title: string; subject: string; onClose: () => void }) {
  const found = useQuery({ queryKey: ['purchase-document', id], queryFn: () => api<Document>(`${URL}/${id}`) })
  const doc = found.data
  const columns: Column<Document['lines'][number]>[] = [
    { header: 'Product', cell: (line) => <><Text size="sm" fw={500}>{line.description}</Text><Text size="xs" c="dimmed">{[line.batch_number && `Batch ${line.batch_number}`, line.expiry_date && day(line.expiry_date), line.purchase_order_reason].filter(Boolean).join(', ')}</Text></> },
    { header: 'Ordered', align: 'right', cell: (line) => plain(line.ordered_quantity) },
    { header: 'Received', align: 'right', cell: (line) => plain(line.received_quantity) },
    { header: 'Returned', align: 'right', cell: (line) => plain(line.returned_quantity) },
    { header: 'Unit cost', align: 'right', cell: (line) => money(line.unit_cost_cents) },
    { header: 'MRP', align: 'right', cell: (line) => money(line.unit_mrp_cents) },
    { header: 'Gross', align: 'right', cell: (line) => money(line.gross_amount_cents) },
    { header: 'Discount', align: 'right', cell: (line) => money(line.discount_amount_cents) },
    { header: 'GST %', align: 'right', cell: (line) => plain(line.tax_percent) },
    { header: 'GST', align: 'right', cell: (line) => money(line.tax_amount_cents) },
    { header: 'Net', align: 'right', cell: (line) => <Text size="sm" fw={600}>{money(line.net_amount_cents)}</Text> },
  ]

  return (
    <SidePanel onClose={onClose} size={1080} title={title} subject={subject} badge={doc && <StatusBadge status={words(doc.status)} />}
      loading={found.isPending} error={found.error}>
      {doc && (
        <Stack gap="md">
          <Facts
            items={[
              { label: 'Supplier', value: doc.supplier_name ?? '--' },
              { label: 'Date', value: day(doc.document_date) },
              ...(doc.expected_date ? [{ label: 'Expected', value: day(doc.expected_date) }] : []),
              { label: 'Location', value: doc.location_name ?? '--' },
              ...(doc.supplier_invoice_number ? [{ label: 'Supplier invoice', value: `${doc.supplier_invoice_number}${doc.supplier_invoice_date ? `, ${day(doc.supplier_invoice_date)}` : ''}` }] : []),
              ...(doc.original_purchase_number ? [{ label: 'Returned from', value: doc.original_purchase_number }] : []),
            ]}
          />
          {doc.notes && <Text size="sm" c="dimmed">{doc.notes}</Text>}
          <DataTable columns={columns} rows={doc.lines} rowKey={(line) => line.purchase_item_id} empty={<EmptyState title="This document has no lines." />} />
          <Group justify="flex-end">
            <Table w={320} withRowBorders={false} verticalSpacing={4} highlightOnHover={false}>
              <Table.Tbody>
                {([['Gross', doc.gross_amount_cents], ['Discount', doc.discount_amount_cents], ['GST', doc.tax_amount_cents]] as const).map(([label, cents]) => (
                  <Table.Tr key={label}><Table.Td c="dimmed">{label}</Table.Td><Table.Td ta="right">{money(cents)}</Table.Td></Table.Tr>
                ))}
                <Table.Tr><Table.Td fw={600}>Net</Table.Td><Table.Td ta="right" fw={600}>{money(doc.net_amount_cents)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Paid</Table.Td><Table.Td ta="right">{money(doc.paid_amount_cents)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Outstanding</Table.Td><Table.Td ta="right">{money(doc.outstanding_amount_cents)}</Table.Td></Table.Tr>
              </Table.Tbody>
            </Table>
          </Group>
        </Stack>
      )}
    </SidePanel>
  )
}
