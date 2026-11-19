import {
  Alert, Anchor, Button, Collapse, Group, Modal, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Table, Text,
  TextInput,
} from '@mantine/core'
import { useDebouncedValue, useDisclosure } from '@mantine/hooks'
import { IconAdjustmentsHorizontal, IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import {
  DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, Pager, plain,
  printTable, RowActions, SidePanel, StatusBadge, type Column,
} from '../ui'
import { useMedicineOptions } from './Medicines'
import { StockDiary } from './StockDiary'

type Stock = components['schemas']['OverallStock']
type Row = components['schemas']['StockRow']
type LocationTotal = components['schemas']['LocationTotal']

const PAGE_SIZE = 20
const URL = '/api/stock/overall'
const NO_FILTERS: Record<string, string> = {}
const stackCell = (top: string, bottom: string) => (
  <>
    <Text size="sm">{top}</Text>
    <Text size="xs" c="dimmed">{bottom}</Text>
  </>
)

export function OverallStocks() {
  const options = useMedicineOptions()
  // another screen opens this one on a product: ?q=<its name>
  const [address] = useSearchParams()
  const [search, setSearch] = useState(address.get('q') ?? '')
  const [q] = useDebouncedValue(search.trim(), 300)
  // the Dashboard opens this screen on its low-stock or near-expiry rows: ?alert=low | ?alert=expiring
  const [filters, setFilters] = useState<Record<string, string>>(address.get('alert') ? { alert: address.get('alert')! } : NO_FILTERS)
  const [page, setPage] = useState(1)
  const [moreOpen, more] = useDisclosure(false)
  const [byLocation, setByLocation] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [diaryOf, setDiaryOf] = useState<Row | null>(null)
  const [printing, setPrinting] = useState(false)

  const chosen = new URLSearchParams({ ...filters, q })
  const query = new URLSearchParams({ ...filters, q, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
  const stock = useQuery({
    queryKey: ['overall-stock', query.toString()],
    queryFn: () => api<Stock>(`${URL}?${query}`),
    placeholderData: keepPreviousData,
  })

  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }
  const hidden = ['expiry_to', 'rack', 'bin', 'manufacturer', 'category', 'include_zero'].filter((name) => filters[name]).length

  async function print() {
    setPrinting(true)
    try {
      const all = await api<Stock>(`${URL}?${chosen}&output=all`)
      printTable(
        'Overall stocks',
        ['Product', 'Location', 'Rack / Bin', 'Batch', 'Expiry', 'Status', 'Qty', 'Cost value', 'MRP value'],
        all.items.map((row) => [
          row.item_name, row.location_name ?? '', `${row.rack_code || '--'} / ${row.bin_code || '--'}`,
          row.batch_number ?? '', day(row.expiry_date), row.statuses.join(' / '), plain(row.quantity_on_hand),
          money(row.landed_value_cents), money(row.mrp_value_cents),
        ]),
      )
    } catch (error) {
      notifyFailure(error as Error)
    } finally {
      setPrinting(false)
    }
  }

  const columns: Column<Row>[] = [
    { header: 'Product', cell: (row) => <><Text size="sm" fw={500}>{row.item_name}</Text><Text size="xs" c="dimmed">{row.generic_name}</Text></> },
    { header: 'Location / Rack / Bin', cell: (row) => stackCell(row.location_name ?? '--', `${row.rack_code || '--'} / ${row.bin_code || '--'}`) },
    { header: 'Batch / Expiry', cell: (row) => stackCell(row.batch_number || '--', day(row.expiry_date)) },
    { header: 'Status', cell: (row) => <Group gap={4}>{row.statuses.map((status) => <StatusBadge key={status} status={status} />)}</Group> },
    { header: 'Qty', align: 'right', cell: (row) => <Text size="sm" fw={600}>{plain(row.quantity_on_hand)}</Text> },
    { header: 'Reorder level', align: 'right', cell: (row) => plain(row.reorder_level) },
    { header: 'Unit cost / with tax', align: 'right', cell: (row) => stackCell(money(row.unit_cost_cents), money(row.landed_cost_cents)) },
    { header: 'MRP / GST %', align: 'right', cell: (row) => stackCell(money(row.unit_mrp_cents), `${plain(row.tax_percent)}%`) },
    { header: 'Cost value / MRP value', align: 'right', cell: (row) => stackCell(money(row.landed_value_cents), money(row.mrp_value_cents)) },
    {
      header: 'Actions', align: 'right',
      cell: (row) => (
        <RowActions
          name={row.item_name}
          actions={[
            { label: 'Edit', kind: 'main', onClick: () => setEditing(row) },
            { label: 'Movements', onClick: () => setDiaryOf(row) },
          ]}
        />
      ),
    },
  ]
  const total = stock.data?.grand_total

  const header = (
    <>
      <PageHeader
        title="Overall stocks"
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`${URL}?${chosen}&output=csv`}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} loading={printing} onClick={print}>Print</Button>
          </>
        }
      >
        <Facts
          items={[
            { label: 'Quantity', value: plain(total?.quantity) },
            { label: 'Cost value', value: money(total?.landed_value_cents) },
            { label: 'MRP value', value: money(total?.mrp_value_cents) },
            { label: 'In transit', value: `${plain(total?.in_transit_quantity)} (${money(total?.in_transit_landed_value_cents)})` },
            { label: 'Locations', value: <Anchor component="button" type="button" size="sm" fw={500} c="bottle.7" onClick={() => setByLocation(true)}>{stock.data?.location_totals.length ?? 0}, see each</Anchor> },
          ]}
        />
      </PageHeader>
      <FilterBar>
        <Group align="end">
          <TextInput
            aria-label="Search stock"
            placeholder="Search by product, code, rack, bin or location"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => { setSearch(event.currentTarget.value); setPage(1) }}
            style={{ flex: 1 }}
            miw={220}
          />
          <SegmentedControl
            data={[{ value: '', label: 'All' }, { value: 'low', label: 'Low stock' }, { value: 'expiring', label: 'Near expiry' }]}
            value={filters.alert ?? ''}
            onChange={(value) => setFilter('alert', value)}
          />
          <Select
            aria-label="Location"
            placeholder="All locations"
            data={stock.data?.locations ?? []}
            value={filters.location_id ?? null}
            onChange={(value) => setFilter('location_id', value)}
            clearable
            searchable
            w={200}
          />
          <Button variant="default" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={more.toggle}>
            Filters{hidden ? ` (${hidden})` : ''}
          </Button>
        </Group>
        <Collapse expanded={moreOpen}>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} mt="md">
            <TextInput label="Expiry before" type="date" value={filters.expiry_to ?? ''} onChange={(e) => setFilter('expiry_to', e.currentTarget.value)} />
            <TextInput label="Rack" value={filters.rack ?? ''} onChange={(e) => setFilter('rack', e.currentTarget.value)} />
            <TextInput label="Bin" value={filters.bin ?? ''} onChange={(e) => setFilter('bin', e.currentTarget.value)} />
            <Select label="Manufacturer" placeholder="All" clearable searchable
              data={(options.data?.manufacturer_code ?? []).map((o) => ({ value: o.code, label: o.name }))}
              value={filters.manufacturer ?? null} onChange={(value) => setFilter('manufacturer', value)} />
            <Select label="Product category" placeholder="All" clearable searchable
              data={(options.data?.product_category_code ?? []).map((o) => ({ value: o.code, label: o.name }))}
              value={filters.category ?? null} onChange={(value) => setFilter('category', value)} />
            <Select label="Zero stock" data={[{ value: '', label: 'Hide' }, { value: 'true', label: 'Show' }]}
              value={filters.include_zero ?? ''} onChange={(value) => setFilter('include_zero', value)} allowDeselect={false} />
          </SimpleGrid>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => { setFilters(NO_FILTERS); setSearch(''); setPage(1) }}>Reset</Button>
          </Group>
        </Collapse>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={stock.data?.items ?? []}
        rowKey={(row) => row.stock_balance_id}
        view={query.toString()}
        loading={stock.isFetching}
        empty={stock.isError
          ? <EmptyState title="Could not load the stock." hint={stock.error.message} />
          : <EmptyState title="No stock found." hint="Change the search or the filters." />}
        footer={<Pager page={page} pageSize={PAGE_SIZE} total={stock.data?.total ?? 0} onChange={setPage} />}
      />
      <Modal opened={byLocation} onClose={() => setByLocation(false)} size="lg" centered title={<Text fw={600}>Stock by location</Text>}>
        <LocationTotals rows={stock.data?.location_totals ?? []} />
      </Modal>
      {diaryOf && (
        <StockDiary itemId={diaryOf.item_id} itemName={diaryOf.item_name} locationId={String(diaryOf.location_id)}
          onClose={() => setDiaryOf(null)} />
      )}
      {editing && <ShelfEditor key={editing.stock_balance_id} row={editing} onClose={() => setEditing(null)} />}
    </Page>
  )
}

