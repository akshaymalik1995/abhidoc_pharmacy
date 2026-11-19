/** Wanted List: what the pharmacy should order. The screen reads from the new backend in one request;
 * every change (quantities, suppliers, new lists, purchase orders) is saved through DocAssist, which owns the ordering rules. */
import {
  Alert, Button, Checkbox, Group, Menu, Modal, NumberInput, Paper, Select, SimpleGrid, Stack, Text, TextInput,
} from '@mantine/core'
import { IconChevronDown, IconPlus, IconSearch } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import { useWorkLocation } from '../session'
import {
  type Column, ConfirmDialog, DataTable, day, downloadCsv, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, PageSkeleton, plain, printTable, RowActions, SidePanel, StatusBadge, useConfirm,
} from '../ui'
import { useMedicineOptions } from './Medicines'
import { words } from './PurchaseList'

type Screen = components['schemas']['WantedScreen']
type Wanted = components['schemas']['WantedList']
type Line = components['schemas']['WantedLine']
type ListRow = components['schemas']['DocumentRow']
type Choice = components['schemas']['Choice']

const KEY = ['wanted-list']
const LEGACY = '/pharmacy/api/wanted'
const KIND: Record<string, string> = {
  REORDER_WANTED_LIST: 'Reorder', SALE_BASED_WANTED_LIST: 'Sale based', NEW_PRODUCT_WANTED_LIST: 'New products',
}
/** The rows a person can still act on. */
const actionable = (line: Line) => ['OPEN', 'DEFERRED', 'STAGED'].includes(line.line_status)
const stamp = (value: string | null | undefined) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '--')

