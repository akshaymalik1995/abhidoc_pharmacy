import { Button, Collapse, Group, Select, SimpleGrid, Text, TextInput } from '@mantine/core'
import { useDebouncedValue, useDisclosure } from '@mantine/hooks'
import { IconAdjustmentsHorizontal, IconPlus, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import {
  ConfirmDialog, DataTable, EmptyState, FilterBar, notifyFailure, notifySuccess, Page, PageHeader, Pager, plain,
  RowActions, StatusBadge, type Column,
} from '../ui'

type Row = components['schemas']['MedicineRow']
type Page = components['schemas']['MedicinePage']
export type Options = Record<string, components['schemas']['Option'][]>

const PAGE_SIZE = 20
const TYPE: Record<string, string> = { MEDICINE: 'Medicine', CONSUMABLE: 'Consumable', OTHER: 'Other' }
/** Filters that pick one entry of a dropdown list of the hospital. */
const LIST_FILTERS = [
  ['product_group_code', 'Product group'],
  ['product_category_code', 'Product category'],
  ['manufacturer_code', 'Manufacturer'],
  ['marketer_code', 'Marketer'],
  ['prescription_classification', 'Prescription classification'],
] as const
const NO_FILTERS: Record<string, string> = { status: 'active' }

/** The hospital's dropdown lists. They change rarely, so they are fetched once. */
export function useMedicineOptions() {
  return useQuery({
    queryKey: ['medicine-options'],
    queryFn: () => api<Options>('/api/medicines/options'),
    staleTime: Infinity,
  })
}

export function Medicines() {
  const queryClient = useQueryClient()
  const options = useMedicineOptions()
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [filters, setFilters] = useState(NO_FILTERS)
  const [page, setPage] = useState(1)
  const [moreOpen, more] = useDisclosure(false)
  const [retiring, setRetiring] = useState<Row | null>(null)

  const query = new URLSearchParams({ ...filters, q, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
  const list = useQuery({
    queryKey: ['medicines', query.toString()],
    queryFn: () => api<Page>(`/api/medicines?${query}`),
    placeholderData: keepPreviousData,
  })

  /** Change one filter; an empty value removes it. Any change starts again from page 1. */
  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }
  const narrowed = Object.keys(filters).filter((name) => name !== 'status').length

  const setActive = useMutation({
    mutationFn: (change: { row: Row; active: boolean }) =>
      api(`/api/medicines/${change.row.item_id}/active`, 'POST', { active: change.active }),
    onSuccess: (_, change) => {
      notifySuccess(`${change.row.item_name} ${change.active ? 'activated' : 'deactivated'}.`)
      return queryClient.invalidateQueries({ queryKey: ['medicines'] })
    },
    onError: notifyFailure,
    onSettled: () => setRetiring(null),
  })

  const columns: Column<Row>[] = [
    {
      header: 'Product',
      cell: (row) => (
        <Group gap="xs" wrap="nowrap">
          <Text component={Link} to={`/medicines/${row.item_id}`} fw={500} size="sm" c="bottle.7">{row.item_name}</Text>
          {!row.is_active && <StatusBadge status="Inactive" />}
        </Group>
      ),
    },
    { header: 'Generic / molecule', cell: (row) => row.generic_name || '--' },
    { header: 'Type', cell: (row) => TYPE[row.item_type] ?? row.item_type },
    { header: 'Strength / Dosage form', cell: (row) => [row.strength, row.dosage_form].filter(Boolean).join(' / ') || '--' },
    { header: 'Unit', cell: (row) => row.unit || '--' },
    { header: 'Manufacturer', cell: (row) => row.manufacturer || '--' },
    { header: 'Tax %', align: 'right', cell: (row) => plain(row.tax_percent) },
    { header: 'Reorder level', align: 'right', cell: (row) => plain(row.reorder_level) },
    {
      header: 'Actions', align: 'right',
      cell: (row) => (
        <RowActions
          name={row.item_name}
          actions={[
            { label: 'Edit', kind: 'main', to: `/medicines/${row.item_id}` },
            row.is_active
              ? { label: 'Deactivate', kind: 'danger', onClick: () => setRetiring(row) }
              : { label: 'Activate', onClick: () => setActive.mutate({ row, active: true }) },
          ]}
        />
      ),
    },
  ]

  const header = (
    <>
      <PageHeader
        title="Medicines"
        actions={<Button component={Link} to="/medicines/new" leftSection={<IconPlus size={16} />}>New product</Button>}
      />
      <FilterBar>
        <Group align="end">
          <TextInput
            aria-label="Search products"
            placeholder="Search by product, generic or brand name"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => { setSearch(event.currentTarget.value); setPage(1) }}
            style={{ flex: 1 }}
            miw={240}
          />
          <Select
            aria-label="Status"
            data={[{ value: 'active', label: 'Active products' }, { value: 'all', label: 'All products' }]}
            value={filters.status}
            onChange={(value) => setFilter('status', value ?? 'active')}
            allowDeselect={false}
            w={170}
          />
          <Button variant="default" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={more.toggle}>
            Filters{narrowed ? ` (${narrowed})` : ''}
          </Button>
        </Group>
        <Collapse expanded={moreOpen}>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} mt="md">
            {LIST_FILTERS.map(([name, label]) => (
              <Select
                key={name}
                label={label}
                placeholder="All"
                data={(options.data?.[name] ?? []).map((option) => ({ value: option.code, label: option.name }))}
                value={filters[name] ?? null}
                onChange={(value) => setFilter(name, value)}
                clearable
                searchable
              />
            ))}
            <Select
              label="Consignment"
              placeholder="All"
              data={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
              value={filters.consignment ?? null}
              onChange={(value) => setFilter('consignment', value)}
              clearable
            />
          </SimpleGrid>
          <Group justify="flex-end" mt="md">
            <Button variant="default" disabled={!narrowed} onClick={() => { setFilters({ status: filters.status }); setPage(1) }}>
              Clear filters
            </Button>
          </Group>
        </Collapse>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.item_id}
        view={query.toString()}
        loading={list.isFetching}
        empty={list.isError
          ? <EmptyState title="Could not load the products." hint={list.error.message}
              action={<Button variant="default" onClick={() => list.refetch()}>Try again</Button>} />
          : <EmptyState title="No products found." hint={q || narrowed ? 'Change the search or the filters.' : 'Add the first product.'} />}
        footer={<Pager page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />}
      />

      <ConfirmDialog
        opened={Boolean(retiring)}
        title="Deactivate product"
        confirm="Deactivate"
        keep="Keep active"
        loading={setActive.isPending}
        onConfirm={() => retiring && setActive.mutate({ row: retiring, active: false })}
        onClose={() => setRetiring(null)}
      >
        {retiring?.item_name} will no longer be offered in sales, purchases or stock screens. You can activate it again later.
      </ConfirmDialog>

      <Outlet />
    </Page>
  )
}
