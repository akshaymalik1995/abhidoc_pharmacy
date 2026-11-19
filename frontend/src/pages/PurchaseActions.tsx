/** What is done to a saved purchase document: goods received against an order, goods sent back from a receipt.
 * Both change stock, so both are saved through DocAssist, which holds the stock rules. */
import { Alert, Group, NumberInput, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { useWorkLocation } from '../session'
import {
  day, Facts, money, notifySuccess, plain, SaveButton, SidePanel, StatusBadge,
} from '../ui'

const words = (code: string) => code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

type Document = components['schemas']['Document']
type Line = components['schemas']['PurchaseLine']

const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100)
const left = (a: string | null | undefined, b: string | null | undefined) => Number(a ?? 0) - Number(b ?? 0)

function useDocument(id: number) {
  return useQuery({ queryKey: ['purchase-document', id], queryFn: () => api<Document>(`/api/purchase/documents/${id}`) })
}

/** The drawer both forms share: the document's facts on top, the form below, the buttons pinned. */
function ActionDrawer(props: {
  title: string
  id: number
  onClose: () => void
  children: (doc: Document) => ReactNode
}) {
  const found = useDocument(props.id)
  return (
    <SidePanel onClose={props.onClose} size={1080} title={props.title} subject={found.data?.purchase_number}
      badge={found.data && <StatusBadge status={words(found.data.status)} />} loading={found.isPending} error={found.error}>
      {found.data && props.children(found.data)}
    </SidePanel>
  )
}

function useSaved(onClose: () => void, message: (reply: Record<string, string>) => string) {
  const queryClient = useQueryClient()
  return async (reply: Record<string, string>) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['purchase-documents'] }),
      queryClient.invalidateQueries({ queryKey: ['purchase-document'] }),
      queryClient.invalidateQueries({ queryKey: ['overall-stock'] }),
    ])
    notifySuccess(message(reply))
    onClose()
  }
}

interface Receiving { quantity: string; free: string; batch: string; expiry: string; unitCost: string; unitMrp: string }

export function GoodsReceiptForm({ id, onClose }: { id: number; onClose: () => void }) {
  return (
    <ActionDrawer title="Receive goods" id={id} onClose={onClose}>
      {(doc) => <ReceiptBody doc={doc} onClose={onClose} />}
    </ActionDrawer>
  )
}

