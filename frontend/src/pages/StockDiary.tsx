import { Alert, Group, Stack, Text, TextInput } from '@mantine/core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { DataTable, EmptyState, Facts, movementWords, plain, SidePanel, type Column } from '../ui'

type Diary = components['schemas']['Diary']
type Line = components['schemas']['DiaryLine']

const when = (value: string) =>
  new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const COLUMNS: Column<Line>[] = [
  { header: 'Date', cell: (line) => when(line.created_at) },
  {
    header: 'Movement',
    cell: (line) => (
      <>
        <Text size="sm">{movementWords(line)}</Text>
        <Text size="xs" c="dimmed">{[line.batch_number && `Batch ${line.batch_number}`, line.location_name, line.notes].filter(Boolean).join(', ')}</Text>
      </>
    ),
  },
  { header: 'Document no.', cell: (line) => line.stock_number || '--' },
  { header: 'In', align: 'right', cell: (line) => (Number(line.quantity_change) > 0 ? plain(line.quantity_change) : '--') },
  { header: 'Out', align: 'right', cell: (line) => (Number(line.quantity_change) < 0 ? plain(-Number(line.quantity_change)) : '--') },
  { header: 'Balance', align: 'right', cell: (line) => <Text size="sm" fw={600}>{plain(line.running_quantity)}</Text> },
]

/** Every movement of one product, opened from a stock list. `locationId` keeps it to one store. */
export function StockDiary(props: { itemId: number; itemName: string; locationId?: string; from?: string; to?: string; onClose: () => void }) {
  const [from, setFrom] = useState(props.from ?? '')
  const [to, setTo] = useState(props.to ?? '')
  const query = new URLSearchParams()
  if (from) query.set('from_date', from)
  if (to) query.set('to_date', to)
  if (props.locationId) query.set('location_id', props.locationId)
  const diary = useQuery({
    queryKey: ['stock-diary', props.itemId, query.toString()],
    queryFn: () => api<Diary>(`/api/stock/ledger/${props.itemId}/diary?${query}`),
    placeholderData: keepPreviousData,
  })
  const data = diary.data
  // opening stock that no recorded movement explains is said, not hidden
  const unexplained = data && Number(data.opening_quantity) !== 0 && (!from || !data.first_movement || from < data.first_movement)

  return (
    <SidePanel onClose={props.onClose} size={860} title="Movements" subject={props.itemName} viewOnly>
      <Stack gap="md">
        <Group align="end">
          <TextInput label="From date" type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </Group>
        {diary.isError && <Alert color="red">{diary.error.message}</Alert>}
        {data && (
          <Facts
            items={[
              { label: 'Opening', value: plain(data.opening_quantity) }, { label: 'In', value: plain(data.in_quantity) },
              { label: 'Out', value: plain(data.out_quantity) }, { label: 'Closing', value: plain(data.closing_quantity) },
            ]}
          />
        )}
        {unexplained && (
          <Text size="sm" c="dimmed">
            {data.first_movement
              ? `Opening quantity includes stock from before the first recorded movement.`
              : 'Opening quantity includes stock without recorded movements.'}
          </Text>
        )}
        <DataTable
          columns={COLUMNS}
          rows={data?.lines ?? []}
          rowKey={(line) => `${line.created_at}-${line.running_quantity}-${line.quantity_change}`}
          loading={diary.isFetching}
          empty={<EmptyState title="No movements found." />}
        />
        {data?.lines.length === 500 && <Text size="sm" c="dimmed">Only the first 500 movements of the period are shown. Narrow the dates.</Text>}
      </Stack>
    </SidePanel>
  )
}
