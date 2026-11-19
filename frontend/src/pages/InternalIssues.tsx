/** Internal stock issue: stock handed to a ward, a department or a doctor, and what comes back from it.
 * Both move stock, so they are saved through DocAssist, which holds the stock rules. */
import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { useWorkLocation } from '../session'
import { ShelfPicker, type Shelf } from '../ShelfPicker'
import {
  day, Facts, notifySuccess, plain, SaveButton, SidePanel,
} from '../ui'

type Doc = components['schemas']['StockDocument']

interface Options {
  departments: { department_id: number; department_name: string }[]
  referral_doctors: { doctor_id: number; doctor_name: string }[]
}
interface Place { location_id: number; location_name: string; is_internal_issue_location: number; is_active: number }
interface Line { key: number; shelf: Shelf | null; quantity: string }
let nextKey = 1
const blank = (): Line => ({ key: nextKey++, shelf: null, quantity: '' })
const today = () => new Date().toLocaleDateString('en-CA')

function useRefresh() {
  const queryClient = useQueryClient()
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['stock-documents'] }), queryClient.invalidateQueries({ queryKey: ['stock-document'] }),
    queryClient.invalidateQueries({ queryKey: ['overall-stock'] }),
  ])
}

export function InternalIssueForm({ onClose }: { onClose: () => void }) {
  const refresh = useRefresh()
  const { locations, locationId } = useWorkLocation()
  const options = useQuery({ queryKey: ['internal-issue-options'], queryFn: () => api<Options>('/pharmacy/api/stock/internal-issues/options'), staleTime: 60_000 })
  // the places stock can be issued to are the locations marked for internal issue in Masters
  const places = useQuery({ queryKey: ['masters', 'stock_locations', 'all'], queryFn: () => api<{ rows: Place[] }>('/api/masters/stock_locations?limit=100'), staleTime: 60_000 })
  const issuePlaces = (places.data?.rows ?? []).filter((p) => p.is_internal_issue_location && p.is_active).map((p) => ({ value: String(p.location_id), label: p.location_name }))

  const [pickedFrom, setFrom] = useState<string | null>(null)
  const from = pickedFrom ?? locationId
  const [head, setHead] = useState({ to: '', date: today(), reference: '', department: '', doctor: '', notes: '' })
  const [lines, setLines] = useState<Line[]>([blank()])
  const setField = (name: keyof typeof head, value: string | null) => setHead({ ...head, [name]: value ?? '' })
  const setLine = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const used = lines.filter((line) => line.shelf)
  const problem = !head.to ? 'Select the To location.'
    : !used.length ? 'Add at least one product.'
      : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.'
        : used.some((line) => Number(line.quantity) > Number(line.shelf!.quantity_on_hand)) ? 'A quantity is more than is on the shelf.' : null

  const save = useMutation({
    mutationFn: () => api<{ stock_number?: string }>('/pharmacy/api/stock/internal-issue', 'POST', {
      from_location_id: from, internal_issue_location_id: head.to, requested_date: head.date, reference_number: head.reference.trim() || null,
      department_id: head.department || null, referral_doctor_id: head.doctor || null, notes: head.notes.trim() || null,
      items: used.map((line) => ({ item_id: line.shelf!.item_id, batch_id: line.shelf!.batch_id, quantity: line.quantity })),
    }),
    onSuccess: async (reply) => { await refresh(); notifySuccess(`Internal issue ${reply.stock_number ?? ''} saved.`); onClose() },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="New internal stock issue" size={1080} onClose={onClose} loading={options.isPending || places.isPending} error={options.error ?? places.error}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            <Select label="From location" data={locations} value={from} allowDeselect={false} searchable onChange={(value) => { setFrom(value); setLines([blank()]) }} />
            <Select label="To location" placeholder="Select location" data={issuePlaces} value={head.to || null} onChange={(v) => setField('to', v)} searchable />
            <TextInput label="Date" type="date" value={head.date} onChange={(e) => setField('date', e.currentTarget.value)} />
            <TextInput label="Reference no." value={head.reference} onChange={(e) => setField('reference', e.currentTarget.value)} />
            <Select label="Department" placeholder="None" clearable searchable value={head.department || null} onChange={(v) => setField('department', v)}
              data={(options.data?.departments ?? []).map((d) => ({ value: String(d.department_id), label: d.department_name }))} />
            <Select label="Referral doctor" placeholder="None" clearable searchable value={head.doctor || null} onChange={(v) => setField('doctor', v)}
              data={(options.data?.referral_doctors ?? []).map((d) => ({ value: String(d.doctor_id), label: d.doctor_name }))} />
            <TextInput label="Reason" value={head.notes} onChange={(e) => setField('notes', e.currentTarget.value)} style={{ gridColumn: 'span 2' }} />
          </SimpleGrid>
          <Table withTableBorder highlightOnHover={false}>
            <Table.Thead bg="gray.0">
              <Table.Tr><Table.Th>Product and batch</Table.Th><Table.Th w={120}>Expiry</Table.Th><Table.Th w={100} ta="right">On shelf</Table.Th><Table.Th w={110} ta="right">Qty</Table.Th><Table.Th w={44} /></Table.Tr>
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
            <SaveButton problem={problem} type="submit" loading={save.isPending}>Save issue</SaveButton>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}

/** What comes back from an internal issue: a quantity per issued row, never more than is still out. */
export function IssueReturnForm({ id, number, onClose }: { id: number; number: string; onClose: () => void }) {
  const refresh = useRefresh()
  const found = useQuery({ queryKey: ['stock-document', id], queryFn: () => api<Doc>(`/api/stock/documents/${id}`) })
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState('')
  const out = (line: Doc['lines'][number]) => Number(line.issued_quantity ?? 0) - Number(line.return_quantity ?? 0)
  const lines = (found.data?.lines ?? []).filter((line) => out(line) > 0)
  const returning = lines.filter((line) => Number(typed[line.stock_item_id]) > 0)
  const problem = !returning.length ? 'Enter a return quantity on at least one row.'
    : returning.some((line) => Number(typed[line.stock_item_id]) > out(line)) ? 'A return quantity is more than is still out.' : null

  const save = useMutation({
    mutationFn: () => api<{ stock_number?: string }>(`/pharmacy/api/stock/internal-issue/${id}/return`, 'POST', {
      notes: notes.trim(), items: returning.map((line) => ({ stock_item_id: line.stock_item_id, quantity: typed[line.stock_item_id] })),
    }),
    onSuccess: async (reply) => { await refresh(); notifySuccess(`Return ${reply.stock_number ?? ''} saved.`); onClose() },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <SidePanel title="Return from internal issue" subject={number} size={860} onClose={onClose} loading={found.isPending} error={found.error}>
      {found.data && (
        <form onSubmit={submit}>
          <Stack gap="md">
            <Facts items={[
              { label: 'Issued from', value: found.data.from_location_name ?? '--' },
              { label: 'Issued to', value: found.data.internal_issue_location_name ?? found.data.to_location_name ?? '--' },
              { label: 'Date', value: day(found.data.document_date) },
            ]} />
            <Table withTableBorder highlightOnHover={false}>
              <Table.Thead bg="gray.0">
                <Table.Tr><Table.Th>Product</Table.Th><Table.Th>Batch / expiry</Table.Th><Table.Th ta="right">Still out</Table.Th><Table.Th w={120} ta="right">Return qty</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lines.map((line) => (
                  <Table.Tr key={line.stock_item_id}>
                    <Table.Td><Text size="sm" fw={500}>{line.description}</Text></Table.Td>
                    <Table.Td>{line.batch_number || '--'}, {day(line.expiry_date)}</Table.Td>
                    <Table.Td ta="right">{plain(out(line))} of {plain(line.issued_quantity)}</Table.Td>
                    <Table.Td>
                      <NumberInput aria-label={`Return quantity of ${line.description}`} size="xs" min={0} allowNegative={false} decimalScale={3} hideControls
                        value={typed[line.stock_item_id] ?? ''} onChange={(value) => setTyped({ ...typed, [line.stock_item_id]: String(value) })} styles={{ input: { textAlign: 'right' } }} />
                    </Table.Td>
                  </Table.Tr>
                ))}
                {!lines.length && <Table.Tr><Table.Td colSpan={4}><Text size="sm" c="dimmed">Everything issued has come back.</Text></Table.Td></Table.Tr>}
              </Table.Tbody>
            </Table>
            <TextInput label="Notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
            {save.isError && <Alert color="red">{save.error.message}</Alert>}
            <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
              <SaveButton problem={problem} type="submit" loading={save.isPending}>Save return</SaveButton>
            </Group>
          </Stack>
        </form>
      )}
    </SidePanel>
  )
}