export function WantedList() {
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const asked = Number(params.get('list')) || null
  const screen = useQuery({
    queryKey: [...KEY, asked],
    queryFn: () => api<Screen>(`/api/purchase/wanted${asked ? `?wanted_document_id=${asked}` : ''}`),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY })
  const open = (id: number | null) => setParams(id ? { list: String(id) } : {}, { replace: true })

  const [panel, setPanel] = useState<null | 'lists' | 'history' | 'add' | 'sale' | 'orders'>(null)
  const [orderRows, setOrderRows] = useState<number[] | null>(null) // only these rows go into purchase orders
  const [cancelling, setCancelling] = useState(false)

  /** A reorder list of everything below its reorder level. */
  const generate = useMutation({
    mutationFn: () => api<{ wanted_document_id?: number; message?: string }>(`${LEGACY}/generate`, 'POST', {}),
    onSuccess: (reply) => {
      notifySuccess(reply.wanted_document_id ? 'Wanted list generated.' : (reply.message ?? 'No products below reorder level.'))
      if (reply.wanted_document_id) open(reply.wanted_document_id)
      return refresh()
    },
    onError: notifyFailure,
  })
  const cancel = useMutation({
    mutationFn: (id: number) => api(`${LEGACY}/${id}/cancel`, 'POST', {}),
    onSuccess: () => { notifySuccess('Wanted list cancelled.'); open(null); return refresh() },
    onError: notifyFailure,
    onSettled: () => setCancelling(false),
  })

  if (screen.isPending) return <PageSkeleton />
  if (screen.isError) return <Alert color="red">{screen.error.message}</Alert>
  const { wanted, lists, suppliers } = screen.data
  const editable = wanted?.status === 'OPEN'

  const more = (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target><Button variant="default" rightSection={<IconChevronDown size={16} />}>More</Button></Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => setPanel('lists')}>Other wanted lists</Menu.Item>
        <Menu.Item onClick={() => setPanel('sale')}>Sale-based wanted list</Menu.Item>
        {wanted && <Menu.Item onClick={() => setPanel('history')}>History</Menu.Item>}
        {!wanted && <Menu.Item onClick={() => generate.mutate()}>New wanted list</Menu.Item>}
      </Menu.Dropdown>
    </Menu>
  )

  const header = (
    <PageHeader
      title={wanted ? `Wanted list ${wanted.purchase_number ?? ''}` : 'Wanted list'}
      badge={wanted && <StatusBadge status={words(wanted.status)} />}
      actions={
        <>
          {editable && <Button variant="danger" onClick={() => setCancelling(true)}>Cancel list</Button>}
          {more}
          {editable && <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setPanel('add')}>Add row</Button>}
          {editable && <Button onClick={() => { setOrderRows(null); setPanel('orders') }}>Generate POs</Button>}
        </>
      }
    >
      {wanted && (
        <Facts items={[
          { label: 'Kind', value: KIND[wanted.purchase_type] ?? words(wanted.purchase_type) },
          { label: 'Date', value: day(wanted.document_date) },
          { label: 'Location', value: wanted.location_name ?? '--' },
          { label: 'Rows', value: `${wanted.lines.filter((line) => line.line_status === 'OPEN').length} open of ${wanted.lines.length}` },
        ]} />
      )}
    </PageHeader>
  )

  return (
    <Page header={header}>
      {!wanted && (
        <Paper withBorder>
          <EmptyState
            title="No wanted list is open."
            hint="A new list holds every product that is below its reorder level."
            action={<Button loading={generate.isPending} onClick={() => generate.mutate()}>New wanted list</Button>}
          />
        </Paper>
      )}
      {wanted && (
        <Lines
          key={wanted.purchase_document_id}
          wanted={wanted}
          suppliers={suppliers}
          editable={editable}
          onChanged={refresh}
          onOrder={(ids) => { setOrderRows(ids); setPanel('orders') }}
        />
      )}

      <Modal opened={panel === 'lists'} onClose={() => setPanel(null)} size="lg" centered title={<Text fw={600}>Wanted lists</Text>}>
        <OtherLists lists={lists} onOpen={(id) => { open(id); setPanel(null) }} />
      </Modal>
      {panel === 'history' && wanted && <History id={wanted.purchase_document_id} onClose={() => setPanel(null)} />}
      {panel === 'add' && wanted && <AddRow id={wanted.purchase_document_id} suppliers={suppliers} onClose={() => setPanel(null)} onSaved={refresh} />}
      {panel === 'sale' && <SaleBased suppliers={suppliers} onClose={() => setPanel(null)} onMade={(id) => { open(id); return refresh() }} />}
      {panel === 'orders' && wanted && (
        <PurchaseOrders id={wanted.purchase_document_id} number={wanted.purchase_number ?? ''} rows={orderRows} onClose={() => { setPanel(null); refresh() }} />
      )}
      <ConfirmDialog
        opened={cancelling} title="Cancel wanted list" confirm="Cancel list" keep="Keep list" loading={cancel.isPending}
        onConfirm={() => wanted && cancel.mutate(wanted.purchase_document_id)} onClose={() => setCancelling(false)}
      >
        Cancel {wanted?.purchase_number}? Its rows will not be ordered.
      </ConfirmDialog>
    </Page>
  )
}

