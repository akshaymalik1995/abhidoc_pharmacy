import { Alert, Button, Group, NumberInput, Paper, Select, Stack, Text, TextInput } from '@mantine/core'
import { IconPlus, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api, ApiError } from '../api'
import type { components } from '../api-types'
import {
  ConfirmDialog, DataTable, day, EmptyState, Facts, FilterBar, notifyFailure, notifySuccess, Page, PageHeader, PageSkeleton, plain,
  StatusBadge, type Column,
} from '../ui'

type Screen = components['schemas']['Screen']
type Count = components['schemas']['Count']
type Line = components['schemas']['Line']

/** One difference, as DocAssist's Finish-count reply lists it. */
interface Variance {
  stock_item_id: number
  description: string
  batch_number: string | null
  system_quantity: string
  counted_quantity: string
  variance_quantity: string
}

const SCREEN_KEY = ['physical-stock']
const STATUS: Record<string, string> = { DRAFT: 'Open', POSTED: 'Posted', CANCELLED: 'Cancelled' }
const signed = (value: string | null | undefined) => (Number(value) > 0 ? `+${plain(value)}` : plain(value))

/** Columns every view of a count starts with. */
const PRODUCT_COLUMNS: Column<Line>[] = [
  { header: 'Product', cell: (line) => <Text size="sm" fw={500}>{line.description}</Text> },
  { header: 'Batch', cell: (line) => line.batch_number || '--' },
  { header: 'Rack / Bin', cell: (line) => `${line.rack_code || '--'} / ${line.bin_code || '--'}` },
  { header: 'Expiry', cell: (line) => day(line.expiry_date) },
]

export function PhysicalStock() {
  const [params, setParams] = useSearchParams()
  const asked = Number(params.get('count'))
  const countId = Number.isInteger(asked) && asked > 0 ? asked : null
  const [locationId, setLocationId] = useState<number | null>(null)

  const query = new URLSearchParams()
  if (countId) query.set('count_id', String(countId))
  else if (locationId) query.set('location_id', String(locationId))
  const screen = useQuery({
    queryKey: [...SCREEN_KEY, countId, locationId],
    queryFn: () => api<Screen>(`/api/physical-stock?${query}`),
    placeholderData: keepPreviousData,
  })

  /** Pin the screen to one count (or to none); the address bar says which. */
  const showCount = (id: number | null) => setParams(id ? { count: String(id) } : {}, { replace: true })

  if (screen.isPending) return <PageSkeleton />
  if (screen.isError) return <Alert color="red">{screen.error.message}</Alert>
  const { count, lines, locations } = screen.data

  const header = (
      <PageHeader
        title={count ? `Physical stock ${count.stock_number}` : 'Physical stock'}
        badge={count && <StatusBadge status={STATUS[count.status] ?? count.status} />}
        actions={count && count.status !== 'DRAFT' && <Button variant="default" onClick={() => showCount(null)}>Back to location</Button>}
      >
        {count && (
          <Facts
            items={[
              { label: 'Location', value: count.location_name ?? '--' },
              { label: 'Date', value: day(count.document_date) },
              { label: 'Created by', value: count.creator_name ?? '--' },
              { label: 'Lines', value: lines.length },
            ]}
          />
        )}
      </PageHeader>
  )

  return (
    <Page header={header}>
      {!count && (
        <StartCount locations={locations} locationId={locationId ?? screen.data.location_id} onLocation={setLocationId} />
      )}
      {count?.status === 'DRAFT' && (
        <OpenCount key={count.stock_document_id} count={count} lines={lines} onClosed={showCount} />
      )}
      {count && count.status !== 'DRAFT' && <ClosedCount lines={lines} posted={count.status === 'POSTED'} />}
    </Page>
  )
}

