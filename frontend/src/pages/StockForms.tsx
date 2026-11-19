/** Stock request, stock adjustment and stock write-off. All three end up changing stock,
 * so they are saved through DocAssist, which holds the stock and approval rules. */
import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import { useWorkLocation } from '../session'
import { ShelfPicker, type Shelf } from '../ShelfPicker'
import {
  day, Facts, notifySuccess, plain, SaveButton, SidePanel,
} from '../ui'

let nextKey = 1

/** Saves a stock form, refreshes the registers and the stock, says what was saved, closes. */
function useSave(path: string, body: () => unknown, saved: (reply: Record<string, string>) => string, onClose: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<Record<string, string>>(`/pharmacy/api/stock/${path}`, 'POST', body()),
    onSuccess: async (reply) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-documents'] }), queryClient.invalidateQueries({ queryKey: ['overall-stock'] })])
      notifySuccess(saved(reply))
      onClose()
    },
  })
}

/** The bottom of every stock form: what is still missing, and the one button. */
function Footer(props: { problem: string | null; error: Error | null; loading: boolean; label: string }) {
  return (
    <>
      {props.error && <Alert color="red">{props.error.message}</Alert>}
      <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
        <SaveButton problem={props.problem} type="submit" loading={props.loading}>{props.label}</SaveButton>
      </Group>
    </>
  )
}

