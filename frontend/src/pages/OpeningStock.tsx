/** Opening Stock: stock put into the book without a purchase (first stocking, a receipt, a count).
 * It changes stock, so it is saved through DocAssist, which holds the stock rules. */
import { ActionIcon, Alert, Button, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Table, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api } from '../api'
import { ProductPicker, type OrderProduct } from '../ProductPicker'
import { useWorkLocation } from '../session'
import {
  notifySuccess, Page, PageHeader, plain, SaveButton,
} from '../ui'

interface Line { key: number; product: OrderProduct | null; quantity: string; unitCost: string; unitMrp: string; batch: string; expiry: string }
let nextKey = 1
const blank = (): Line => ({ key: nextKey++, product: null, quantity: '', unitCost: '', unitMrp: '', batch: '', expiry: '' })
const today = () => new Date().toLocaleDateString('en-CA')
const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100)

export function OpeningStock() {
  const queryClient = useQueryClient()
  const { locations, locationId, setLocationId } = useWorkLocation()
  const start = () => ({ stock_type: 'STOCK_ADJUSTMENT', document_date: today(), reference_number: '', notes: '' })
  const [head, setHead] = useState(start)
  const [lines, setLines] = useState<Line[]>([blank()])
  const setField = (name: keyof ReturnType<typeof start>, value: string) => setHead({ ...head, [name]: value })
  const setLine = (key: number, change: Partial<Line>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)))
  const used = lines.filter((line) => line.product)
  const problem = !used.length ? 'Select a product on at least one row.'
    : used.some((line) => !(Number(line.quantity) > 0)) ? 'Enter a quantity above 0 on every row.' : null

  const save = useMutation({
    mutationFn: () => api<{ stock_number?: string }>('/pharmacy/api/stock/documents', 'POST', {
      ...head, reference_number: head.reference_number.trim() || null, notes: head.notes.trim() || null, location_id: locationId,
      items: used.map((line) => ({
        pharmacy_item_id: line.product!.item_id, quantity: line.quantity, unit_cost_cents: paise(line.unitCost), unit_mrp_cents: paise(line.unitMrp),
        batch_number: line.batch.trim() || null, expiry_date: line.expiry || null,
      })),
    }),
    onSuccess: async (reply) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-documents'] }), queryClient.invalidateQueries({ queryKey: ['overall-stock'] })])
      notifySuccess(`Stock document ${reply.stock_number ?? ''} saved.`)
      setHead(start())
      setLines([blank()])
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) save.mutate() }
  const box = (line: Line, name: 'quantity' | 'unitCost' | 'unitMrp', label: string, scale: number) => (
    <NumberInput aria-label={label} size="xs" min={0} allowNegative={false} decimalScale={scale} hideControls value={line[name]}
      onChange={(value) => setLine(line.key, { [name]: String(value) })} styles={{ input: { textAlign: 'right' } }} />
  )

  return (
    <Page header={<PageHeader title="Opening stock" />}>
      <Paper withBorder p="md">
        <form onSubmit={submit}>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }}>
              <Select label="Location" data={locations} value={locationId} onChange={(value) => value && setLocationId(value)} allowDeselect={false} searchable />
              <Select label="Type" value={head.stock_type} onChange={(value) => setField('stock_type', value ?? 'STOCK_ADJUSTMENT')} allowDeselect={false}
                data={[{ value: 'STOCK_ADJUSTMENT', label: 'Stock adjustment' }, { value: 'STOCK_RECEIPT', label: 'Stock receipt' }, { value: 'PHYSICAL_COUNT', label: 'Physical count' }]} />
              <TextInput label="Date" type="date" value={head.document_date} onChange={(e) => setField('document_date', e.currentTarget.value)} />
              <TextInput label="Reference no." value={head.reference_number} onChange={(e) => setField('reference_number', e.currentTarget.value)} />
              <TextInput label="Notes" value={head.notes} onChange={(e) => setField('notes', e.currentTarget.value)} />
            </SimpleGrid>
            <Table withTableBorder highlightOnHover={false}>
              <Table.Thead bg="gray.0">
                <Table.Tr>
                  <Table.Th>Product</Table.Th><Table.Th w={100} ta="right">Qty</Table.Th><Table.Th w={110} ta="right">Unit cost</Table.Th><Table.Th w={110} ta="right">MRP</Table.Th>
                  <Table.Th w={160}>Batch</Table.Th><Table.Th w={160}>Expiry</Table.Th><Table.Th w={70} ta="right">GST %</Table.Th><Table.Th w={44} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lines.map((line) => (
                  <Table.Tr key={line.key}>
                    <Table.Td>
                      <ProductPicker label="Product" value={line.product} onChange={(product) => setLine(line.key, {
                        product,
                        unitCost: product?.last_cost_cents ? String(product.last_cost_cents / 100) : line.unitCost,
                        unitMrp: product?.last_mrp_cents ? String(product.last_mrp_cents / 100) : line.unitMrp,
                      })} />
                    </Table.Td>
                    <Table.Td>{box(line, 'quantity', 'Quantity', 3)}</Table.Td>
                    <Table.Td>{box(line, 'unitCost', 'Unit cost', 2)}</Table.Td>
                    <Table.Td>{box(line, 'unitMrp', 'MRP', 2)}</Table.Td>
                    <Table.Td><TextInput aria-label="Batch" size="xs" value={line.batch} onChange={(e) => setLine(line.key, { batch: e.currentTarget.value })} /></Table.Td>
                    <Table.Td><TextInput aria-label="Expiry" size="xs" type="date" value={line.expiry} onChange={(e) => setLine(line.key, { expiry: e.currentTarget.value })} /></Table.Td>
                    <Table.Td ta="right">{line.product ? plain(line.product.tax_percent) : '--'}</Table.Td>
                    <Table.Td>
                      <ActionIcon variant="default" aria-label="Remove row" disabled={lines.length === 1} onClick={() => setLines(lines.filter((other) => other.key !== line.key))}><IconTrash size={16} /></ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {save.isError && <Alert color="red">{save.error.message}</Alert>}
            <Group justify="space-between">
              <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setLines([...lines, blank()])}>Add row</Button>
              <Group>
                <SaveButton problem={problem} type="submit" loading={save.isPending}>Save</SaveButton>
              </Group>
            </Group>
          </Stack>
        </form>
      </Paper>
    </Page>
  )
}