function LocationTotals({ rows }: { rows: LocationTotal[] }) {
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Location</Table.Th><Table.Th ta="right">Qty</Table.Th><Table.Th ta="right">Cost value</Table.Th>
          <Table.Th ta="right">MRP value</Table.Th><Table.Th ta="right">In transit qty</Table.Th><Table.Th ta="right">In transit cost</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.location_name}>
            <Table.Td>{row.location_name}</Table.Td>
            <Table.Td ta="right">{plain(row.quantity)}</Table.Td>
            <Table.Td ta="right">{money(row.landed_value_cents)}</Table.Td>
            <Table.Td ta="right">{money(row.mrp_value_cents)}</Table.Td>
            <Table.Td ta="right">{plain(row.in_transit_quantity)}</Table.Td>
            <Table.Td ta="right">{money(row.in_transit_landed_value_cents)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

function ShelfEditor({ row, onClose }: { row: Row; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState({
    reorder_level: plain(row.reorder_level),
    unit_cost: String(row.unit_cost_cents / 100),
    unit_mrp: String(row.unit_mrp_cents / 100),
    landed_cost: String(row.landed_cost_cents / 100),
    rack_code: row.rack_code ?? '',
    bin_code: row.bin_code ?? '',
    is_active: 'true',
  })
  const set = (name: keyof typeof values, value: string) => setValues({ ...values, [name]: value })
  const amount = (name: 'reorder_level' | 'unit_cost' | 'unit_mrp' | 'landed_cost', label: string, scale: number) => (
    <NumberInput label={label} min={0} allowNegative={false} decimalScale={scale} hideControls
      value={values[name]} onChange={(value) => set(name, String(value))} />
  )

  const save = useMutation({
    mutationFn: () => api(`/api/stock/balances/${row.stock_balance_id}`, 'PUT', {
      ...values, is_active: values.is_active === 'true',
      reorder_level: values.reorder_level || 0, unit_cost: values.unit_cost || 0,
      unit_mrp: values.unit_mrp || 0, landed_cost: values.landed_cost || 0,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['overall-stock'] })
      notifySuccess(`${row.item_name} saved.`)
      onClose()
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate() }

  return (
    <SidePanel onClose={onClose} title="Edit reorder level and cost" subject={row.item_name}>
      <form onSubmit={submit}>
        <Stack gap="sm">
          <Facts items={[{ label: 'Batch', value: row.batch_number || '--' }, { label: 'Location', value: row.location_name ?? '--' }]} />
          <Facts
            items={[
              { label: 'On hand', value: plain(row.quantity_on_hand) }, { label: 'Reserved', value: plain(row.reserved_quantity) },
              { label: 'In transit', value: plain(row.in_transit_quantity) }, { label: 'Damaged', value: plain(row.damaged_quantity) },
              { label: 'Consignment', value: plain(row.consignment_quantity) },
            ]}
          />
          {amount('reorder_level', 'Reorder level', 3)}
          {amount('unit_cost', 'Unit cost', 2)}
          {amount('unit_mrp', 'MRP', 2)}
          {amount('landed_cost', 'Unit cost with tax', 2)}
          <TextInput label="Rack" maxLength={64} value={values.rack_code} onChange={(e) => set('rack_code', e.currentTarget.value)} />
          <TextInput label="Bin" maxLength={64} value={values.bin_code} onChange={(e) => set('bin_code', e.currentTarget.value)} />
          <Select label="Active" data={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]}
            value={values.is_active} onChange={(value) => set('is_active', value ?? 'true')} allowDeselect={false} />
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <Button type="submit" loading={save.isPending}>Save</Button>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}