function StartCount(props: {
  locations: Screen['locations']
  locationId: number | null
  onLocation: (id: number) => void
}) {
  const queryClient = useQueryClient()
  const [rack, setRack] = useState('')
  const [bin, setBin] = useState('')
  const start = useMutation({
    mutationFn: () =>
      api('/pharmacy/api/stock/counts', 'POST', {
        location_id: props.locationId, rack_code: rack.trim(), bin_code: bin.trim(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SCREEN_KEY }),
    onError: notifyFailure,
  })
  const newCount = (
    <Button leftSection={<IconPlus size={16} />} onClick={() => start.mutate()} loading={start.isPending} disabled={!props.locationId}>
      New count
    </Button>
  )

  return (
    <>
      <FilterBar>
        <Group align="end">
          <Select
            label="Location"
            data={props.locations.map((location) => ({ value: String(location.location_id), label: location.location_name }))}
            value={props.locationId ? String(props.locationId) : null}
            onChange={(value) => value && props.onLocation(Number(value))}
            allowDeselect={false}
            searchable
            w={260}
          />
          <TextInput label="Rack" placeholder="All racks" value={rack} onChange={(e) => setRack(e.currentTarget.value)} w={140} />
          <TextInput label="Bin" placeholder="All bins" value={bin} onChange={(e) => setBin(e.currentTarget.value)} w={140} />
        </Group>
      </FilterBar>
      <Paper withBorder>
        <EmptyState
          title="No count is open at this location."
          hint="A new count lists the stock on the shelves here, or only one rack or bin if you name it above."
          action={newCount}
        />
      </Paper>
    </>
  )
}

function OpenCount(props: { count: Count; lines: Line[]; onClosed: (id: number | null) => void }) {
  const id = props.count.stock_document_id
  const legacy = `/pharmacy/api/stock/counts/${id}`
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState<Record<number, string>>({}) // quantities typed but not saved yet
  const [search, setSearch] = useState('')
  const [variances, setVariances] = useState<Variance[] | null>(null)
  const [reasons, setReasons] = useState<Record<number, string>>({})
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  const refresh = () => queryClient.invalidateQueries({ queryKey: SCREEN_KEY })

  /** Save what was typed, then show the saved figures before the typed ones are dropped. */
  async function saveAndReload() {
    const lines = Object.entries(typed)
      .filter(([, value]) => value !== '')
      .map(([stock_item_id, counted_quantity]) => ({ stock_item_id: Number(stock_item_id), counted_quantity }))
    if (lines.length) await api(`/api/physical-stock/${id}/lines`, 'PUT', { lines })
    await refresh()
    setTyped({})
  }

  const save = useMutation({
    mutationFn: saveAndReload,
    onSuccess: () => notifySuccess('Count saved.'),
    onError: notifyFailure,
  })

  const finish = useMutation({
    mutationFn: async () => {
      await saveAndReload()
      const trimmed = Object.fromEntries(Object.entries(reasons).map(([line, reason]) => [line, reason.trim()]))
      return api(`${legacy}/close`, 'POST', { reasons: trimmed })
    },
    onSuccess: () => {
      notifySuccess('Count posted.')
      props.onClosed(id) // stay on this count, now showing what was posted
      return refresh()
    },
    onError: (error: Error) => {
      // differences without a reason come back as a list to fill in
      const found = error instanceof ApiError ? (error.body as { variances?: Variance[] } | null)?.variances : null
      if (found) setVariances(found)
      notifyFailure(error)
    },
  })

  const cancel = useMutation({
    mutationFn: () => api(`${legacy}/cancel`, 'POST', {}),
    onSuccess: () => {
      notifySuccess('Count cancelled.')
      props.onClosed(null)
      return refresh()
    },
    onError: notifyFailure,
    onSettled: () => setConfirmingCancel(false),
  })

  const busy = save.isPending || finish.isPending || cancel.isPending
  const needle = search.trim().toLowerCase()
  const shown = props.lines.filter(
    (line) => !needle || `${line.description} ${line.batch_number}`.toLowerCase().includes(needle),
  )
  const counted = props.lines.filter((line) => line.line_status !== 'OPEN').length

  const lineColumns: Column<Line>[] = [
    ...PRODUCT_COLUMNS,
    {
      header: 'Physical qty', align: 'right', width: 150,
      cell: (line) => (
        <NumberInput
          aria-label={`Physical quantity of ${line.description}`}
          value={typed[line.stock_item_id] ?? (line.line_status === 'OPEN' ? '' : plain(line.counted_quantity))}
          onChange={(value) => setTyped({ ...typed, [line.stock_item_id]: String(value) })}
          min={0}
          allowNegative={false}
          decimalScale={3}
          hideControls
          size="xs"
          styles={{ input: { textAlign: 'right' } }}
        />
      ),
    },
    { header: 'Status', width: 130, cell: (line) => <StatusBadge status={line.line_status === 'OPEN' ? 'Not counted' : 'Counted'} /> },
  ]
  const varianceColumns: Column<Variance>[] = [
    { header: 'Product', cell: (v) => <Text size="sm" fw={500}>{v.description}</Text> },
    { header: 'Batch', cell: (v) => v.batch_number || '--' },
    { header: 'System qty', align: 'right', cell: (v) => plain(v.system_quantity) },
    { header: 'Physical qty', align: 'right', cell: (v) => plain(v.counted_quantity) },
    { header: 'Difference', align: 'right', cell: (v) => <Text size="sm" fw={600}>{signed(v.variance_quantity)}</Text> },
    {
      header: 'Reason', width: 280,
      cell: (v) => (
        <TextInput
          aria-label={`Reason for ${v.description}`}
          placeholder="Why the count differs"
          size="xs"
          value={reasons[v.stock_item_id] ?? ''}
          onChange={(e) => setReasons({ ...reasons, [v.stock_item_id]: e.currentTarget.value })}
        />
      ),
    },
  ]

  return (
    <Stack gap="md">
      <FilterBar>
        <Group justify="space-between">
          <TextInput
            aria-label="Search lines"
            placeholder="Search by product or batch"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={320}
          />
          <Text size="sm" c="dimmed">{counted} of {props.lines.length} lines counted</Text>
        </Group>
      </FilterBar>

      <DataTable
        columns={lineColumns}
        rows={shown}
        rowKey={(line) => line.stock_item_id}
        empty={<EmptyState title={needle ? 'No line matches the search.' : 'No stock to count here.'} />}
      />

      {variances && (
        <Stack gap="xs">
          <Text fw={600}>Differences: enter a reason for each, then post.</Text>
          <DataTable columns={varianceColumns} rows={variances} rowKey={(v) => v.stock_item_id} empty={null} />
        </Stack>
      )}

      <Paper withBorder shadow="md" p="md" pos="sticky" bottom={0} style={{ zIndex: 2 }}>
        <Group justify="space-between">
          <Button variant="danger" disabled={busy} onClick={() => setConfirmingCancel(true)}>Cancel count</Button>
          <Group>
            <Button variant="default" disabled={busy} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button disabled={busy} loading={finish.isPending} onClick={() => finish.mutate()}>
              {variances ? 'Post count' : 'Finish count'}
            </Button>
          </Group>
        </Group>
      </Paper>

      <ConfirmDialog
        opened={confirmingCancel}
        title="Cancel count"
        confirm="Cancel count"
        keep="Keep count"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onClose={() => setConfirmingCancel(false)}
      >
        Cancel {props.count.stock_number}? What was counted in it is dropped.
      </ConfirmDialog>
    </Stack>
  )
}

function ClosedCount({ lines, posted }: { lines: Line[]; posted: boolean }) {
  const differences: Column<Line>[] = [
    { header: 'Difference', align: 'right', cell: (line) => signed(line.variance_quantity) },
    { header: 'Reason', cell: (line) => line.reason || '--' },
  ]
  const columns: Column<Line>[] = [
    ...PRODUCT_COLUMNS,
    { header: 'Physical qty', align: 'right', cell: (line) => plain(line.counted_quantity) },
    { header: 'System qty', align: 'right', cell: (line) => plain(line.system_quantity) },
    ...(posted ? differences : []),
  ]
  return (
    <DataTable columns={columns} rows={lines} rowKey={(line) => line.stock_item_id} empty={<EmptyState title="This count has no lines." />} />
  )
}