function ReceiptBody({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const { locationId } = useWorkLocation()
  const open = doc.lines.filter((line) => left(line.ordered_quantity, line.received_quantity) > 0)
  const [head, setHead] = useState({ supplier_invoice_number: '', supplier_invoice_date: '', due_date: '', notes: '' })
  const [rows, setRows] = useState<Record<number, Receiving>>(() => Object.fromEntries(open.map((line) => [line.purchase_item_id, {
    quantity: '', free: '', batch: '', expiry: '',
    unitCost: String((line.unit_cost_cents ?? 0) / 100), unitMrp: String((line.unit_mrp_cents ?? 0) / 100),
  }])))
  const set = (line: Line, change: Partial<Receiving>) => setRows({ ...rows, [line.purchase_item_id]: { ...rows[line.purchase_item_id], ...change } })
  const receiving = open.filter((line) => Number(rows[line.purchase_item_id].quantity) > 0)
  const problem = !receiving.length ? 'Enter a receive quantity on at least one row.'
    : receiving.some((line) => Number(rows[line.purchase_item_id].quantity) > left(line.ordered_quantity, line.received_quantity)) ? 'A receive quantity is more than is left on the order.'
      : receiving.some((line) => !rows[line.purchase_item_id].batch.trim() || !rows[line.purchase_item_id].expiry) ? 'Enter batch and expiry on every row received.'
        : null

  const saved = useSaved(onClose, (reply) => `Goods receipt ${reply.grn_number ?? reply.purchase_number ?? ''} saved.`)
  const save = useMutation({
    mutationFn: () => api<Record<string, string>>(`/pharmacy/api/purchase/${doc.purchase_document_id}/receive`, 'POST', {
      ...head, location_id: locationId,
      items: receiving.map((line) => {
        const row = rows[line.purchase_item_id]
        return {
          purchase_item_id: line.purchase_item_id, received_quantity: row.quantity, free_quantity: row.free,
          batch_number: row.batch.trim(), expiry_date: row.expiry, unit_cost_cents: paise(row.unitCost), unit_mrp_cents: paise(row.unitMrp),
        }
      }),
    }),
    onSuccess: saved,
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }
  const box = (line: Line, name: 'quantity' | 'free' | 'unitCost' | 'unitMrp', label: string, scale: number) => (
    <NumberInput aria-label={`${label} of ${line.description}`} size="xs" min={0} allowNegative={false} decimalScale={scale} hideControls
      value={rows[line.purchase_item_id][name]} onChange={(value) => set(line, { [name]: String(value) })} styles={{ input: { textAlign: 'right' } }} />
  )

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <Facts items={[
          { label: 'Order', value: doc.purchase_number ?? '--' }, { label: 'Supplier', value: doc.supplier_name ?? '--' },
          { label: 'Order date', value: day(doc.document_date) }, { label: 'Order value', value: money(doc.net_amount_cents) },
        ]} />
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
          <TextInput label="Supplier invoice no." value={head.supplier_invoice_number} onChange={(e) => setHead({ ...head, supplier_invoice_number: e.currentTarget.value })} />
          <TextInput label="Invoice date" type="date" value={head.supplier_invoice_date} onChange={(e) => setHead({ ...head, supplier_invoice_date: e.currentTarget.value })} />
          <TextInput label="Due date" type="date" value={head.due_date} onChange={(e) => setHead({ ...head, due_date: e.currentTarget.value })} />
          <TextInput label="Notes" placeholder="Optional" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.currentTarget.value })} />
        </SimpleGrid>
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr>
              <Table.Th>Product</Table.Th><Table.Th ta="right">Left to receive</Table.Th><Table.Th w={90} ta="right">Receive</Table.Th>
              <Table.Th w={80} ta="right">Free</Table.Th><Table.Th w={140}>Batch</Table.Th><Table.Th w={150}>Expiry</Table.Th>
              <Table.Th w={100} ta="right">Unit cost</Table.Th><Table.Th w={100} ta="right">MRP</Table.Th><Table.Th ta="right">GST %</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {open.map((line) => (
              <Table.Tr key={line.purchase_item_id}>
                <Table.Td><Text size="sm" fw={500}>{line.description}</Text></Table.Td>
                <Table.Td ta="right">{plain(left(line.ordered_quantity, line.received_quantity))} of {plain(line.ordered_quantity)}</Table.Td>
                <Table.Td>{box(line, 'quantity', 'Receive quantity', 3)}</Table.Td>
                <Table.Td>{box(line, 'free', 'Free quantity', 3)}</Table.Td>
                <Table.Td><TextInput aria-label={`Batch of ${line.description}`} size="xs" value={rows[line.purchase_item_id].batch} onChange={(e) => set(line, { batch: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput aria-label={`Expiry of ${line.description}`} size="xs" type="date" value={rows[line.purchase_item_id].expiry} onChange={(e) => set(line, { expiry: e.currentTarget.value })} /></Table.Td>
                <Table.Td>{box(line, 'unitCost', 'Unit cost', 2)}</Table.Td>
                <Table.Td>{box(line, 'unitMrp', 'MRP', 2)}</Table.Td>
                <Table.Td ta="right">{plain(line.tax_percent)}</Table.Td>
              </Table.Tr>
            ))}
            {!open.length && <Table.Tr><Table.Td colSpan={9}><Text c="dimmed" size="sm">Everything on this order has been received.</Text></Table.Td></Table.Tr>}
          </Table.Tbody>
        </Table>
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
          <SaveButton problem={problem} type="submit" loading={save.isPending}>Receive goods</SaveButton>
        </Group>
      </Stack>
    </form>
  )
}

export function PurchaseReturnForm({ id, onClose }: { id: number; onClose: () => void }) {
  return (
    <ActionDrawer title="Return goods to supplier" id={id} onClose={onClose}>
      {(doc) => <ReturnBody doc={doc} onClose={onClose} />}
    </ActionDrawer>
  )
}

function ReturnBody({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const lines = doc.lines.filter((line) => left(line.received_quantity, line.returned_quantity) > 0)
  const [rows, setRows] = useState<Record<number, { quantity: string; reason: string }>>({})
  const row = (line: Line) => rows[line.purchase_item_id] ?? { quantity: '', reason: '' }
  const set = (line: Line, change: Partial<{ quantity: string; reason: string }>) => setRows({ ...rows, [line.purchase_item_id]: { ...row(line), ...change } })
  const returning = lines.filter((line) => Number(row(line).quantity) > 0)
  const problem = !returning.length ? 'Enter a return quantity on at least one row.'
    : returning.some((line) => Number(row(line).quantity) > left(line.received_quantity, line.returned_quantity)) ? 'A return quantity is more than was received.'
      : null

  const saved = useSaved(onClose, (reply) => `Purchase return ${reply.return_number ?? ''} saved.`)
  const save = useMutation({
    mutationFn: () => api<Record<string, string>>(`/pharmacy/api/purchase/${doc.purchase_document_id}/return`, 'POST', {
      items: returning.map((line) => ({ purchase_item_id: line.purchase_item_id, quantity: row(line).quantity, reason: row(line).reason.trim() })),
    }),
    onSuccess: saved,
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <Facts items={[
          { label: 'Goods receipt', value: doc.purchase_number ?? '--' }, { label: 'Supplier', value: doc.supplier_name ?? '--' },
          { label: 'Received', value: day(doc.document_date) }, { label: 'Location', value: doc.location_name ?? '--' },
        ]} />
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr>
              <Table.Th>Product</Table.Th><Table.Th>Batch / Expiry</Table.Th><Table.Th ta="right">Can return</Table.Th>
              <Table.Th w={110} ta="right">Return qty</Table.Th><Table.Th w={320}>Reason</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((line) => (
              <Table.Tr key={line.purchase_item_id}>
                <Table.Td><Text size="sm" fw={500}>{line.description}</Text></Table.Td>
                <Table.Td>{[line.batch_number || '--', line.expiry_date && day(line.expiry_date)].filter(Boolean).join(', ')}</Table.Td>
                <Table.Td ta="right">{plain(left(line.received_quantity, line.returned_quantity))} of {plain(line.received_quantity)}</Table.Td>
                <Table.Td>
                  <NumberInput aria-label={`Return quantity of ${line.description}`} size="xs" min={0} allowNegative={false} decimalScale={3} hideControls
                    value={row(line).quantity} onChange={(value) => set(line, { quantity: String(value) })} styles={{ input: { textAlign: 'right' } }} />
                </Table.Td>
                <Table.Td><TextInput aria-label={`Reason for ${line.description}`} size="xs" placeholder="Why it goes back" value={row(line).reason} onChange={(e) => set(line, { reason: e.currentTarget.value })} /></Table.Td>
              </Table.Tr>
            ))}
            {!lines.length && <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" size="sm">Nothing on this receipt is left to return.</Text></Table.Td></Table.Tr>}
          </Table.Tbody>
        </Table>
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
          <SaveButton problem={problem} type="submit" variant="danger" loading={save.isPending}>Return goods</SaveButton>
        </Group>
      </Stack>
    </form>
  )
}
