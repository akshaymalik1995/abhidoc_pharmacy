/** Taking goods back on one bill: how much of each row, its condition, whether it goes back on the shelf, and where
 * the refund goes. It moves stock and money, so it is saved through DocAssist. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Checkbox, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'

import { contract } from '../api'
import {
  day, money, notifySuccess, plain, SaveButton, SidePanel,
} from '../ui'
import { useBill } from './SaleShared'

const CONDITIONS = [{ value: 'RESALABLE', label: 'Resalable' }, { value: 'DAMAGED', label: 'Damaged' }, { value: 'EXPIRED', label: 'Expired' },
  { value: 'RECALLED', label: 'Recalled' }, { value: 'NOT_RESALABLE', label: 'Not resalable' }]
const HANDLING = [{ value: 'AUTO', label: 'Automatic: cash, then patient advance, then balance due' }, { value: 'CASH', label: 'Cash' },
  { value: 'ADVANCE', label: 'Patient advance' }, { value: 'BALANCE', label: 'Reduce balance due' }]
interface Typed { quantity: string; condition: string | null; restock: boolean; reason: string }

export function SaleReturnForm({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const found = useBill(saleId)
  const today = new Date().toLocaleDateString('en-CA')
  const open = (found.data?.lines ?? []).filter((l) => Number(l.quantity) > Number(l.returned_quantity))
  const expired = (l: (typeof open)[number]) => Boolean(l.expiry_date && l.expiry_date < today)
  const [typed, setTyped] = useState<Record<number, Typed>>({})
  // an expired batch never goes back on the shelf and starts as Expired
  const row = (l: (typeof open)[number]): Typed => typed[l.sales_item_id] ?? { quantity: '', condition: expired(l) ? 'EXPIRED' : null, restock: !expired(l), reason: '' }
  const set = (l: (typeof open)[number], change: Partial<Typed>) => setTyped({ ...typed, [l.sales_item_id]: { ...row(l), ...change } })
  const [handling, setHandling] = useState('AUTO')
  const [receivedBy, setReceivedBy] = useState('')
  const [notes, setNotes] = useState('')
  const going = open.filter((l) => Number(row(l).quantity) > 0)
  const problem = !going.length ? 'Enter a return qty above zero in at least one row.'
    : going.some((l) => Number(row(l).quantity) > Number(l.quantity) - Number(l.returned_quantity)) ? 'A return qty is more than is left on the bill.' : null

  const save = useMutation({
    mutationFn: (sendForApproval: boolean) => contract<{ return_number?: string; pending_approval?: boolean; refund_amount_cents?: number; wallet_refund_cents?: number; balance_reduced_cents?: number }>(
      `/pharmacy/api/sales/${saleId}/return`, 'POST', {
        items: going.map((l) => ({ sales_item_id: l.sales_item_id, quantity: row(l).quantity, restock: expired(l) ? false : row(l).restock,
          condition_code: row(l).condition, reason: row(l).reason.trim() || null })),
        refund_handling: handling, received_by: receivedBy ? Number(receivedBy) : null, notes: notes.trim() || null, send_for_approval: sendForApproval,
      }),
    onSuccess: async (d) => {
      notifySuccess(d.pending_approval
        ? `Return ${d.return_number} sent for approval. Stock is returned; the refund is pending approval.`
        : `Sale return ${d.return_number} saved. Refund ${money(d.refund_amount_cents)}${d.wallet_refund_cents ? `, patient advance ${money(d.wallet_refund_cents)}` : ''}${d.balance_reduced_cents ? `, balance due reduced ${money(d.balance_reduced_cents)}` : ''}.`)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['sales-history'] }), queryClient.invalidateQueries({ queryKey: ['bill'] }), queryClient.invalidateQueries({ queryKey: ['sales-register'] })])
      onClose()
    },
  })

  return (
    <SidePanel title="Sale return" subject={found.data?.sales_number ?? ''} size={1100} onClose={onClose} loading={found.isPending} error={found.error}>
      <Stack gap="md">
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr>
              <Table.Th>Product</Table.Th><Table.Th>Batch</Table.Th><Table.Th ta="right">Sold</Table.Th><Table.Th ta="right">Returned</Table.Th>
              <Table.Th w={110} ta="right">Return qty</Table.Th><Table.Th w={160}>Condition</Table.Th><Table.Th>Restock</Table.Th><Table.Th>Reason</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {open.map((l) => (
              <Table.Tr key={l.sales_item_id}>
                <Table.Td><Text size="sm" fw={500}>{l.description}</Text></Table.Td>
                <Table.Td><Text size="sm">{l.batch_number || '--'}</Text>{l.expiry_date && <Text size="xs" c="dimmed">expiry {day(l.expiry_date)}</Text>}</Table.Td>
                <Table.Td ta="right">{plain(l.quantity)}</Table.Td>
                <Table.Td ta="right">{plain(l.returned_quantity)}</Table.Td>
                <Table.Td>
                  <NumberInput aria-label={`Return qty of ${l.description}`} size="xs" min={0} max={Number(l.quantity) - Number(l.returned_quantity)} decimalScale={3} hideControls
                    value={row(l).quantity} onChange={(v) => set(l, { quantity: String(v) })} styles={{ input: { textAlign: 'right' } }} />
                </Table.Td>
                <Table.Td><Select aria-label="Condition" size="xs" placeholder="--" clearable={!expired(l)} data={CONDITIONS} value={row(l).condition} onChange={(v) => set(l, { condition: v })} /></Table.Td>
                <Table.Td>{expired(l) ? <Text size="xs">Expired: not restocked</Text> : <Checkbox aria-label="Restock" checked={row(l).restock} onChange={(e) => set(l, { restock: e.currentTarget.checked })} />}</Table.Td>
                <Table.Td><TextInput aria-label="Reason" size="xs" value={row(l).reason} onChange={(e) => set(l, { reason: e.currentTarget.value })} /></Table.Td>
              </Table.Tr>
            ))}
            {found.data && !open.length && <Table.Tr><Table.Td colSpan={8}><Text size="sm">All products on this bill are already returned.</Text></Table.Td></Table.Tr>}
          </Table.Tbody>
        </Table>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label="Refund mode" data={HANDLING} value={handling} onChange={(v) => setHandling(v ?? 'AUTO')} allowDeselect={false} />
          <NumberInput label="Received by (user ID)" min={1} allowDecimal={false} hideControls value={receivedBy} onChange={(v) => setReceivedBy(String(v))} />
          <TextInput label="Remarks" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        </SimpleGrid>
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
          <SaveButton problem={problem} variant="default" loading={save.isPending} onClick={() => save.mutate(true)}>Send for approval</SaveButton>
          <SaveButton problem={problem} loading={save.isPending} onClick={() => save.mutate(false)}>Save return</SaveButton>
        </Group>
      </Stack>
    </SidePanel>
  )
}
