/** Dashboard: the four figures the pharmacy opens the day with, and the first products that need attention. Each figure
 * opens the screen that lists it. DocAssist counts these; they are read through it in one request. */
import { Anchor, Group, Paper, SimpleGrid, Stack, Table, Text, Title, UnstyledButton } from '@mantine/core'
import { IconAlertTriangle, IconBoxSeam, IconCalendarDue, IconShoppingCart } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { contract } from '../api'
import {
  day, Page, PageHeader, plain, SkeletonRows,
} from '../ui'

interface Reply {
  counts: { active_items?: number; low_stock?: number; expiring_soon?: number; open_pos?: number }
  low_stock_items: { item_id: number; item_name: string; generic_name: string | null; reorder_level: string; quantity_on_hand: string }[]
  expiring_items: { item_id: number; item_name: string; generic_name: string | null; nearest_expiry: string | null }[]
  expiry_window_days?: number
}

/** A figure that opens its list; one that asks for action is marked only when there is something to act on. */
function Figure(props: { label: string; value: number | undefined; icon: ReactNode; to: string; alert?: boolean }) {
  const navigate = useNavigate()
  const marked = props.alert && Number(props.value) > 0
  return (
    <UnstyledButton onClick={() => navigate(props.to)} style={{ display: 'block' }}>
      <Paper withBorder p="md" style={{ borderColor: marked ? 'var(--mantine-color-orange-5)' : undefined }}>
        <Group wrap="nowrap">
          <Text c={marked ? 'orange.8' : 'bottle.7'}>{props.icon}</Text>
          <div>
            <Text size="sm">{props.label}</Text>
            <Text fz={28} fw={700} lh={1.1} c={marked ? 'orange.9' : undefined}>{props.value ?? '--'}</Text>
          </div>
        </Group>
      </Paper>
    </UnstyledButton>
  )
}

export function Dashboard() {
  const data = useQuery({ queryKey: ['dashboard'], queryFn: () => contract<Reply>('/pharmacy/api/dashboard') })
  const d = data.data
  const windowDays = d?.expiry_window_days ?? 90
  // inside the warning days, or already past, the date is marked
  const soon = (date: string | null) => Boolean(date) && new Date(`${date!.slice(0, 10)}T00:00`).getTime() <= Date.now() + windowDays * 86400000
  const none = (text: string, cols: number) => (data.isPending ? <SkeletonRows rows={5} cols={cols} />
    : <Table.Tr><Table.Td colSpan={cols}><Text size="sm">{data.isError ? 'Could not load. Try again.' : text}</Text></Table.Td></Table.Tr>)
  return (
    <Page header={<PageHeader title="Dashboard" />}>
      <Stack gap="md">
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Figure label="Products in stock" value={d?.counts.active_items} icon={<IconBoxSeam size={26} />} to="/stock/overall-stocks" />
          <Figure label="Low stock" value={d?.counts.low_stock} icon={<IconAlertTriangle size={26} />} to="/stock/overall-stocks?alert=low" alert />
          <Figure label="Near-expiry stock" value={d?.counts.expiring_soon} icon={<IconCalendarDue size={26} />} to="/stock/overall-stocks?alert=expiring" alert />
          <Figure label="Open purchase orders" value={d?.counts.open_pos} icon={<IconShoppingCart size={26} />} to="/purchase/purchase-orders?status=ALL_OPEN" />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Paper withBorder p="md">
            <Group justify="space-between" mb="xs"><Title order={2} fz={16}>Low stock</Title><Anchor component={Link} to="/stock/overall-stocks?alert=low" size="sm">View all</Anchor></Group>
            <Table highlightOnHover={false} verticalSpacing={4}>
              <Table.Thead><Table.Tr><Table.Th>Product</Table.Th><Table.Th>Generic</Table.Th><Table.Th ta="right">Qty</Table.Th><Table.Th ta="right">Reorder level</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {(d?.low_stock_items ?? []).map((r) => {
                  // marked only where the stock is under a reorder level that is set
                  const under = Number(r.reorder_level) > 0 && Number(r.quantity_on_hand) < Number(r.reorder_level)
                  return (
                    <Table.Tr key={`${r.item_id}-${r.quantity_on_hand}`}>
                      <Table.Td>{r.item_name}</Table.Td><Table.Td>{r.generic_name || '--'}</Table.Td>
                      <Table.Td ta="right" fw={under ? 700 : 400} c={under ? 'orange.9' : undefined}>{plain(r.quantity_on_hand)}</Table.Td>
                      <Table.Td ta="right">{Number(r.reorder_level) > 0 ? plain(r.reorder_level) : '--'}</Table.Td>
                    </Table.Tr>
                  )
                })}
                {!d?.low_stock_items.length && none('No products below reorder level.', 4)}
              </Table.Tbody>
            </Table>
          </Paper>
          <Paper withBorder p="md">
            <Group justify="space-between" mb="xs"><Title order={2} fz={16}>Near-expiry stock</Title><Anchor component={Link} to="/stock/overall-stocks?alert=expiring" size="sm">View all</Anchor></Group>
            <Table highlightOnHover={false} verticalSpacing={4}>
              <Table.Thead><Table.Tr><Table.Th>Product</Table.Th><Table.Th>Generic</Table.Th><Table.Th ta="right">Nearest expiry</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {(d?.expiring_items ?? []).map((r) => (
                  <Table.Tr key={r.item_id}>
                    <Table.Td>{r.item_name}</Table.Td><Table.Td>{r.generic_name || '--'}</Table.Td>
                    <Table.Td ta="right" fw={soon(r.nearest_expiry) ? 700 : 400} c={soon(r.nearest_expiry) ? 'orange.9' : undefined}>{day(r.nearest_expiry?.slice(0, 10))}</Table.Td>
                  </Table.Tr>
                ))}
                {!d?.expiring_items.length && none(`No stock expiring in the next ${windowDays} days.`, 3)}
              </Table.Tbody>
            </Table>
          </Paper>
        </SimpleGrid>
      </Stack>
    </Page>
  )
}