/** A table of rows that can be added to and removed from. */
function Rows<Row extends { key: number }>(props: {
  headers: ReactNode
  rows: Row[]
  render: (row: Row) => ReactNode
  onChange: (rows: Row[]) => void
  blank: () => Row
}) {
  return (
    <>
      <Table withTableBorder highlightOnHover={false}>
        <Table.Thead bg="gray.0"><Table.Tr>{props.headers}<Table.Th w={44} /></Table.Tr></Table.Thead>
        <Table.Tbody>
          {props.rows.map((row) => (
            <Table.Tr key={row.key}>
              {props.render(row)}
              <Table.Td>
                <ActionIcon variant="default" aria-label="Remove row" disabled={props.rows.length === 1}
                  onClick={() => props.onChange(props.rows.filter((other) => other.key !== row.key))}><IconTrash size={16} /></ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group><Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => props.onChange([...props.rows, props.blank()])}>Add row</Button></Group>
    </>
  )
}

const quantityBox = (label: string, value: string, onChange: (value: string) => void) => (
  <NumberInput aria-label={label} size="xs" min={0} allowNegative={false} decimalScale={3} hideControls value={value}
    onChange={(typed) => onChange(String(typed))} styles={{ input: { textAlign: 'right' } }} />
)

/** Stock request: one location asks another for products. Nothing moves until the request is fulfilled. */
export function StockRequestForm({ onClose }: { onClose: () => void }) {
  interface Line { key: number; product: OrderProduct | null; quantity: string }
  const blank = (): Line => ({ key: nextKey++, product: null, quantity: '' })
  const { locations, locationId } = useWorkLocation()
  const [pickedTo, setTo] = useState<string | null>(null)
  const to = pickedTo ?? locationId // the location that needs the stock: by default where the user works
  const [from, setFrom] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([blank()])
  const set = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const used = lines.filter((line) => line.product)
  const problem = !from ? 'Select the location to request from.'
    : from === to ? 'The two locations must differ.'
      : !used.length ? 'Add at least one product.'
        : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.' : null
  const save = useSave('indent', () => ({
    from_location_id: from, to_location_id: to, notes: notes.trim(),
    items: used.map((line) => ({ item_id: line.product!.item_id, quantity: line.quantity, unit: line.product!.unit_of_measure })),
  }), (reply) => `Stock request ${reply.stock_number ?? ''} saved.`, onClose)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New stock request" size={860} onClose={onClose}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select label="Request from" placeholder="Select location" data={locations.filter((l) => l.value !== to)} value={from} onChange={setFrom} searchable />
            <Select label="Deliver to" data={locations} value={to} onChange={setTo} allowDeselect={false} searchable />
            <TextInput label="Notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
          </SimpleGrid>
          <Rows rows={lines} onChange={setLines} blank={blank}
            headers={<><Table.Th>Product</Table.Th><Table.Th w={130} ta="right">Quantity</Table.Th></>}
            render={(line) => (
              <>
                <Table.Td><ProductPicker label="Product" value={line.product} onChange={(product) => set(line.key, { product })} /></Table.Td>
                <Table.Td>{quantityBox('Quantity', line.quantity, (quantity) => set(line.key, { quantity }))}</Table.Td>
              </>
            )} />
          <Footer problem={problem} error={save.error} loading={save.isPending} label="Save request" />
        </Stack>
      </form>
    </SidePanel>
  )
}

/** Stock write-off: stock that is damaged, expired or lost. It waits for approval before any stock changes. */
export function WriteOffForm({ onClose }: { onClose: () => void }) {
  interface Line { key: number; shelf: Shelf | null; quantity: string; reason: string }
  const blank = (): Line => ({ key: nextKey++, shelf: null, quantity: '', reason: '' })
  const { locations, locationId } = useWorkLocation()
  const [picked, setLocation] = useState<string | null>(null)
  const location = picked ?? locationId
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([blank()])
  const set = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const used = lines.filter((line) => line.shelf)
  const problem = !used.length ? 'Add at least one batch to write off.'
    : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.'
      : used.some((line) => Number(line.quantity) > Number(line.shelf!.quantity_on_hand)) ? 'A quantity is more than is on the shelf.'
        : used.some((line) => !line.reason.trim()) ? 'Enter a reason on every row.' : null
  const save = useSave('write-off', () => ({
    notes: notes.trim(),
    lines: used.map((line) => ({ stock_balance_id: line.shelf!.stock_balance_id, quantity: line.quantity, reason: line.reason.trim(), pile: 'ON_HAND' })),
  }), (reply) => `Write-off ${reply.stock_number ?? ''} sent for approval.`, onClose)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New stock write-off" size={1080} onClose={onClose}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select label="Location" data={locations} value={location} allowDeselect={false} searchable onChange={(value) => { setLocation(value); setLines([blank()]) }} />
            <TextInput label="Notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} style={{ gridColumn: 'span 2' }} />
          </SimpleGrid>
          <Rows rows={lines} onChange={setLines} blank={blank}
            headers={<><Table.Th>Product and batch</Table.Th><Table.Th w={100} ta="right">On shelf</Table.Th><Table.Th w={110} ta="right">Write off</Table.Th><Table.Th w={280}>Reason</Table.Th></>}
            render={(line) => (
              <>
                <Table.Td><ShelfPicker label="Product and batch" locationId={location} value={line.shelf} onChange={(shelf) => set(line.key, { shelf })} /></Table.Td>
                <Table.Td ta="right">{line.shelf ? plain(line.shelf.quantity_on_hand) : '--'}</Table.Td>
                <Table.Td>{quantityBox('Quantity to write off', line.quantity, (quantity) => set(line.key, { quantity }))}</Table.Td>
                <Table.Td><TextInput aria-label="Reason" size="xs" placeholder="Damaged, expired, lost" value={line.reason} onChange={(e) => set(line.key, { reason: e.currentTarget.value })} /></Table.Td>
              </>
            )} />
          <Footer problem={problem} error={save.error} loading={save.isPending} label="Send for approval" />
        </Stack>
      </form>
    </SidePanel>
  )
}

