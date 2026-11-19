import { ActionIcon, Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import { useWorkLocation } from '../session'
import {
  money, notifySuccess, SaveButton, SidePanel,
} from '../ui'

type Choice = components['schemas']['Choice']

interface Line {
  key: number
  product: OrderProduct | null
  quantity: string
  unitCost: string // rupees, as typed
  unitMrp: string
  discount: string
}

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100)
let nextKey = 1
const emptyLine = (): Line => ({ key: nextKey++, product: null, quantity: '1', unitCost: '', unitMrp: '', discount: '' })

/** A line's amounts in paise, worked out the way the order is saved: GST on what is left after the discount. */
function amounts(line: Line) {
  const gross = Math.round(paise(line.unitCost) * Number(line.quantity || 0))
  const discount = paise(line.discount)
  const tax = Math.round(((gross - discount) * Number(line.product?.tax_percent ?? 0)) / 100)
  return { gross, discount, tax, net: gross - discount + tax }
}

/** New direct purchase order. Saved through DocAssist, which numbers and records it. */
export function PurchaseOrderForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const { locationId } = useWorkLocation()
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<Choice[]>('/api/purchase/suppliers'), staleTime: 60_000 })
  const [head, setHead] = useState({
    status: 'DRAFT', document_date: today(), expected_date: '', supplier_id: '', paid_amount: '', notes: '', purchase_order_reason: '',
  })
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const setField = (name: keyof typeof head, value: string) => setHead({ ...head, [name]: value })
  const setLine = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))

  const filled = lines.filter((line) => line.product)
  const totals = filled.map(amounts).reduce(
    (sum, a) => ({ gross: sum.gross + a.gross, discount: sum.discount + a.discount, tax: sum.tax + a.tax, net: sum.net + a.net }),
    { gross: 0, discount: 0, tax: 0, net: 0 },
  )
  const problem = !filled.length ? 'Add at least one product.'
    : filled.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity on every row.'
      : filled.some((line) => amounts(line).discount > amounts(line).gross) ? 'Discount cannot be more than the gross amount.'
        : !head.supplier_id && head.status !== 'DRAFT' ? 'Select a supplier; only a draft can be saved without one.'
          : null

  const save = useMutation({
    mutationFn: () => api<{ purchase_number: string }>('/pharmacy/api/purchase', 'POST', {
      purchase_type: 'DIRECT_PO',
      status: head.status,
      document_date: head.document_date,
      expected_date: head.expected_date,
      supplier_id: head.supplier_id,
      paid_amount_cents: paise(head.paid_amount),
      notes: head.notes.trim(),
      purchase_order_reason: head.purchase_order_reason.trim(),
      location_id: locationId,
      items: filled.map((line) => ({
        item_id: line.product!.item_id, quantity: line.quantity, unit_cost_cents: paise(line.unitCost),
        unit_mrp_cents: paise(line.unitMrp), discount_amount_cents: paise(line.discount),
      })),
    }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
      notifySuccess(`Purchase order ${saved.purchase_number} saved.`)
      onClose()
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }
  const amountBox = (line: Line, name: 'quantity' | 'unitCost' | 'unitMrp' | 'discount', label: string, scale: number) => (
    <NumberInput aria-label={label} size="xs" min={0} allowNegative={false} decimalScale={scale} hideControls
      value={line[name]} onChange={(value) => setLine(line.key, { [name]: String(value) })} styles={{ input: { textAlign: 'right' } }} />
  )

  return (
    <SidePanel onClose={onClose} size={1080} title="New direct PO" loading={suppliers.isPending}>
      <form onSubmit={submit}>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            <Select label="Supplier" placeholder="Search supplier" data={suppliers.data ?? []} value={head.supplier_id || null}
              onChange={(value) => setField('supplier_id', value ?? '')} searchable clearable />
            <Select label="Status" value={head.status} onChange={(value) => setField('status', value ?? 'DRAFT')} allowDeselect={false}
              data={[{ value: 'DRAFT', label: 'Draft' }, { value: 'ORDERED', label: 'Ordered' }, { value: 'PENDING_APPROVAL', label: 'Pending approval' }]} />
            <TextInput label="Date" type="date" value={head.document_date} onChange={(e) => setField('document_date', e.currentTarget.value)} />
            <TextInput label="Expected date" type="date" value={head.expected_date} onChange={(e) => setField('expected_date', e.currentTarget.value)} />
            <NumberInput label="Paid amount" placeholder="0.00" min={0} allowNegative={false} decimalScale={2} hideControls
              value={head.paid_amount} onChange={(value) => setField('paid_amount', String(value))} />
            <TextInput label="Purchase reason" maxLength={255} value={head.purchase_order_reason} onChange={(e) => setField('purchase_order_reason', e.currentTarget.value)} />
            <TextInput label="Notes" placeholder="Optional" value={head.notes} onChange={(e) => setField('notes', e.currentTarget.value)} style={{ gridColumn: 'span 2' }} />
          </SimpleGrid>

          <Table withTableBorder highlightOnHover={false}>
            <Table.Thead bg="gray.0">
              <Table.Tr>
                <Table.Th>Product</Table.Th><Table.Th w={90} ta="right">Qty</Table.Th><Table.Th w={110} ta="right">Unit cost</Table.Th>
                <Table.Th w={110} ta="right">MRP</Table.Th><Table.Th w={110} ta="right">Discount</Table.Th>
                <Table.Th w={70} ta="right">GST %</Table.Th><Table.Th w={120} ta="right">Net</Table.Th><Table.Th w={44} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((line) => (
                <Table.Tr key={line.key}>
                  <Table.Td>
                    <ProductPicker
                      label="Product"
                      value={line.product}
                      onChange={(product) => setLine(line.key, {
                        product,
                        // the row starts from what the product last cost here
                        unitCost: product?.last_cost_cents ? String(product.last_cost_cents / 100) : line.unitCost,
                        unitMrp: product?.last_mrp_cents ? String(product.last_mrp_cents / 100) : line.unitMrp,
                      })}
                    />
                  </Table.Td>
                  <Table.Td>{amountBox(line, 'quantity', 'Quantity', 3)}</Table.Td>
                  <Table.Td>{amountBox(line, 'unitCost', 'Unit cost', 2)}</Table.Td>
                  <Table.Td>{amountBox(line, 'unitMrp', 'MRP', 2)}</Table.Td>
                  <Table.Td>{amountBox(line, 'discount', 'Discount', 2)}</Table.Td>
                  <Table.Td ta="right">{line.product ? Number(line.product.tax_percent) : '--'}</Table.Td>
                  <Table.Td ta="right" fw={600}>{line.product ? money(amounts(line).net) : '--'}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1}
                      onClick={() => setLines(lines.filter((other) => other.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="space-between" align="start">
            <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, emptyLine()])}>Add row</Button>
            <Text size="sm" ta="right">
              Gross {money(totals.gross)}, discount {money(totals.discount)}, GST {money(totals.tax)}<br />
              <Text span fw={600} size="md">Net {money(totals.net)}</Text>
            </Text>
          </Group>

          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <SaveButton problem={problem} type="submit" loading={save.isPending}>Save order</SaveButton>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}
