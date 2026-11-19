/** Consignment: stock a supplier leaves with the pharmacy and is paid for only when it sells.
 * Three screens: receipts, returns and the consignment stock. All of it changes stock, so every read and save
 * here goes through DocAssist, whose consignment endpoints answer 200 with an `ok` flag. */
import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPlus, IconPrinter, IconSearch, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api, contract } from '../api'
import type { components } from '../api-types'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import { useWorkLocation } from '../session'
import {
  type Column, DataTable, day, downloadCsv, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, Pager, plain, printTable, RowActions, SaveButton, SidePanel, StatusBadge, useConfirm,
} from '../ui'
import { words } from './PurchaseList'

type Choice = components['schemas']['Choice']
type Kind = 'receipts' | 'returns'

interface Doc {
  purchase_document_id: number
  purchase_number: string
  purchase_type: string
  status: string
  document_date: string | null
  supplier_id?: number
  supplier_name: string | null
  location_name: string | null
  supplier_invoice_number: string | null
  supplier_invoice_date?: string | null
  original_consignment_number: string | null
  return_type: string | null
  purchase_included: string | null
  product_count: number | null
  quantity_total: string | null
  free_quantity_total: string | null
  gross_amount_cents?: number
  discount_amount_cents?: number
  tax_amount_cents?: number
  net_amount_cents: number | null
  confirmed_user: string | { name?: string } | null
  confirmed_at: string | null
  cancel_reason?: string | null
  notes: string | null
}
interface DocLine {
  line_number: number
  source_item_id?: number
  item_id?: number
  item_name: string | null
  description: string | null
  batch_number: string | null
  expiry_date: string | null
  ordered_quantity: string
  free_quantity: string
  unit_cost_cents: number
  unit_mrp_cents: number
  discount_percent: string
  tax_percent: string
  net_amount_cents: number
  line_status: string
}

const person = (who: Doc['confirmed_user']) => (typeof who === 'string' ? who : who?.name) || '--'
const stamp = (value: string | null) => (value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--')
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA')
const START = () => ({ date_from: daysAgo(30), date_to: daysAgo(0) })
const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: () => api<Choice[]>('/api/purchase/suppliers'), staleTime: 60_000 })

const NAMES = {
  receipts: { title: 'Consignment receipts', one: 'consignment receipt', number: 'Consignment no.', type: 'CONSIGNMENT_RECEIPT', statuses: ['DRAFT', 'CONFIRMED', 'INVOICED', 'CANCELLED'] },
  returns: { title: 'Consignment returns', one: 'consignment return', number: 'Return no.', type: 'CONSIGNMENT_RETURN', statuses: ['DRAFT', 'RETURNED', 'CANCELLED'] },
}