/** Stock adjustment: the shelf holds a different quantity than the book says. One batch at a time; it waits for approval. */
export function AdjustmentForm({ onClose }: { onClose: () => void }) {
  const { locations, locationId } = useWorkLocation()
  const [picked, setLocation] = useState<string | null>(null)
  const location = picked ?? locationId
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [physical, setPhysical] = useState('')
  const [reason, setReason] = useState('')
  const book = shelf ? Number(shelf.quantity_on_hand) : null
  const problem = !shelf ? 'Pick the product and batch.'
    : physical === '' ? 'Enter the physical qty.'
      : Number(physical) === book ? `Physical qty equals system qty (${plain(book)}): nothing to adjust.`
        : !reason.trim() ? 'Enter the reason.' : null
  const save = useSave('documents', () => ({
    stock_type: 'STOCK_ADJUSTMENT', submit_for_approval: true,
    lines: [{ stock_balance_id: shelf!.stock_balance_id, physical_quantity: physical, reason: reason.trim() }],
  }), (reply) => `Adjustment ${reply.stock_number ?? ''} sent for approval.`, onClose)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New stock adjustment" size={640} onClose={onClose}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <Select label="Location" data={locations} value={location} allowDeselect={false} searchable onChange={(value) => { setLocation(value); setShelf(null) }} />
          <div>
            <Text size="sm" fw={500} mb={4}>Product and batch</Text>
            <ShelfPicker label="Product and batch" locationId={location} value={shelf} onChange={setShelf} />
          </div>
          {shelf && (
            <Facts items={[
              { label: 'Batch', value: shelf.batch_number || '--' }, { label: 'Expiry', value: day(shelf.expiry_date) },
              { label: 'System qty', value: plain(shelf.quantity_on_hand) },
              ...(physical !== '' ? [{ label: 'Difference', value: plain(Number(physical) - Number(shelf.quantity_on_hand)) }] : []),
            ]} />
          )}
          <NumberInput label="Physical qty" min={0} allowNegative={false} decimalScale={3} hideControls value={physical} onChange={(value) => setPhysical(String(value))} />
          <TextInput label="Reason" maxLength={255} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <Footer problem={problem} error={save.error} loading={save.isPending} label="Send for approval" />
        </Stack>
      </form>
    </SidePanel>
  )
}

