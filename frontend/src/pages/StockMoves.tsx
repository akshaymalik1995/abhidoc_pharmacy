/** New stock issue and new stock transfer: batches picked from the shelves of one location.
 * Both move stock, so they are saved through DocAssist, which holds the stock rules. */
import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api } from '../api'
import { useWorkLocation } from '../session'
import { ShelfPicker, type Shelf } from '../ShelfPicker'
import {
  day, notifySuccess, plain, SaveButton, SidePanel,
} from '../ui'

export type MoveKind = 'issue' | 'transfer'
interface Line { key: number; shelf: Shelf | null; quantity: string; reason: string }
let nextKey = 1
const emptyLine = (): Line => ({ key: nextKey++, shelf: null, quantity: '', reason: '' })

export function StockMoveForm({ kind, onClose }: { kind: MoveKind; onClose: () => void }) {
  const transfer = kind === 'transfer'
  const queryClient = useQueryClient()
  const { locations, locationId } = useWorkLocation()
  // until the user picks one, the From location follows the working location of the top bar
  const [pickedFrom, setFrom] = useState<string | null>(null)
  const from = pickedFrom ?? locationId
  const [to, setTo] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const setLine = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))

  const used = lines.filter((line) => line.shelf)
  const problem = !from ? 'Select the From location.'
    : transfer && !to ? 'Select the To location.'
      : transfer && to === from ? 'The From location and the To location must differ.'
        : !used.length ? `Add at least one product to ${kind}.`
          : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.'
            : used.some((line) => Number(line.quantity) > Number(line.shelf!.quantity_on_hand)) ? 'A quantity is more than is on the shelf.'
              : null

  const save = useMutation({
    mutationFn: () => api<{ stock_number?: string }>(`/pharmacy/api/stock/${kind}`, 'POST', {
      from_location_id: from, ...(transfer ? { to_location_id: to } : {}), notes: notes.trim(),
      items: used.map((line) => ({
        item_id: line.shelf!.item_id, batch_id: line.shelf!.batch_id, quantity: line.quantity,
        ...(transfer ? {} : { reason: line.reason.trim() }),
      })),
    }),
    onSuccess: async (reply) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-documents'] }), queryClient.invalidateQueries({ queryKey: ['overall-stock'] })])
      notifySuccess(`${transfer ? 'Stock transfer' : 'Stock issue'} ${reply.stock_number ?? ''} saved.`)
      onClose()
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title={transfer ? 'New stock transfer' : 'New stock issue'} size={1080} onClose={onClose}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            {/* changing the From location empties the rows: their batches belong to the old one */}
            <Select label="From location" data={locations} value={from} allowDeselect={false} searchable
              onChange={(value) => { setFrom(value); setLines([emptyLine()]) }} />
            {transfer && <Select label="To location" placeholder="Select location" data={locations.filter((l) => l.value !== from)} value={to} onChange={setTo} searchable />}
            <TextInput label="Notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} style={{ gridColumn: 'span 2' }} />
          </SimpleGrid>
          <Table withTableBorder highlightOnHover={false}>
            <Table.Thead bg="gray.0">
              <Table.Tr>
                <Table.Th>Product and batch</Table.Th><Table.Th w={120}>Expiry</Table.Th><Table.Th w={100} ta="right">On shelf</Table.Th>
                <Table.Th w={110} ta="right">Quantity</Table.Th>{!transfer && <Table.Th w={260}>Reason</Table.Th>}<Table.Th w={44} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((line) => (
                <Table.Tr key={line.key}>
                  <Table.Td><ShelfPicker label="Product and batch" locationId={from} value={line.shelf} onChange={(shelf) => setLine(line.key, { shelf })} /></Table.Td>
                  <Table.Td>{line.shelf ? day(line.shelf.expiry_date) : '--'}</Table.Td>
                  <Table.Td ta="right">{line.shelf ? plain(line.shelf.quantity_on_hand) : '--'}</Table.Td>
                  <Table.Td>
                    <NumberInput aria-label="Quantity" size="xs" min={0} allowNegative={false} decimalScale={3} hideControls value={line.quantity}
                      onChange={(value) => setLine(line.key, { quantity: String(value) })} styles={{ input: { textAlign: 'right' } }} />
                  </Table.Td>
                  {!transfer && <Table.Td><TextInput aria-label="Reason" size="xs" value={line.reason} onChange={(e) => setLine(line.key, { reason: e.currentTarget.value })} /></Table.Td>}
                  <Table.Td>
                    <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1} onClick={() => setLines(lines.filter((other) => other.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group>
            <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, emptyLine()])}>Add row</Button>
          </Group>
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <SaveButton problem={problem} type="submit" loading={save.isPending}>Save {transfer ? 'transfer' : 'issue'}</SaveButton>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}