export function ConsignmentList({ kind }: { kind: Kind }) {
  const names = NAMES[kind]
  const queryClient = useQueryClient()
  const { locations } = useWorkLocation()
  const suppliers = useSuppliers()
  const [filters, setFilters] = useState<Record<string, string>>(START)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [viewing, setViewing] = useState<number | null>(null)
  const [intake, setIntake] = useState<null | { against?: number }>(null)
  const confirm = useConfirm()

  const asked = (limit: number, offset: number) => {
    const params = new URLSearchParams({ ...filters, consignment_type: names.type, limit: String(limit), offset: String(offset) })
    if (q) params.set('q', q)
    return params
  }
  const query = asked(pageSize, (page - 1) * pageSize)
  const list = useQuery({
    queryKey: ['consignments', query.toString()],
    queryFn: () => contract<{ rows: Doc[]; total: number }>(`/pharmacy/api/consignments?${query}`),
    placeholderData: keepPreviousData,
  })
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['consignments'] }), queryClient.invalidateQueries({ queryKey: ['consignment'] })])

  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }

  const act = useMutation({
    mutationFn: (step: { doc: Doc; action: 'confirm' | 'cancel'; reason?: string }) => {
      const base = step.action === 'confirm' && step.doc.purchase_type === 'CONSIGNMENT_RETURN' ? 'consignment-returns' : 'consignments'
      return contract(`/pharmacy/api/${base}/${step.doc.purchase_document_id}/${step.action}`, 'POST', step.action === 'cancel' ? { reason: step.reason } : {})
    },
    onSuccess: (_, step) => { notifySuccess(`${step.doc.purchase_number} ${step.action === 'confirm' ? 'confirmed' : 'cancelled'}.`); return refresh() },
  })

  const columns: Column<Doc>[] = [
    {
      header: names.number,
      cell: (doc) => (
        <>
          <Text size="sm" fw={500}>{doc.purchase_number}</Text>
          <Text size="xs" c="dimmed">{kind === 'returns' ? `against ${doc.original_consignment_number || '--'}` : `challan ${doc.supplier_invoice_number || '--'}`}</Text>
        </>
      ),
    },
    ...(kind === 'returns' ? [{ header: 'Return type', cell: (doc: Doc) => words(doc.return_type) || '--' } as Column<Doc>] : []),
    { header: 'Date', cell: (doc) => day(doc.document_date?.slice(0, 10)) },
    { header: 'Supplier / location', cell: (doc) => <><Text size="sm">{doc.supplier_name || '--'}</Text><Text size="xs" c="dimmed">{doc.location_name}</Text></> },
    { header: 'Status', cell: (doc) => <><StatusBadge status={words(doc.status)} />{kind === 'receipts' && <Text size="xs" c="dimmed">in purchase: {String(doc.purchase_included).toUpperCase() === 'YES' ? 'yes' : 'no'}</Text>}</> },
    { header: 'Products', align: 'right', cell: (doc) => plain(doc.product_count) },
    { header: kind === 'receipts' ? 'Qty / free' : 'Qty', align: 'right', cell: (doc) => (kind === 'receipts' ? `${plain(doc.quantity_total)} / ${plain(doc.free_quantity_total)}` : plain(doc.quantity_total)) },
    { header: 'Net', align: 'right', cell: (doc) => <Text size="sm" fw={600}>{money(doc.net_amount_cents)}</Text> },
    { header: 'Confirmed', cell: (doc) => (doc.confirmed_at ? <><Text size="sm">{person(doc.confirmed_user)}</Text><Text size="xs" c="dimmed">{stamp(doc.confirmed_at)}</Text></> : '--') },
    { header: 'Reason', cell: (doc) => doc.notes || '--' },
    {
      header: 'Actions', align: 'right',
      cell: (doc) => {
        const draft = doc.status === 'DRAFT'
        return (
          <RowActions name={doc.purchase_number} actions={[
            draft && { label: 'Confirm', kind: 'main', onClick: () => confirm.ask({ action: 'Confirm', subject: doc.purchase_number ?? '', run: () => act.mutateAsync({ doc, action: 'confirm' }) }) },
            { label: 'View', onClick: () => setViewing(doc.purchase_document_id) },
            kind === 'receipts' && !draft && doc.status !== 'CANCELLED' && { label: 'Return', onClick: () => setIntake({ against: doc.purchase_document_id }) },
            draft && { label: 'Cancel', kind: 'danger', onClick: () => confirm.ask({ action: 'Cancel', subject: doc.purchase_number ?? '', danger: true, reason: true,
              run: (reason) => act.mutateAsync({ doc, action: 'cancel', reason }) }) },
          ]} />
        )
      },
    },
  ]
  const headers = kind === 'receipts'
    ? ['Consignment no.', 'Supplier challan no.', 'Date', 'Supplier', 'Location', 'Status', 'In purchase', 'Products', 'Qty', 'Free', 'Net', 'Confirmed by', 'Confirmed on', 'Reason']
    : ['Return no.', 'Against consignment', 'Return type', 'Date', 'Supplier', 'Location', 'Status', 'Products', 'Qty', 'Net', 'Confirmed by', 'Confirmed on', 'Reason']
  const cells = (doc: Doc) => (kind === 'receipts'
    ? [doc.purchase_number, doc.supplier_invoice_number ?? '', day(doc.document_date?.slice(0, 10)), doc.supplier_name ?? '', doc.location_name ?? '', words(doc.status),
      words(doc.purchase_included), plain(doc.product_count), plain(doc.quantity_total), plain(doc.free_quantity_total), (doc.net_amount_cents ?? 0) / 100, person(doc.confirmed_user), stamp(doc.confirmed_at), doc.notes ?? '']
    : [doc.purchase_number, doc.original_consignment_number ?? '', words(doc.return_type), day(doc.document_date?.slice(0, 10)), doc.supplier_name ?? '', doc.location_name ?? '', words(doc.status),
      plain(doc.product_count), plain(doc.quantity_total), (doc.net_amount_cents ?? 0) / 100, person(doc.confirmed_user), stamp(doc.confirmed_at), doc.notes ?? ''])
  /** Every row of the filters, not only the page on screen. */
  async function everything() {
    const rows: Doc[] = []
    for (let turn = 0; turn < 100; turn++) {
      const reply = await contract<{ rows: Doc[]; total: number }>(`/pharmacy/api/consignments?${asked(200, rows.length)}`)
      rows.push(...reply.rows)
      if (!reply.rows.length || rows.length >= reply.total) break
    }
    return rows.map(cells)
  }
  const output = (send: (rows: (string | number)[][]) => void) => () => everything().then(send).catch(notifyFailure)

  const header = (
    <>
      <PageHeader
        title={names.title}
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} onClick={output((rows) => downloadCsv(`consignment_${kind}.csv`, headers, rows))}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={output((rows) => printTable(names.title, headers, rows))}>Print</Button>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setIntake({})}>New {names.one}</Button>
          </>
        }
      />
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 6 }}>
          <TextInput label={names.number} placeholder={`Enter ${names.number.toLowerCase()}`} leftSection={<IconSearch size={16} />} maxLength={60} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput label="From date" type="date" value={filters.date_from ?? ''} onChange={(e) => setFilter('date_from', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.date_to ?? ''} onChange={(e) => setFilter('date_to', e.currentTarget.value)} />
          <Select label="Supplier" placeholder="All suppliers" data={suppliers.data ?? []} value={filters.supplier_id ?? null} onChange={(v) => setFilter('supplier_id', v)} clearable searchable />
          <Select label="Status" placeholder="All statuses" data={names.statuses.map((s) => ({ value: s, label: words(s) }))} value={filters.status ?? null} onChange={(v) => setFilter('status', v)} clearable />
          <Select label="Location" placeholder="All locations" data={locations} value={filters.location_id ?? null} onChange={(v) => setFilter('location_id', v)} clearable searchable />
        </SimpleGrid>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(doc) => doc.purchase_document_id}
        loading={list.isFetching}
        view={query.toString()}
        empty={list.isError
          ? <EmptyState title="Could not load this list." hint={list.error.message} />
          : <EmptyState title={`No ${names.title.toLowerCase()} found.`} hint="The list starts with the last 30 days; change the dates or the filters." />}
        footer={<Pager page={page} pageSize={pageSize} total={list.data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(size) => { setPageSize(size); setPage(1) }} />}
      />
      {viewing && <ConsignmentView id={viewing} onClose={() => setViewing(null)} />}
      {intake && <Intake kind={intake.against ? 'returns' : kind} against={intake.against} onClose={() => setIntake(null)} onSaved={refresh} />}
      {confirm.dialog}
    </Page>
  )
}