function Lines(props: { wanted: Wanted; suppliers: Choice[]; editable: boolean; onChanged: () => Promise<unknown>; onOrder: (ids: number[]) => void }) {
  const { wanted, editable } = props
  const saleBased = wanted.purchase_type === 'SALE_BASED_WANTED_LIST'
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string | null>>({})
  const [selected, setSelected] = useState<number[]>([])
  const [typed, setTyped] = useState<Record<number, string>>({}) // quantities being typed
  const [bulkSupplier, setBulkSupplier] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)

  const needle = search.trim().toLowerCase()
  const shown = wanted.lines.filter((line) =>
    (!needle || `${line.description} ${line.manufacturer}`.toLowerCase().includes(needle))
    && (!filters.status || line.line_status === filters.status)
    && (!filters.supplier || String(line.supplier_id) === filters.supplier)
    && (!filters.manufacturer || line.manufacturer === filters.manufacturer))
  const distinct = (pick: (line: Line) => string | null | undefined) => [...new Set(wanted.lines.map(pick).filter(Boolean) as string[])].sort()
  const chosen = selected.filter((id) => shown.some((line) => line.purchase_item_id === id && actionable(line)))

  /** One change to one row: set_quantity, change_supplier, reject, defer or reopen. */
  const act = useMutation({
    mutationFn: (change: { line: Line; body: Record<string, unknown> }) => api(`${LEGACY}/items/${change.line.purchase_item_id}`, 'POST', change.body),
    onSuccess: () => props.onChanged(),
    onError: notifyFailure,
  })
  // a rejected or deferred row brought back, asked first; its failure is shown in the dialog
  const reopen = useMutation({
    mutationFn: (line: Line) => api(`${LEGACY}/items/${line.purchase_item_id}`, 'POST', { action: 'reopen' }),
    onSuccess: () => props.onChanged(),
  })
  const confirm = useConfirm()
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ updated_count: number; skipped?: { message?: string }[] }>(`${LEGACY}/${wanted.purchase_document_id}/bulk`, 'POST', { ...body, item_ids: chosen }),
    onSuccess: async (reply) => {
      await props.onChanged()
      const skipped = reply.skipped?.length ?? 0
      notifySuccess(`${reply.updated_count} rows saved${skipped ? `; ${skipped} unchanged: ${reply.skipped?.[0]?.message ?? 'already ordered or rejected.'}` : '.'}`)
      setSelected([])
    },
    onError: notifyFailure,
    onSettled: () => setRejecting(false),
  })

  function saveQuantity(line: Line) {
    const value = typed[line.purchase_item_id]
    if (value === undefined || Number(value) === Number(line.requested_quantity)) return
    act.mutate({ line, body: { action: 'set_quantity', quantity: value } }, { onSettled: () => setTyped(({ [line.purchase_item_id]: _, ...rest }) => rest) })
  }

  const columns: Column<Line>[] = [
    {
      header: 'Product',
      cell: (line) => {
        const cover = Number(line.average_daily_sale) > 0 ? Number(line.current_stock_quantity) / Number(line.average_daily_sale) : null
        const note = cover != null ? `enough stock for ${cover.toFixed(1)} days` : saleBased && line.average_daily_sale != null ? 'no sales in the period' : null
        return (
          <Group gap="sm" wrap="nowrap" align="start">
            {editable && (
              <Checkbox
                aria-label={`Select ${line.description}`} mt={2} disabled={!actionable(line)}
                checked={selected.includes(line.purchase_item_id)}
                onChange={(e) => setSelected(e.currentTarget.checked ? [...selected, line.purchase_item_id] : selected.filter((id) => id !== line.purchase_item_id))}
              />
            )}
            <div>
              <Text size="sm" fw={500}>{line.description || 'Product'}</Text>
              <Text size="xs" c="dimmed">{[line.manufacturer, note].filter(Boolean).join(', ')}</Text>
            </div>
          </Group>
        )
      },
    },
    ...(saleBased ? [{ header: 'Group / category', cell: (line: Line) => [line.product_group, line.product_category].filter(Boolean).join(' / ') || '--' } as Column<Line>] : []),
    { header: 'Stock', align: 'right', cell: (line) => plain(line.current_stock_quantity) },
    { header: 'Reorder level', align: 'right', cell: (line) => plain(line.reorder_level) },
    ...(saleBased ? [
      { header: 'Sold', align: 'right', cell: (line: Line) => plain(line.sold_quantity) } as Column<Line>,
      { header: 'Per day', align: 'right', cell: (line: Line) => plain(line.average_daily_sale) } as Column<Line>,
      { header: 'Lead time', align: 'right', cell: (line: Line) => (line.lead_time_days == null ? '--' : `${line.lead_time_days} d`) } as Column<Line>,
      { header: 'Required qty', cell: (line: Line) => line.quantity_calculation || '--' } as Column<Line>,
    ] : []),
    {
      header: 'Wanted qty', align: 'right', width: 110,
      cell: (line) => (
        <NumberInput
          aria-label={`Wanted quantity of ${line.description}`} size="xs" min={0.001} decimalScale={3} allowNegative={false} hideControls
          disabled={!editable || line.line_status !== 'OPEN'}
          value={typed[line.purchase_item_id] ?? plain(line.requested_quantity)}
          onChange={(value) => setTyped({ ...typed, [line.purchase_item_id]: String(value) })}
          onBlur={() => saveQuantity(line)}
          styles={{ input: { textAlign: 'right' } }}
        />
      ),
    },
    {
      header: 'Last purchase',
      cell: (line) => line.last_purchase_batch_number
        ? (
          <>
            <Text size="sm">{line.last_purchase_batch_number}, {money(line.last_purchase_cost_cents)}</Text>
            <Text size="xs" c="dimmed">{[line.last_purchase_expiry_date && `expiry ${day(line.last_purchase_expiry_date)}`, saleBased && line.last_purchase_supplier_name].filter(Boolean).join(', ')}</Text>
          </>
        )
        : '--',
    },
    {
      header: 'Supplier', width: 210,
      cell: (line) => (
        <Select
          aria-label={`Supplier of ${line.description}`} size="xs" placeholder="None" searchable
          disabled={!editable || line.line_status !== 'OPEN'}
          data={props.suppliers} value={line.supplier_id ? String(line.supplier_id) : null}
          onChange={(value) => value && act.mutate({ line, body: { action: 'change_supplier', supplier_id: value } })}
        />
      ),
    },
    { header: 'Status', cell: (line) => <><StatusBadge status={words(line.line_status)} /><Text size="xs" c="dimmed">{stamp(line.last_updated)}</Text></> },
    {
      header: 'Actions', align: 'right',
      cell: (line) => editable && (
        <RowActions name={line.description ?? undefined} actions={line.line_status === 'OPEN'
          ? [{ label: 'Defer', onClick: () => act.mutate({ line, body: { action: 'defer' } }) }, { label: 'Reject', kind: 'danger', onClick: () => act.mutate({ line, body: { action: 'reject' } }) }]
          : ['REJECTED', 'DEFERRED'].includes(line.line_status) ? [{ label: 'Reopen', kind: 'main', onClick: () => confirm.ask({ action: 'Reopen', subject: line.description || 'this row',
            run: () => reopen.mutateAsync(line) }) }] : []} />
      ),
    },
  ]

  const exportRows = () => shown.map((line) => [
    line.description ?? '', line.manufacturer ?? '', line.supplier_name ?? '', line.last_purchase_batch_number ?? '',
    line.last_purchase_expiry_date ?? '', (line.last_purchase_cost_cents ?? 0) / 100, plain(line.current_stock_quantity),
    plain(line.reorder_level), plain(line.requested_quantity), words(line.line_status),
  ])
  const exportHeaders = ['Product', 'Manufacturer', 'Supplier', 'Last batch', 'Last expiry', 'Last unit cost', 'Qty in stock', 'Reorder level', 'Wanted qty', 'Status']
  const filter = (name: string, label: string, data: (string | Choice)[]) => (
    <Select aria-label={label} placeholder={label} data={data} value={filters[name] ?? null} onChange={(value) => setFilters({ ...filters, [name]: value })} clearable searchable w={190} />
  )

  return (
    <>
      <FilterBar>
        <Group justify="space-between">
          <Group>
            <TextInput aria-label="Search rows" placeholder="Search product" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={240} />
            {filter('status', 'All statuses', distinct((line) => line.line_status).map((s) => ({ value: s, label: words(s) })))}
            {filter('supplier', 'All suppliers', props.suppliers.filter((s) => wanted.lines.some((line) => String(line.supplier_id) === s.value)))}
            {filter('manufacturer', 'All manufacturers', distinct((line) => line.manufacturer))}
          </Group>
          <Group gap="sm">
            <Text size="sm" c="dimmed">Rows {shown.length} of {wanted.lines.length}</Text>
            <Button variant="default" onClick={() => downloadCsv(`wanted_list_${wanted.purchase_number}.csv`, exportHeaders, exportRows())}>Export CSV</Button>
            <Button variant="default" onClick={() => printTable(`Wanted list ${wanted.purchase_number}`, exportHeaders, exportRows())}>Print</Button>
          </Group>
        </Group>
        {chosen.length > 0 && (
          <Group mt="md" align="end">
            <Text size="sm" fw={600}>{chosen.length} selected</Text>
            <Select aria-label="Supplier for the selected rows" placeholder="Select supplier" data={props.suppliers} value={bulkSupplier} onChange={setBulkSupplier} searchable w={240} />
            <Button variant="default" disabled={!bulkSupplier} loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'change_supplier', supplier_id: bulkSupplier })}>Change supplier</Button>
            <Button variant="danger" onClick={() => setRejecting(true)}>Reject selected</Button>
            <Button onClick={() => props.onOrder(chosen)}>Generate PO for selected</Button>
          </Group>
        )}
      </FilterBar>
      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(line) => line.purchase_item_id}
        empty={<EmptyState title={wanted.lines.length ? 'No rows found.' : 'No products below reorder level.'} />}
      />
      <ConfirmDialog
        opened={rejecting} title="Reject selected rows" confirm="Reject rows" keep="Keep rows" loading={bulk.isPending}
        onConfirm={() => bulk.mutate({ action: 'reject' })} onClose={() => setRejecting(false)}
      >
        Reject the {chosen.length} selected rows? They will not be ordered from this list.
      </ConfirmDialog>
      {confirm.dialog}
    </>
  )
}

