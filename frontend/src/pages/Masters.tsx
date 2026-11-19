import {
  Alert, Button, Checkbox, Group, NavLink, NumberInput, Select, Stack, Text,
  Textarea, TextInput,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconPlus, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import {
  DataTable, day, EmptyState, FilterBar, notifySuccess, Page, PageHeader, Pager, PageSkeleton, plain, RowActions,
  SidePanel, StatusBadge, type Column,
} from '../ui'

type Master = components['schemas']['MasterInfo']
type Field = components['schemas']['Field']
type Row = Record<string, string | number | null>
type Value = string | number | boolean | null

const PAGE_SIZE = 20
const GROUPS = ['Products', 'Stock', 'Finance', 'Permissions', 'Settings']

/** "Product Groups" -> "product group", "Routes of Administration" -> "route of administration". */
function thing(label: string) {
  const words = label.toLowerCase().split(' ')
  const at = words.indexOf('of') > 0 ? words.indexOf('of') - 1 : words.length - 1
  words[at] = words[at].endsWith('ies') ? words[at].replace(/ies$/, 'y') : words[at].replace(/s$/, '')
  return words.join(' ')
}

function shown(field: Field | undefined, value: Row[string]) {
  if (field?.type === 'checkbox') {
    if (field.name === 'is_active') return <StatusBadge status={value ? 'Active' : 'Inactive'} />
    return value ? 'Yes' : 'No'
  }
  if (value == null || value === '') return '--'
  if (field?.type === 'date') return day(String(value))
  if (field?.type === 'number') return plain(value)
  return String(value)
}

export function Masters() {
  const { key } = useParams()
  const masters = useQuery({ queryKey: ['masters'], queryFn: () => api<Master[]>('/api/masters'), staleTime: 60_000 })

  if (masters.isPending) return <PageSkeleton />
  if (masters.isError) return <Alert color="red">{masters.error.message}</Alert>
  const groups = GROUPS.map((group) => ({ group, items: masters.data.filter((master) => master.group === group) }))
  const current = masters.data.find((master) => master.key === key) ?? groups.find((g) => g.items.length)?.items[0]
  if (!current) return <EmptyState title="There are no masters." />

  const lists = (
    <>
          {groups.filter((g) => g.items.length).map(({ group, items }) => (
            <Stack key={group} gap={0} mb="xs">
              <Text size="xs" c="dimmed" fw={500} px="sm" py={6}>{group}</Text>
              {items.map((master) => (
                <NavLink
                  key={master.key}
                  component={Link}
                  to={`/masters/${master.key}`}
                  label={master.label}
                  active={master.key === current.key}
                  rightSection={<Text size="xs" c={master.key === current.key ? undefined : 'dimmed'}>{master.count}</Text>}
                  py={6}
                />
              ))}
            </Stack>
          ))}
    </>
  )
  return <Records key={current.key} master={current} lists={lists} />
}

function Records({ master, lists }: { master: Master; lists: ReactNode }) {
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Row | 'new' | null>(null)

  const query = new URLSearchParams({ q, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
  const list = useQuery({
    queryKey: ['masters', master.key, query.toString()],
    queryFn: () => api<{ rows: Row[]; total: number }>(`/api/masters/${master.key}?${query}`),
    placeholderData: keepPreviousData,
  })

  const fieldOf = Object.fromEntries(master.fields.map((field) => [field.name, field]))
  const columns: Column<Row>[] = [
    ...master.columns.map((name): Column<Row> => ({
      header: fieldOf[name]?.label ?? name,
      align: fieldOf[name]?.type === 'number' ? 'right' : undefined,
      cell: (row) => shown(fieldOf[name], row[name]),
    })),
    {
      header: 'Actions', align: 'right', width: 90,
      cell: (row) => <RowActions actions={[{ label: 'Edit', kind: 'main', onClick: () => setEditing(row) }]} />,
    },
  ]

  const header = (
    <>
      <PageHeader
        title={master.label}
        actions={<Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>New {thing(master.label)}</Button>}
      />
      <FilterBar>
        <TextInput
          aria-label={`Search ${master.label.toLowerCase()}`}
          placeholder={`Search ${master.label.toLowerCase()}`}
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(event) => { setSearch(event.currentTarget.value); setPage(1) }}
          maw={420}
        />
      </FilterBar>
    </>
  )

  return (
    <Page aside={lists} header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(row) => Number(row[master.pk])}
        view={query.toString()}
        loading={list.isFetching}
        empty={list.isError
          ? <EmptyState title="Could not load this list." hint={list.error.message} />
          : <EmptyState title={`No ${master.label.toLowerCase()} found.`} hint={q ? 'Change the search.' : undefined} />}
        footer={<Pager page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />}
      />
      {editing && (
        <RecordEditor master={master} row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Page>
  )
}

function RecordEditor({ master, row, onClose }: { master: Master; row: Row | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(master.fields.map((field) => [field.name, row ? row[field.name] : field.default ?? null])))
  const set = (name: string, value: Value) => setValues({ ...values, [name]: value })

  const save = useMutation({
    mutationFn: () => row
      ? api(`/api/masters/${master.key}/${row[master.pk]}`, 'PUT', values)
      : api(`/api/masters/${master.key}`, 'POST', values),
    onSuccess: async () => {
      // the product lists also feed the dropdowns of the Medicines form
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['masters'] }),
        queryClient.invalidateQueries({ queryKey: ['medicine-options'] }),
      ])
      const name = thing(master.label)
      notifySuccess(`${name[0].toUpperCase()}${name.slice(1)} saved.`)
      onClose()
    },
  })

  function control(field: Field) {
    const value = values[field.name]
    const common = { key: field.name, label: field.label, required: field.required }
    if (field.type === 'checkbox') {
      return <Checkbox key={field.name} label={field.label} checked={Boolean(value)} onChange={(e) => set(field.name, e.currentTarget.checked)} />
    }
    if (field.type === 'select') {
      return <Select {...common} data={field.options} value={value == null ? null : String(value)} onChange={(v) => set(field.name, v)} allowDeselect={!field.required} />
    }
    if (field.type === 'number') {
      return <NumberInput {...common} value={value == null ? '' : (value as number | string)} onChange={(v) => set(field.name, v)} hideControls />
    }
    if (field.type === 'textarea') {
      return <Textarea {...common} value={String(value ?? '')} onChange={(e) => set(field.name, e.currentTarget.value)} autosize minRows={2} />
    }
    return (
      <TextInput
        {...common}
        type={field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text'}
        value={String(value ?? '')}
        onChange={(e) => set(field.name, e.currentTarget.value)}
      />
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <SidePanel onClose={onClose} title={`${row ? 'Edit' : 'New'} ${thing(master.label)}`}>
      <form onSubmit={submit}>
        <Stack gap="sm">
          {master.fields.map(control)}
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
            <Button type="submit" loading={save.isPending}>Save</Button>
          </Group>
        </Stack>
      </form>
    </SidePanel>
  )
}