function ConsignmentView({ id, onClose }: { id: number; onClose: () => void }) {
  const found = useQuery({ queryKey: ['consignment', id], queryFn: () => contract<{ consignment: Doc; rows: DocLine[] }>(`/pharmacy/api/consignments/${id}`) })
  const doc = found.data?.consignment
  const columns: Column<DocLine>[] = [
    { header: 'Product', cell: (line) => <Text size="sm" fw={500}>{line.item_name || line.description || '--'}</Text> },
    { header: 'Batch / expiry', cell: (line) => `${line.batch_number || '--'}, ${day(line.expiry_date?.slice(0, 10))}` },
    { header: 'Qty', align: 'right', cell: (line) => plain(line.ordered_quantity) },
    { header: 'Free', align: 'right', cell: (line) => plain(line.free_quantity) },
    { header: 'Unit cost', align: 'right', cell: (line) => money(line.unit_cost_cents) },
    { header: 'MRP', align: 'right', cell: (line) => money(line.unit_mrp_cents) },
    { header: 'Discount', align: 'right', cell: (line) => `${plain(line.discount_percent)}%` },
    { header: 'GST', align: 'right', cell: (line) => `${plain(line.tax_percent)}%` },
    { header: 'Net', align: 'right', cell: (line) => <Text size="sm" fw={600}>{money(line.net_amount_cents)}</Text> },
    { header: 'Status', cell: (line) => <StatusBadge status={words(line.line_status)} /> },
  ]
  return (
    <SidePanel title={doc?.purchase_type === 'CONSIGNMENT_RETURN' ? 'Consignment return' : 'Consignment'} subject={doc?.purchase_number}
      badge={doc && <StatusBadge status={words(doc.status)} />} size={1080} onClose={onClose} loading={found.isPending} error={found.error}>
      {doc && (
        <Stack gap="md">
          <Facts items={[
            { label: 'Supplier', value: doc.supplier_name ?? '--' },
            { label: 'Date', value: day(doc.document_date?.slice(0, 10)) },
            { label: 'Location', value: doc.location_name ?? '--' },
            { label: 'Supplier challan', value: [doc.supplier_invoice_number, doc.supplier_invoice_date && day(doc.supplier_invoice_date.slice(0, 10))].filter(Boolean).join(', ') || '--' },
            ...(doc.purchase_type === 'CONSIGNMENT_RETURN'
              ? [{ label: 'Return type', value: words(doc.return_type) || '--' }, { label: 'Against consignment', value: doc.original_consignment_number ?? '--' }]
              : [{ label: 'In purchase', value: String(doc.purchase_included).toUpperCase() === 'YES' ? 'Yes' : 'No' }]),
            { label: 'Confirmed', value: doc.confirmed_at ? `${person(doc.confirmed_user)}, ${stamp(doc.confirmed_at)}` : '--' },
            { label: 'Reason', value: doc.cancel_reason || doc.notes || '--' },
            { label: 'Gross / discount / tax', value: `${money(doc.gross_amount_cents)} / ${money(doc.discount_amount_cents)} / ${money(doc.tax_amount_cents)}` },
            { label: 'Net', value: money(doc.net_amount_cents) },
          ]} />
          <DataTable columns={columns} rows={found.data?.rows ?? []} rowKey={(line) => line.line_number} empty={<EmptyState title="No rows." />} />
        </Stack>
      )}
    </SidePanel>
  )
}

