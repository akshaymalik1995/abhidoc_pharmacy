/** The shared pieces every screen is built from. A screen composes these; it does not style itself. */
import {
  ActionIcon, Alert, Badge, Box, Button, Divider, Drawer, Flex, Group, LoadingOverlay, Menu, Modal, Pagination, Paper,
  Checkbox, MantineThemeProvider, NumberInput, ScrollArea, SegmentedControl, Select, SimpleGrid, Skeleton, Stack, Table,
  Text, TextInput, Title, type ButtonProps,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconDots } from '@tabler/icons-react'
import { createContext, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

export const notifySuccess = (message: string) => notifications.show({ message, color: 'bottle' })
export const notifyFailure = (error: Error) => notifications.show({ message: error.message, color: 'red' })

/** "12.500" -> "12.5"; nothing -> "--". */
export const plain = (value: string | number | null | undefined) =>
  value == null || value === '' ? '--' : String(Number(value))
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
/** Money is kept in paise; 123450 -> "₹1,234.50". */
export const money = (cents: number | null | undefined) => (cents == null ? '--' : rupees.format(cents / 100))
export const day = (value: string | null | undefined) =>
  value ? new Date(`${value}T00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--'

/**
 * The frame of every screen. The header (and the side list and footer, when a screen has them)
 * stay where they are; only the data in the middle scrolls.
 */
export function Page(props: { header: ReactNode; aside?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <Flex h="100%" gap="lg" align="stretch">
      {props.aside && (
        <Paper withBorder w={{ base: 200, md: 248 }} style={{ flex: 'none', overflow: 'hidden' }}>
          <ScrollArea h="100%" p="xs">{props.aside}</ScrollArea>
        </Paper>
      )}
      <Stack gap="sm" h="100%" miw={0} style={{ flex: 1 }}>
        {props.header}
        {/* A table in here shrinks to the space left and scrolls inside itself, both ways, so its
            sideways scrollbar is always in view; anything taller than the space scrolls this area. */}
        <Flex direction="column" gap="sm" mih={0} style={{ flex: 1, overflowY: 'auto' }}>{props.children}</Flex>
        {props.footer}
      </Stack>
    </Flex>
  )
}

/** Whether facts are being shown on a screen's title row (true) or inside a panel or page body. */
const OnTitleRow = createContext(false)

/**
 * The top row of a screen, kept to one line so the data below starts high: what the screen is,
 * its facts or totals right beside the title, and what you can do at the right.
 */
export function PageHeader(props: { title: string; badge?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <Group justify="space-between" align="center" gap="md" wrap="wrap" style={{ rowGap: 6 }}>
      <Group gap="lg" align="center" wrap="wrap" miw={0} style={{ flex: 1, rowGap: 4 }}>
        <Group gap="sm" align="center" wrap="nowrap">
          <Title order={1} fz={20} lh={1.3} style={{ whiteSpace: 'nowrap' }}>{props.title}</Title>
          {props.badge}
        </Group>
        <OnTitleRow.Provider value>{props.children}</OnTitleRow.Provider>
      </Group>
      <Group gap="xs" wrap="nowrap">{props.actions}</Group>
    </Group>
  )
}

/**
 * A record's facts or a list's totals: each a small muted name with its value right after it,
 * so the two always read as a pair. The pairs flow in a row and wrap; on a title row they sit
 * beside the title, anywhere else in one slim strip. A value never wraps: one too long is cut
 * with an ellipsis and shown in full on hover.
 */
/** compact: the small size, for facts inside a list choice or under a field. */
export function Facts({ items, compact = false }: { items: { label: string; value: ReactNode }[]; compact?: boolean }) {
  const onTitleRow = useContext(OnTitleRow)
  const pairs = items.map((item) => (
    <Group key={item.label} gap={compact ? 4 : 6} wrap="nowrap" align="baseline" miw={0} maw={360}>
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{item.label}</Text>
      <Text
        component="div"
        size={compact ? 'xs' : 'sm'}
        fw={600}
        miw={0}
        title={typeof item.value === 'string' ? item.value : undefined}
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }}
      >
        {item.value}
      </Text>
    </Group>
  ))
  return <Group gap={compact ? 'sm' : onTitleRow ? 'lg' : 'md'} wrap="wrap" style={{ rowGap: onTitleRow || compact ? 2 : 4 }}>{pairs}</Group>
}

const STATUS_COLOR: Record<string, string> = {
  Active: 'bottle', Posted: 'bottle', Counted: 'bottle', 'In stock': 'bottle',
  Open: 'blue', Consignment: 'blue',
  'Not counted': 'amber', Low: 'amber', Expiring: 'amber',
  Inactive: 'gray', Cancelled: 'gray',
}
export function StatusBadge({ status }: { status: string }) {
  // never cut short: a badge that reads "I..." says nothing
  return <Badge color={STATUS_COLOR[status] ?? 'gray'} miw="max-content">{status}</Badge>
}

export function EmptyState(props: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <Stack align="center" gap="xs" py={48}>
      <Text fw={500}>{props.title}</Text>
      {props.hint && <Text size="sm" c="dimmed">{props.hint}</Text>}
      {props.action}
    </Stack>
  )
}

const smallLabel = { label: { fontSize: 11, fontWeight: 400, color: 'var(--mantine-color-dimmed)', marginBottom: 1 } }
/** Fields inside a filter bar are small, with a small name above, so the bar is one low row. */
const filterTheme = {
  components: {
    TextInput: TextInput.extend({ defaultProps: { size: 'xs' }, styles: smallLabel }),
    Select: Select.extend({ defaultProps: { size: 'xs' }, styles: smallLabel }),
    NumberInput: NumberInput.extend({ defaultProps: { size: 'xs' }, styles: smallLabel }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { size: 'xs' } }),
    Checkbox: Checkbox.extend({ defaultProps: { size: 'xs' } }),
    Button: Button.extend({ defaultProps: { size: 'xs', fw: 500 } }),
    SimpleGrid: SimpleGrid.extend({ defaultProps: { spacing: 'xs', verticalSpacing: 6 } }),
    Group: Group.extend({ defaultProps: { gap: 'xs' } }),
  },
}

/** Controls that narrow or act on the list below them: one low row, with no box of its own. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <MantineThemeProvider theme={filterTheme} inherit>
      <Box>{children}</Box>
    </MantineThemeProvider>
  )
}

export interface Column<Row> {
  header: string
  cell: (row: Row) => ReactNode
  align?: 'right'
  width?: number
}

/** Keeps a cell in view while the table scrolls sideways. */
const pinned = (side: 'left' | 'right', head: boolean) => ({
  position: 'sticky' as const,
  [side]: 0,
  zIndex: head ? 3 : 1,
  background: head ? 'var(--mantine-color-gray-0)' : 'var(--mantine-color-body)',
})

/**
 * The one table of the app. It takes the width it is given: text wraps, figures do not. When it
 * still does not fit, it scrolls inside its own frame with the column names, the first column and
 * the Actions column staying in view.
 */
export function DataTable<Row>(props: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string | number
  loading?: boolean
  empty: ReactNode
  footer?: ReactNode
  /** Names the rows asked for (page, search, filters). When it changes, the table goes back to its top left;
   * a refresh of the same rows leaves the reader where they were. */
  view?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { scroller.current?.scrollTo({ top: 0, left: 0 }) }, [props.view])
  const last = props.columns.length - 1
  const waiting = Boolean(props.loading) && !props.rows.length // first load: rows in outline, not a spinner
  const isActions = (index: number) => index === last && props.columns[index].header === 'Actions'
  const pin = (index: number, head: boolean) =>
    index === 0 ? { ...pinned('left', head), minWidth: 170 }
      // the Actions column takes the width its buttons need and is never cut; the other columns give way
      : isActions(index) ? { ...pinned('right', head), width: '1%', whiteSpace: 'nowrap' as const }
        : head ? { background: 'var(--mantine-color-gray-0)' } : undefined
  // other cells stay on one line (a long value is cut, never stacked), so rows stay low; the first column may wrap
  const oneLine = { whiteSpace: 'nowrap' as const, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }
  return (
    // The frame fills the space it is given and keeps that size with 25 rows, 3 rows or none, and while
    // loading, so a search that finds nothing does not make the page jump.
    <Paper withBorder pos="relative" mih={180} style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', overflow: 'hidden' }}>
      <LoadingOverlay visible={Boolean(props.loading) && !waiting} overlayProps={{ blur: 1 }} loaderProps={{ size: 'sm' }} />
      <Flex ref={scroller} direction="column" mih={0} style={{ flex: 1, overflow: 'auto' }}>
        <Table stickyHeader>
          <Table.Thead>
            <Table.Tr>
              {props.columns.map((column, index) => (
                <Table.Th key={column.header} ta={column.align} w={column.width} style={pin(index, true)}>{column.header}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {waiting && Array.from({ length: 8 }, (_, row) => (
              <Table.Tr key={row}>
                {props.columns.map((column) => <Table.Td key={column.header}><Skeleton h={14} /></Table.Td>)}
              </Table.Tr>
            ))}
            {props.rows.map((row) => (
              <Table.Tr key={props.rowKey(row)}>
                {props.columns.map((column, index) => (
                  <Table.Td key={column.header} ta={column.align}
                    style={{ ...pin(index, false), ...(index === 0 || isActions(index) ? {} : oneLine) }}>
                    {column.cell(row)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!props.rows.length && !props.loading && (
          <Flex align="center" justify="center" style={{ flex: 1 }}>{props.empty}</Flex>
        )}
      </Flex>
      {props.footer && (
        <>
          <Divider />
          <Box px="md" py={6}>{props.footer}</Box>
        </>
      )}
    </Paper>
  )
}

/** "21-40 of 484" with page buttons. `page` starts at 1. */
export function Pager(props: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
  sizes?: number[] // offer a choice of rows per page
  onSize?: (size: number) => void
}) {
  const first = props.total ? (props.page - 1) * props.pageSize + 1 : 0
  const last = Math.min(props.page * props.pageSize, props.total)
  return (
    <Group justify="space-between">
      <Group gap="sm">
        <Text size="sm" c="dimmed">{first}-{last} of {props.total}</Text>
        {props.sizes && (
          <Select
            aria-label="Rows per page"
            size="xs"
            w={130}
            data={props.sizes.map((size) => ({ value: String(size), label: `${size} per page` }))}
            value={String(props.pageSize)}
            onChange={(value) => value && props.onSize?.(Number(value))}
            allowDeselect={false}
          />
        )}
      </Group>
      <Pagination size="sm" value={props.page} total={Math.max(1, Math.ceil(props.total / props.pageSize))} onChange={props.onChange} />
    </Group>
  )
}

/** Asks before something that is not undone by pressing a button again. */
export function ConfirmDialog(props: {
  opened: boolean
  title: string
  children: ReactNode
  confirm: string
  keep: string
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
  /** false: the yes goes ahead with something ordinary, not something that cannot be undone */
  danger?: boolean
  /** why the yes did not go through, shown in the dialog */
  error?: string | null
}) {
  // while the yes is on its way the dialog cannot be closed: it closes when the answer is back
  const close = () => { if (!props.loading) props.onClose() }
  return (
    <Modal opened={props.opened} onClose={close} withCloseButton={!props.loading} title={<Text fw={600}>{props.title}</Text>} centered>
      {/* a box, not a paragraph: the question may hold a field (a reason) */}
      <Box fz="sm">{props.children}</Box>
      {props.error && <Text size="sm" c="red.8" mt="sm" role="alert">{props.error}</Text>}
      <Group justify="flex-end" mt="lg">
        <Button variant="default" disabled={props.loading} onClick={close}>{props.keep}</Button>
        <Button color={props.danger === false ? undefined : 'red'} loading={props.loading} onClick={props.onConfirm}>{props.confirm}</Button>
      </Group>
    </Modal>
  )
}

/** Prints a plain table of everything a list holds, not only the page on screen. */
export const escapeHtml = (value: string | number | null | undefined) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Prints a page of HTML (already escaped) without leaving the screen. */
export function printHtml(title: string, body: string) {
  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  document.body.appendChild(frame)
  const page = frame.contentDocument!
  page.write(
    `<title>${escapeHtml(title)}</title><style>body{font:12px sans-serif}h1{font-size:16px;margin:0 0 4px}` +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 6px;text-align:left}' +
    '.line{display:flex;justify-content:space-between;gap:12px;margin:2px 0}.num{text-align:right}</style>' + body,
  )
  page.close()
  frame.contentWindow!.focus()
  frame.contentWindow!.print()
  setTimeout(() => frame.remove(), 1000)
}

export function printTable(title: string, headers: string[], rows: (string | number)[][]) {
  printHtml(title, `<h1>${escapeHtml(title)}</h1><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
}

/** Saves rows already on the screen as a CSV file. */
export function downloadCsv(name: string, headers: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const text = [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
  const link = document.createElement('a')
  // the byte-order mark makes Excel read names and the rupee sign as UTF-8
  link.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** What happened to stock, in the words the pharmacy uses. */
const MOVEMENT: Record<string, string> = {
  PURCHASE: 'Received', DISPENSE: 'Sold', RETURN: 'Returned', TRANSFER_OUT: 'Transferred out',
  TRANSFER_IN: 'Transferred in', INTERNAL_ISSUE: 'Issued', INTERNAL_RETURN: 'Issue returned',
  PHYSICAL_VARIANCE: 'Count difference', RELOCATION: 'Relocated',
}
export function movementWords(m: {
  movement_type: string
  quantity_change: string
  reference_type?: string | null
  stock_number?: string | null
  notes?: string | null
}) {
  if (m.movement_type === 'ADJUSTMENT') {
    // only a write-off is "Written off"; any other adjustment says which way it went
    if (m.reference_type === 'PHARMACY_WRITE_OFF' || m.stock_number?.startsWith('PWO') || m.notes === 'write-off') return 'Written off'
    return Number(m.quantity_change) < 0 ? 'Adjusted (decrease)' : 'Adjusted (increase)'
  }
  return MOVEMENT[m.movement_type] ?? m.movement_type.replace(/_/g, ' ').toLowerCase()
}

/** What can be done to one row of a table. */
export interface RowAction {
  label: string
  onClick?: () => void
  to?: string // a screen to go to, instead of onClick
  kind?: 'main' | 'danger' // main: the row's own action; danger: cannot be undone by pressing again
}

/**
 * The buttons at the end of a table row. They look like buttons on every screen: the row's main
 * action in the theme colour, the others plain, destructive ones red. With more than two, the
 * first stays a button and the rest go under "More".
 */
export function RowActions({ actions, name }: { actions: (RowAction | false | null | undefined)[]; name?: string }) {
  const list = actions.filter((action): action is RowAction => Boolean(action))
  if (!list.length) return null
  const shown = list.length > 2 ? list.slice(0, 1) : list
  const more = list.slice(shown.length)
  const how = (action: RowAction) => (action.to ? { component: Link, to: action.to } : { onClick: action.onClick })
  return (
    <Group gap={6} justify="flex-end" wrap="nowrap">
      {shown.map((action) => (
        <Button
          key={action.label}
          size="compact-sm"
          variant={action.kind === 'main' ? 'light' : action.kind === 'danger' ? 'danger' : 'default'}
          bd={action.kind === 'main' ? '1px solid var(--mantine-color-bottle-3)' : undefined}
          {...(how(action) as object)}
        >
          {action.label}
        </Button>
      ))}
      {more.length > 0 && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="default" size={26} aria-label={name ? `More actions for ${name}` : 'More actions'}><IconDots size={16} /></ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {more.map((action) => (
              <Menu.Item key={action.label} color={action.kind === 'danger' ? 'red' : undefined} {...(how(action) as object)}>{action.label}</Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  )
}

/** The outline of a form or document while it loads, so the panel does not jump when it arrives. */
function PanelSkeleton() {
  return (
    <Stack gap="md" aria-busy="true" aria-label="Loading">
      <Paper withBorder px="lg" py="md">
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {Array.from({ length: 4 }, (_, i) => <Box key={i}><Skeleton h={10} w={70} mb={8} /><Skeleton h={14} w="80%" /></Box>)}
        </SimpleGrid>
      </Paper>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {Array.from({ length: 4 }, (_, i) => <Box key={i}><Skeleton h={10} w={90} mb={8} /><Skeleton h={36} /></Box>)}
      </SimpleGrid>
      <Stack gap="xs">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={30} />)}
      </Stack>
    </Stack>
  )
}

/** A whole screen in outline, shown while its first data loads. */
export function PageSkeleton() {
  return (
    <Stack gap="md" aria-busy="true" aria-label="Loading">
      <Skeleton h={28} w={240} />
      <Skeleton h={68} />
      <Skeleton h={62} />
      <Stack gap="xs">
        {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} h={34} />)}
      </Stack>
    </Stack>
  )
}

/**
 * The panel that slides in from the right for a form or a document. Its title is there at once;
 * while the content loads the body is an outline of it, and a failure is said in the body.
 */
export function SidePanel(props: {
  /** What is being done ("Return goods to supplier"). */
  title: ReactNode
  /** The record it is done to (a document number, a product). When given it is the heading and the action sits small above it. */
  subject?: ReactNode
  badge?: ReactNode
  size?: number
  loading?: boolean
  error?: Error | null
  onClose: () => void
  /** A panel that only shows things: typing in it (a date filter, say) loses nothing when it closes. */
  viewOnly?: boolean
  children?: ReactNode
}) {
  // The cross, Escape and a click outside all close the panel. If something was typed, they ask first.
  // A form that has saved closes itself by calling its own onClose, which does not come through here.
  const [typed, setTyped] = useState(false)
  const [asking, setAsking] = useState(false)
  const close = () => (typed && !props.viewOnly ? setAsking(true) : props.onClose())
  return (
    <Drawer
      opened
      onClose={close}
      position="right"
      size={props.size ?? 480}
      title={
        <Box>
          {props.subject && <Text size="xs" c="dimmed">{props.title}</Text>}
          <Group gap="sm"><Text fw={600} fz={18} lh={1.3}>{props.subject || props.title}</Text>{props.badge}</Group>
        </Box>
      }
    >
      <Box onInput={() => setTyped(true)}>
        {props.loading ? <PanelSkeleton /> : props.error ? <Alert color="red">{props.error.message}</Alert> : props.children}
      </Box>
      <ConfirmDialog opened={asking} title="Close without saving" confirm="Close without saving" keep="Keep editing"
        onConfirm={props.onClose} onClose={() => setAsking(false)}>
        What you typed here has not been saved.
      </ConfirmDialog>
    </Drawer>
  )
}

/** A form's save button. It can always be pressed; pressed while something is missing (`problem`), it says what, in red
 * beside it, and does nothing else. Before that press nothing is said: the form does not explain itself in advance. */
export function SaveButton({ problem, onClick, ...button }: ButtonProps & ComponentPropsWithoutRef<'button'> & { problem: string | null }) {
  const [tried, setTried] = useState(false)
  return (
    <>
      {tried && problem && <Text size="sm" c="red.8" role="alert">{problem}</Text>}
      <Button {...button} onClick={(event) => {
        setTried(true)
        if (problem) { event.preventDefault(); return }
        onClick?.(event)
      }} />
    </>
  )
}

interface Ask {
  /** the action and the document, as the question names them ("Approve", "PSA/26-27/000040") */
  action: string
  subject: string
  /** a line under the question, when the action needs one */
  note?: ReactNode
  /** red: the action cannot be undone by pressing another button */
  danger?: boolean
  /** the action needs a reason, typed in the dialog */
  reason?: boolean
  run: (reason: string) => Promise<unknown>
}

/** "Are you sure?" before any row action that changes something, the same on every screen. The confirm button says the
 * action and spins until the answer is back; a second press does nothing; a failure is shown in the dialog, which then
 * stays open; done, it closes. Render `dialog` once in the screen and call `ask` from the row buttons. */
export function useConfirm() {
  const [asking, setAsking] = useState<Ask | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function go() {
    if (!asking || busy) return
    if (asking.reason && !reason.trim()) return setError('Enter the reason.')
    setBusy(true)
    setError(null)
    try {
      await asking.run(reason.trim())
      setAsking(null)
      setReason('')
    } catch (e) {
      setError((e as Error).message || 'Could not do that. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const dialog = (
    <ConfirmDialog
      opened={Boolean(asking)} title={`${asking?.action ?? ''} ${asking?.subject ?? ''}`} confirm={asking?.action ?? ''} keep="Not now"
      danger={Boolean(asking?.danger)} loading={busy} error={error} onConfirm={go} onClose={() => { setAsking(null); setReason(''); setError(null) }}
    >
      {asking?.action} {asking?.subject}?
      {asking?.note && <Text size="sm" mt={4}>{asking.note}</Text>}
      {asking?.reason && <TextInput mt="sm" label="Reason" required maxLength={200} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />}
    </ConfirmDialog>
  )
  return { ask: (a: Ask) => { setError(null); setReason(''); setAsking(a) }, dialog }
}

/** Waiting for the rows of a table: outline rows in the table's own columns, never a "Loading" word. */
export function SkeletonRows({ rows = 4, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <Table.Tr key={r} aria-busy="true">{Array.from({ length: cols }, (_, c) => <Table.Td key={c}><Skeleton h={14} /></Table.Td>)}</Table.Tr>
      ))}
    </>
  )
}

/** Waiting for something that is not a table (a statement, a list of choices): outline lines. */
export function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <Stack gap={8} py={4} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} h={14} w={`${92 - i * 14}%`} />)}
    </Stack>
  )
}