function OtherLists({ lists, onOpen }: { lists: ListRow[]; onOpen: (id: number) => void }) {
  const columns: Column<ListRow>[] = [
    { header: 'List no.', cell: (row) => <Text size="sm" fw={500}>{row.purchase_number}</Text> },
    { header: 'Date', cell: (row) => day(row.document_date) },
    { header: 'Kind', cell: (row) => KIND[row.purchase_type] ?? words(row.purchase_type) },
    { header: 'Status', cell: (row) => <StatusBadge status={words(row.status)} /> },
    { header: 'Products', align: 'right', cell: (row) => plain(row.product_count) },
    { header: 'Actions', align: 'right', cell: (row) => <RowActions actions={[{ label: 'Open', kind: 'main', onClick: () => onOpen(row.purchase_document_id) }]} /> },
  ]
  return <DataTable columns={columns} rows={lists} rowKey={(row) => row.purchase_document_id} empty={<EmptyState title="No wanted lists yet." />} />
}

function History({ id, onClose }: { id: number; onClose: () => void }) {
  const history = useQuery({
    queryKey: ['wanted-history', id],
    queryFn: () => api<{ rows: { when: string; who: string; what: string }[] }>(`${LEGACY}/${id}/history`),
  })
  const columns: Column<{ when: string; who: string; what: string }>[] = [
    { header: 'Date', width: 170, cell: (row) => new Date(row.when).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    { header: 'User', width: 200, cell: (row) => row.who },
    { header: 'Change', cell: (row) => row.what },
  ]
  return (
    <SidePanel title="Wanted list history" size={860} onClose={onClose} loading={history.isPending} error={history.error}>
      <DataTable columns={columns} rows={history.data?.rows ?? []} rowKey={(row) => `${row.when}-${row.what}`} empty={<EmptyState title="No changes." />} />
    </SidePanel>
  )
}

function AddRow(props: { id: number; suppliers: Choice[]; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [product, setProduct] = useState<OrderProduct | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [supplier, setSupplier] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => api(`${LEGACY}/${props.id}/items`, 'POST', { pharmacy_item_id: product?.item_id, quantity, supplier_id: supplier }),
    onSuccess: async () => { await props.onSaved(); notifySuccess(`${product?.item_name} added.`); props.onClose() },
  })
  return (
    <SidePanel title="Add row" onClose={props.onClose}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">A product already on the list gets its quantity replaced.</Text>
        <div><Text size="sm" fw={500} mb={4}>Product</Text><ProductPicker label="Product" value={product} onChange={setProduct} /></div>
        <NumberInput label="Wanted qty" min={0.001} decimalScale={3} allowNegative={false} hideControls value={quantity} onChange={(value) => setQuantity(String(value))} />
        <Select label="Supplier" placeholder="None" data={props.suppliers} value={supplier} onChange={setSupplier} searchable clearable />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" mt="sm">
          <Button disabled={!product || !(Number(quantity) > 0)} loading={save.isPending} onClick={() => save.mutate()}>Add row</Button>
        </Group>
      </Stack>
    </SidePanel>
  )
}