interface IntakeLine { key: number; product: OrderProduct | null; batch: string; expiry: string; quantity: string; free: string; unitCost: string; unitMrp: string; discount: string; tax: string }
let nextKey = 1
const emptyLine = (): IntakeLine => ({ key: nextKey++, product: null, batch: '', expiry: '', quantity: '', free: '', unitCost: '', unitMrp: '', discount: '', tax: '' })
const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100)
/** A line's amount in paise: cost less its discount, plus GST on what is left. */
function amount(line: IntakeLine) {
  const gross = paise(line.unitCost) * Number(line.quantity || 0)
  const taxable = gross * (1 - Number(line.discount || 0) / 100)
  return Math.round(taxable * (1 + Number(line.tax || 0) / 100))
}

/** New consignment receipt, or a return (optionally against one receipt, whose rows it starts from). */
function Intake(props: { kind: Kind; against?: number; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const returning = props.kind === 'returns'
  const { locations, locationId } = useWorkLocation()
  const suppliers = useSuppliers()
  const original = useQuery({
    queryKey: ['consignment', props.against],
    queryFn: () => contract<{ consignment: Doc; rows: DocLine[] }>(`/pharmacy/api/consignments/${props.against}`),
    enabled: Boolean(props.against),
  })
  const [head, setHead] = useState({ supplier_id: '', location_id: '', document_date: daysAgo(0), supplier_number: '', supplier_date: '', return_type: '', reason: '' })
  const [lines, setLines] = useState<IntakeLine[]>([emptyLine()])
  const [seeded, setSeeded] = useState(false)
  if (original.data && !seeded) {
    // a return against a receipt starts from that receipt's supplier and rows
    setSeeded(true)
    setHead({ ...head, supplier_id: String(original.data.consignment.supplier_id ?? '') })
    setLines(original.data.rows.map((row) => ({
      key: nextKey++, batch: row.batch_number ?? '', expiry: row.expiry_date?.slice(0, 10) ?? '', quantity: '', free: '',
      product: { item_id: Number(row.source_item_id ?? row.item_id), item_name: row.item_name || row.description || 'Product', unit_of_measure: null, tax_percent: row.tax_percent, last_cost_cents: null, last_mrp_cents: null },
      unitCost: String(row.unit_cost_cents / 100), unitMrp: String(row.unit_mrp_cents / 100), discount: plain(row.discount_percent), tax: plain(row.tax_percent),
    })))
  }
  const setField = (name: keyof typeof head, value: string) => setHead({ ...head, [name]: value })
  const setLine = (key: number, change: Partial<IntakeLine>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  // on a return, rows left without a quantity are simply not returned
  const used = returning ? lines.filter((line) => Number(line.quantity) > 0 || Number(line.free) > 0) : lines
  const bad = used.findIndex((line) => !line.product || !line.batch.trim() || !line.expiry || !(Number(line.quantity) > 0 || (returning && Number(line.free) > 0)))
  const problem = !head.supplier_id ? 'Select the supplier.'
    : !used.length ? 'Enter a quantity on at least one row.'
      : bad >= 0 ? `Row ${bad + 1}: select a product and enter its batch, expiry and a quantity above 0.`
        : returning && !head.return_type ? 'Select the return type.'
          : returning && !head.reason.trim() ? 'Enter the return reason.'
            : null

  const save = useMutation({
    mutationFn: () => contract<{ consignment_number?: string }>(returning ? '/pharmacy/api/consignment-returns' : '/pharmacy/api/consignments', 'POST', {
      consignment_type: returning ? 'CONSIGNMENT_RETURN' : 'CONSIGNMENT_RECEIPT',
      supplier_id: Number(head.supplier_id), document_date: head.document_date,
      location_id: Number(head.location_id || locationId), // not picked: the working location of the top bar
      ...(head.supplier_number.trim() ? { supplier_consignment_number: head.supplier_number.trim() } : {}),
      ...(head.supplier_date ? { supplier_invoice_date: head.supplier_date } : {}),
      ...(head.reason.trim() ? { reason: head.reason.trim() } : {}),
      ...(props.against ? { original_consignment_id: props.against } : {}),
      ...(returning ? { return_type: head.return_type } : {}),
      items: used.map((line) => ({
        item_id: line.product!.item_id, batch_number: line.batch.trim(), expiry_date: line.expiry, quantity: Number(line.quantity || 0),
        free_quantity: Number(line.free || 0), unit_cost_cents: paise(line.unitCost), unit_mrp_cents: paise(line.unitMrp),
        discount_percent: Number(line.discount || 0), tax_percent: Number(line.tax || 0),
      })),
    }),
    onSuccess: async (reply) => {
      await props.onSaved()
      notifySuccess(`${returning ? 'Consignment return' : 'Consignment receipt'} ${reply.consignment_number ?? ''} saved.`)
      props.onClose()
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }
  const box = (line: IntakeLine, name: 'quantity' | 'free' | 'unitCost' | 'unitMrp' | 'discount' | 'tax', label: string, scale: number) => (
    <NumberInput aria-label={label} size="xs" min={0} allowNegative={false} decimalScale={scale} hideControls value={line[name]}
      onChange={(value) => setLine(line.key, { [name]: String(value) })} styles={{ input: { textAlign: 'right' } }} />
  )

  return (
    <SidePanel title={`New ${NAMES[props.kind].one}${original.data ? ' against' : ''}`} subject={original.data?.consignment.purchase_number} size={1180}
      onClose={props.onClose} loading={suppliers.isPending || (Boolean(props.against) && original.isPending)} error={original.error}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            <Select label="Supplier" required placeholder="Select supplier" data={suppliers.data ?? []} value={head.supplier_id || null} onChange={(v) => setField('supplier_id', v ?? '')} searchable />
            <Select label="Location" data={locations} value={head.location_id || locationId} onChange={(v) => setField('location_id', v ?? '')} searchable />
            <TextInput label="Date" type="date" value={head.document_date} onChange={(e) => setField('document_date', e.currentTarget.value)} />
            <TextInput label="Supplier challan no." value={head.supplier_number} onChange={(e) => setField('supplier_number', e.currentTarget.value)} />
            <TextInput label="Supplier challan date" type="date" value={head.supplier_date} onChange={(e) => setField('supplier_date', e.currentTarget.value)} />
            {returning && (
              <Select label="Return type" required placeholder="Select return type" value={head.return_type || null} onChange={(v) => setField('return_type', v ?? '')}
                data={[{ value: 'UNSOLD', label: 'Unsold' }, { value: 'DAMAGED', label: 'Damaged' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'OTHER', label: 'Other' }]} />
            )}
            <TextInput label={returning ? 'Return reason' : 'Notes'} required={returning} value={head.reason} onChange={(e) => setField('reason', e.currentTarget.value)} style={{ gridColumn: 'span 2' }} />
          </SimpleGrid>
          <Table withTableBorder highlightOnHover={false}>
            <Table.Thead bg="gray.0">
              <Table.Tr>
                <Table.Th>Product</Table.Th><Table.Th w={130}>Batch</Table.Th><Table.Th w={150}>Expiry</Table.Th><Table.Th w={80} ta="right">Qty</Table.Th>
                <Table.Th w={70} ta="right">Free</Table.Th><Table.Th w={95} ta="right">Unit cost</Table.Th><Table.Th w={95} ta="right">MRP</Table.Th>
                <Table.Th w={80} ta="right">Discount %</Table.Th><Table.Th w={70} ta="right">GST %</Table.Th><Table.Th w={110} ta="right">Amount</Table.Th><Table.Th w={44} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((line) => (
                <Table.Tr key={line.key}>
                  <Table.Td>
                    <ProductPicker label="Product" value={line.product} onChange={(product) => setLine(line.key, {
                      product, tax: product ? plain(product.tax_percent) : line.tax,
                      unitCost: product?.last_cost_cents ? String(product.last_cost_cents / 100) : line.unitCost,
                      unitMrp: product?.last_mrp_cents ? String(product.last_mrp_cents / 100) : line.unitMrp,
                    })} />
                  </Table.Td>
                  <Table.Td><TextInput aria-label="Batch" size="xs" value={line.batch} onChange={(e) => setLine(line.key, { batch: e.currentTarget.value })} /></Table.Td>
                  <Table.Td><TextInput aria-label="Expiry" size="xs" type="date" value={line.expiry} onChange={(e) => setLine(line.key, { expiry: e.currentTarget.value })} /></Table.Td>
                  <Table.Td>{box(line, 'quantity', 'Quantity', 3)}</Table.Td>
                  <Table.Td>{box(line, 'free', 'Free quantity', 3)}</Table.Td>
                  <Table.Td>{box(line, 'unitCost', 'Unit cost', 2)}</Table.Td>
                  <Table.Td>{box(line, 'unitMrp', 'MRP', 2)}</Table.Td>
                  <Table.Td>{box(line, 'discount', 'Discount %', 3)}</Table.Td>
                  <Table.Td>{box(line, 'tax', 'GST %', 2)}</Table.Td>
                  <Table.Td ta="right" fw={600}>{money(amount(line))}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1} onClick={() => setLines(lines.filter((other) => other.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="space-between">
            <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, emptyLine()])}>Add row</Button>
            <Text fw={600}>Total {money(used.reduce((sum, line) => sum + amount(line), 0))}</Text>
          </Group>
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <SaveButton problem={problem} type="submit" loading={save.isPending}>Save {returning ? 'return' : 'receipt'}</SaveButton>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}

interface StockRow {
  location_name: string | null
  product: string | null
  batch_number: string | null
  expiry_date: string | null
  supplier_name: string | null
  consignment_quantity: string
  unit_cost_cents: number
  unit_mrp_cents: number
  consignment_value_cents: number
  last_movement_at: string | null
}

/** Consignment Stock: what of the suppliers' stock is on the shelves now. */
export function ConsignmentStock() {
  const { locations } = useWorkLocation()
  const suppliers = useSuppliers()
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [typed, setTyped] = useState({ product: '', batch_number: '' })
  const [text] = useDebouncedValue(typed, 300)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const asked = (limit: number, offset: number) => {
    const params = new URLSearchParams({ ...filters, days: '30', limit: String(limit), offset: String(offset) })
    if (text.product.trim()) params.set('product', text.product.trim())
    if (text.batch_number.trim()) params.set('batch_number', text.batch_number.trim())
    return params
  }
  const query = asked(pageSize, (page - 1) * pageSize)
  const stock = useQuery({
    queryKey: ['consignment-stock', query.toString()],
    queryFn: () => contract<{ rows: StockRow[]; total?: number; total_count?: number }>(`/pharmacy/api/reports/consignment_stock?${query}`),
    placeholderData: keepPreviousData,
  })
  const total = stock.data?.total ?? stock.data?.total_count ?? 0
  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }
  const columns: Column<StockRow>[] = [
    { header: 'Product', cell: (row) => <Text size="sm" fw={500}>{row.product}</Text> },
    { header: 'Location', cell: (row) => row.location_name || '--' },
    { header: 'Batch / expiry', cell: (row) => `${row.batch_number || '--'}, ${day(row.expiry_date?.slice(0, 10))}` },
    { header: 'Supplier', cell: (row) => row.supplier_name || '--' },
    { header: 'Qty', align: 'right', cell: (row) => <Text size="sm" fw={600}>{plain(row.consignment_quantity)}</Text> },
    { header: 'Unit cost', align: 'right', cell: (row) => money(row.unit_cost_cents) },
    { header: 'MRP', align: 'right', cell: (row) => money(row.unit_mrp_cents) },
    { header: 'Value at MRP', align: 'right', cell: (row) => money(row.consignment_value_cents) },
    { header: 'Last moved on', cell: (row) => stamp(row.last_movement_at) },
  ]
  const headers = ['Location', 'Product', 'Batch', 'Expiry', 'Supplier', 'Qty', 'Unit cost', 'MRP', 'Value at MRP', 'Last moved on']
  async function everything() {
    const rows: StockRow[] = []
    for (let turn = 0; turn < 100; turn++) {
      const reply = await contract<{ rows: StockRow[]; has_more?: boolean }>(`/pharmacy/api/reports/consignment_stock?${asked(200, rows.length)}`)
      rows.push(...reply.rows)
      if (!reply.rows.length || !reply.has_more) break
    }
    return rows.map((row) => [row.location_name ?? '', row.product ?? '', row.batch_number ?? '', day(row.expiry_date?.slice(0, 10)), row.supplier_name ?? '',
      plain(row.consignment_quantity), row.unit_cost_cents / 100, row.unit_mrp_cents / 100, row.consignment_value_cents / 100, stamp(row.last_movement_at)])
  }
  const output = (send: (rows: (string | number)[][]) => void) => () => everything().then(send).catch(notifyFailure)

  const header = (
    <>
      <PageHeader
        title="Consignment stock"
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} onClick={output((rows) => downloadCsv('consignment_stock.csv', headers, rows))}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={output((rows) => printTable('Consignment stock', headers, rows))}>Print</Button>
          </>
        }
      />
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
          <TextInput label="Product" placeholder="Search product" leftSection={<IconSearch size={16} />} value={typed.product} onChange={(e) => { setTyped({ ...typed, product: e.currentTarget.value }); setPage(1) }} />
          <TextInput label="Batch" value={typed.batch_number} onChange={(e) => { setTyped({ ...typed, batch_number: e.currentTarget.value }); setPage(1) }} />
          <Select label="Supplier" placeholder="All suppliers" data={suppliers.data ?? []} value={filters.supplier_id ?? null} onChange={(v) => setFilter('supplier_id', v)} clearable searchable />
          <Select label="Location" placeholder="All locations" data={locations} value={filters.location_id ?? null} onChange={(v) => setFilter('location_id', v)} clearable searchable />
        </SimpleGrid>
      </FilterBar>
    </>
  )
  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={stock.data?.rows ?? []}
        rowKey={(row) => `${row.location_name}-${row.product}-${row.batch_number}-${row.supplier_name}`}
        loading={stock.isFetching}
        view={query.toString()}
        empty={stock.isError ? <EmptyState title="Could not load the consignment stock." hint={stock.error.message} /> : <EmptyState title="No consignment stock found." />}
        footer={<Pager page={page} pageSize={pageSize} total={total} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(size) => { setPageSize(size); setPage(1) }} />}
      />
    </Page>
  )
}