/** Issuing a stock request: how much of each requested row goes out now, as a transfer or an internal issue. */
export function RequestFulfilForm({ id, number, onClose }: { id: number; number: string; onClose: () => void }) {
  type Doc = components['schemas']['StockDocument']
  const found = useQuery({ queryKey: ['stock-document', id], queryFn: () => api<Doc>(`/api/stock/documents/${id}`) })
  const left = (line: Doc['lines'][number]) => Math.max(Number(line.requested_quantity ?? 0) - Number(line.issued_quantity ?? 0), 0)
  const lines = (found.data?.lines ?? []).filter((line) => left(line) > 0)
  // each row starts at everything that is left, as on the old screen
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [issueAs, setIssueAs] = useState('TRANSFER')
  const asked = (line: Doc['lines'][number]) => typed[line.stock_item_id] ?? String(left(line))
  const going = lines.filter((line) => Number(asked(line)) > 0)
  const problem = !lines.length ? 'This request is fully issued.'
    : lines.some((line) => asked(line) === '') ? 'Enter a quantity on every row.'
      : lines.some((line) => Number(asked(line)) > left(line)) ? 'Issue quantity is more than the quantity left.'
        : !going.length ? 'Enter a quantity on at least one row.' : null
  const save = useSave(`indent/${id}/fulfil`, () => ({
    document_type: issueAs, items: going.map((line) => ({ stock_item_id: line.stock_item_id, quantity: asked(line) })),
  }), (reply) => `Request ${number} issued${reply.transfer_number ? ` as ${reply.transfer_number}` : ''}.`, onClose)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="Issue stock request" subject={number} size={860} onClose={onClose} loading={found.isPending} error={found.error}>
      {found.data && (
        <form onSubmit={submit}>
          <Stack gap="md">
            <Facts items={[
              { label: 'Issue from', value: found.data.from_location_name ?? '--' }, { label: 'Deliver to', value: found.data.to_location_name ?? '--' },
              { label: 'Date', value: day(found.data.document_date) }, { label: 'Requested by', value: found.data.creator_name ?? '--' },
            ]} />
            <Table withTableBorder highlightOnHover={false}>
              <Table.Thead bg="gray.0">
                <Table.Tr>
                  <Table.Th>Product</Table.Th><Table.Th ta="right">Requested</Table.Th><Table.Th ta="right">Issued</Table.Th>
                  <Table.Th ta="right">Left</Table.Th><Table.Th w={130} ta="right">Issue qty</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lines.map((line) => (
                  <Table.Tr key={line.stock_item_id}>
                    <Table.Td><Text size="sm" fw={500}>{line.description}</Text></Table.Td>
                    <Table.Td ta="right">{plain(line.requested_quantity)}</Table.Td>
                    <Table.Td ta="right">{plain(line.issued_quantity)}</Table.Td>
                    <Table.Td ta="right" fw={600}>{plain(left(line))}</Table.Td>
                    <Table.Td>{quantityBox(`Issue quantity of ${line.description}`, asked(line), (quantity) => setTyped({ ...typed, [line.stock_item_id]: quantity }))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Select label="Issue as" value={issueAs} onChange={(value) => setIssueAs(value ?? 'TRANSFER')} allowDeselect={false} maw={260}
              data={[{ value: 'TRANSFER', label: 'Stock transfer' }, { value: 'INTERNAL_ISSUE', label: 'Internal issue' }]} />
            <Footer problem={problem} error={save.error} loading={save.isPending} label="Issue" />
          </Stack>
        </form>
      )}
    </SidePanel>
  )
}

interface Bin { storage_bin_id: number; location_id: number; rack_code: string | null; bin_code: string | null; rack_name: string | null; bin_name: string | null; is_active: number }

/** Stock relocation: batches moved to another rack or bin of the same location. It stays pending until confirmed. */
export function RelocationForm({ onClose }: { onClose: () => void }) {
  interface Line { key: number; shelf: Shelf | null; quantity: string }
  const blank = (): Line => ({ key: nextKey++, shelf: null, quantity: '' })
  const { locations, locationId } = useWorkLocation()
  const [picked, setLocation] = useState<string | null>(null)
  const location = picked ?? locationId
  const bins = useQuery({ queryKey: ['masters', 'storage_bins', 'all'], queryFn: () => api<{ rows: Bin[] }>('/api/masters/storage_bins?limit=100'), staleTime: 60_000 })
  const [toBin, setToBin] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([blank()])
  const set = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const places = (bins.data?.rows ?? []).filter((bin) => String(bin.location_id) === location && bin.is_active)
    .map((bin) => ({ value: String(bin.storage_bin_id), label: `${bin.rack_name || bin.rack_code || '--'} / ${bin.bin_name || bin.bin_code || '--'}` }))
  const used = lines.filter((line) => line.shelf)
  const problem = !location ? 'Select the location.'
    : !toBin ? 'Select the rack / bin to move to.'
      : !used.length ? 'Add at least one row.'
        : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.'
          : used.some((line) => Number(line.quantity) > Number(line.shelf!.quantity_on_hand)) ? 'A quantity is more than is on the shelf.' : null
  const save = useSave('relocations', () => ({
    from_location_id: location, to_location_id: location, to_storage_bin_id: Number(toBin), notes: notes.trim(),
    items: used.map((line) => ({ stock_balance_id: line.shelf!.stock_balance_id, quantity: line.quantity })),
  }), (reply) => `Stock relocation ${reply.stock_number ?? ''} saved. Pending.`, onClose)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New stock relocation" size={1080} onClose={onClose} loading={bins.isPending} error={bins.error}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select label="Location" data={locations} value={location} allowDeselect={false} searchable onChange={(value) => { setLocation(value); setToBin(null); setLines([blank()]) }} />
            <Select label="To rack / bin" placeholder={places.length ? 'Select rack / bin' : 'This location has no racks or bins'} data={places} value={toBin} onChange={setToBin} searchable />
            <TextInput label="Notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
          </SimpleGrid>
          <Rows rows={lines} onChange={setLines} blank={blank}
            headers={<><Table.Th>Product and batch</Table.Th><Table.Th w={160}>From rack / bin</Table.Th><Table.Th w={110} ta="right">Qty in stock</Table.Th><Table.Th w={110} ta="right">Quantity</Table.Th></>}
            render={(line) => (
              <>
                <Table.Td><ShelfPicker label="Product and batch" locationId={location} value={line.shelf} onChange={(shelf) => set(line.key, { shelf })} /></Table.Td>
                <Table.Td>{line.shelf ? `${line.shelf.rack_code || '--'} / ${line.shelf.bin_code || '--'}` : '--'}</Table.Td>
                <Table.Td ta="right">{line.shelf ? plain(line.shelf.quantity_on_hand) : '--'}</Table.Td>
                <Table.Td>{quantityBox('Quantity to move', line.quantity, (quantity) => set(line.key, { quantity }))}</Table.Td>
              </>
            )} />
          <Footer problem={problem} error={save.error} loading={save.isPending} label="Save relocation" />
        </Stack>
      </form>
    </SidePanel>
  )
}