function SaleBased(props: { suppliers: Choice[]; onClose: () => void; onMade: (id: number) => Promise<unknown> }) {
  const { locations } = useWorkLocation()
  const options = useMedicineOptions()
  const [form, setForm] = useState<Record<string, string | null>>({ lead_time_days: '7', safety_days: '3' })
  const [skipZero, setSkipZero] = useState(true)
  const set = (name: string, value: string | null) => setForm({ ...form, [name]: value })
  const codes = (name: string) => (options.data?.[name] ?? []).map((o) => ({ value: o.code, label: o.name }))
  const make = useMutation({
    mutationFn: () => api<{ wanted_document_id?: number; message?: string }>(`${LEGACY}/generate-sale-based`, 'POST', {
      date_from: form.date_from || null, date_to: form.date_to || null, location_id: form.location_id || null,
      product_group: form.product_group || null, product_category: form.product_category || null,
      supplier_id: form.supplier_id || null, manufacturer: form.manufacturer || null,
      lead_time_days: Number(form.lead_time_days) || 7, safety_days: Number(form.safety_days ?? 3), skip_zero: skipZero,
    }),
    onSuccess: async (reply) => {
      if (reply.wanted_document_id) await props.onMade(reply.wanted_document_id)
      notifySuccess(reply.wanted_document_id ? 'Sale-based wanted list generated.' : (reply.message ?? 'Nothing needs ordering for this period.'))
      props.onClose()
    },
  })
  const pick = (name: string, label: string, placeholder: string, data: Choice[]) => (
    <Select label={label} placeholder={placeholder} data={data} value={form[name] ?? null} onChange={(value) => set(name, value)} clearable searchable />
  )
  return (
    <SidePanel title="Sale-based wanted list" size={640} onClose={props.onClose}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">Works out what to order from what was sold in a period, the days a delivery takes and the days of safety stock.</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="From date" type="date" value={form.date_from ?? ''} onChange={(e) => set('date_from', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={form.date_to ?? ''} onChange={(e) => set('date_to', e.currentTarget.value)} />
          <NumberInput label="Lead time (days)" min={1} max={120} allowDecimal={false} value={form.lead_time_days ?? ''} onChange={(value) => set('lead_time_days', String(value))} />
          <NumberInput label="Safety stock (days)" min={0} max={60} allowDecimal={false} value={form.safety_days ?? ''} onChange={(value) => set('safety_days', String(value))} />
          {pick('location_id', 'Location', 'All locations', locations)}
          {pick('supplier_id', 'Supplier', 'All suppliers', props.suppliers)}
          {pick('product_group', 'Product group', 'All groups', codes('product_group_code'))}
          {pick('product_category', 'Product category', 'All categories', codes('product_category_code'))}
          {pick('manufacturer', 'Manufacturer', 'All manufacturers', codes('manufacturer_code'))}
        </SimpleGrid>
        <Checkbox label="Hide products with enough stock" checked={skipZero} onChange={(e) => setSkipZero(e.currentTarget.checked)} />
        {make.isError && <Alert color="red">{make.error.message}</Alert>}
        <Group justify="flex-end">
          <Button loading={make.isPending} onClick={() => make.mutate()}>Generate wanted list</Button>
        </Group>
      </Stack>
    </SidePanel>
  )
}

interface SupplierGroup {
  purchase_document_id: number
  purchase_number: string | null
  supplier_name: string | null
  product_count: string | number
  quantity_total: string
  gross_amount_cents: number
  discount_amount_cents: number
  tax_amount_cents: number
  net_amount_cents: number
  status: string
}

/** The open rows of a wanted list, grouped by supplier; each group becomes one purchase order. */
function PurchaseOrders(props: { id: number; number: string; rows: number[] | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { locationId } = useWorkLocation()
  const [email, setEmail] = useState(false)
  const options = useMedicineOptions()
  const [only, setOnly] = useState<{ group: string | null; category: string | null }>({ group: null, category: null })
  const codes = (name: string) => (options.data?.[name] ?? []).map((o) => ({ value: o.code, label: o.name }))
  const key = ['po-generation', props.id]
  const reload = () => queryClient.invalidateQueries({ queryKey: key })

  // opening the panel groups the rows; Regroup does it again
  const staged = useQuery({
    queryKey: key,
    queryFn: async () => {
      await api('/pharmacy/api/po-generation', 'POST', {
        wanted_document_id: props.id, location_id: locationId, item_ids: props.rows,
        product_group_code: only.group, product_category_code: only.category,
      })
      return api<{ generations: SupplierGroup[] }>(`/pharmacy/api/po-generation?wanted_document_id=${props.id}`)
    },
    staleTime: Infinity,
    gcTime: 0,
  })
  const groups = staged.data?.generations ?? []
  const waiting = groups.filter((group) => group.status === 'STAGED')

  const confirm = useMutation({
    mutationFn: async (ids: number[]) => {
      const made: string[] = []
      for (const id of ids) {
        const reply = await api<{ purchase_number: string }>(`/pharmacy/api/po-generation/${id}/confirm`, 'POST', { send_email_notification: email, location_id: locationId })
        made.push(reply.purchase_number)
      }
      return made
    },
    onSuccess: (made) => notifySuccess(`Purchase order${made.length > 1 ? 's' : ''} ${made.join(', ')} generated.`),
    onError: notifyFailure,
    onSettled: () => { queryClient.invalidateQueries({ queryKey: ['purchase-documents'] }); return reload() },
  })
  const defer = useMutation({
    mutationFn: (id: number) => api<{ deferred_line_count: number }>(`/pharmacy/api/po-generation/${id}/defer`, 'POST', {}),
    onSuccess: (reply) => { notifySuccess(`${reply.deferred_line_count} rows deferred.`); return reload() },
    onError: notifyFailure,
  })

  const columns: Column<SupplierGroup>[] = [
    { header: 'Supplier', cell: (group) => <><Text size="sm" fw={500}>{group.supplier_name || '--'}</Text><Text size="xs" c="dimmed">{group.purchase_number}</Text></> },
    { header: 'Products', align: 'right', cell: (group) => plain(group.product_count) },
    { header: 'Total qty', align: 'right', cell: (group) => plain(group.quantity_total) },
    { header: 'Gross', align: 'right', cell: (group) => money(group.gross_amount_cents) },
    { header: 'Discount', align: 'right', cell: (group) => money(group.discount_amount_cents) },
    { header: 'GST', align: 'right', cell: (group) => money(group.tax_amount_cents) },
    { header: 'Net (estimated)', align: 'right', cell: (group) => <Text size="sm" fw={600}>{money(group.net_amount_cents)}</Text> },
    { header: 'Status', cell: (group) => <StatusBadge status={words(group.status)} /> },
    {
      header: 'Actions', align: 'right',
      cell: (group) => group.status === 'STAGED' && (
        <RowActions name={group.supplier_name ?? undefined} actions={[
          { label: 'Generate PO', kind: 'main', onClick: () => confirm.mutate([group.purchase_document_id]) },
          { label: 'Defer', onClick: () => defer.mutate(group.purchase_document_id) },
        ]} />
      ),
    },
  ]

  return (
    <SidePanel title="Generate purchase orders" subject={props.number} size={1080} viewOnly onClose={props.onClose} loading={staged.isPending} error={staged.error}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {props.rows ? `The ${props.rows.length} selected rows` : 'The open rows'} are grouped by supplier. Each group becomes one purchase order.
        </Text>
        <Group align="end">
          <Select label="Product group" placeholder="All groups" data={codes('product_group_code')} value={only.group} onChange={(group) => setOnly({ ...only, group })} clearable searchable w={220} />
          <Select label="Product category" placeholder="All categories" data={codes('product_category_code')} value={only.category} onChange={(category) => setOnly({ ...only, category })} clearable searchable w={220} />
          <Button variant="default" loading={staged.isFetching} onClick={() => staged.refetch()}>Regroup</Button>
        </Group>
        <DataTable columns={columns} rows={groups} rowKey={(group) => group.purchase_document_id} loading={staged.isFetching || confirm.isPending}
          empty={<EmptyState title="No supplier groups." hint="Rows without a supplier are left out. Give them a supplier, then regroup." />} />
        <Group justify="space-between" pos="sticky" bottom={0} bg="white" py="sm">
          <Checkbox label="Email the supplier" checked={email} onChange={(e) => setEmail(e.currentTarget.checked)} />
          <Group>
            <Button disabled={!waiting.length} loading={confirm.isPending} onClick={() => confirm.mutate(waiting.map((group) => group.purchase_document_id))}>
              Generate all POs
            </Button>
          </Group>
        </Group>
      </Stack>
    </SidePanel>
  )
}
