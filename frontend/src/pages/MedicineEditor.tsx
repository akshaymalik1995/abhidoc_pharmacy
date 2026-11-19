import {
  Alert, Button, Checkbox, Divider, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDebouncedValue } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import { notifySuccess, SidePanel } from '../ui'
import { useMedicineOptions, type Options } from './Medicines'

type Medicine = components['schemas']['Medicine']
type Values = components['schemas']['MedicineForm']
type Page = components['schemas']['MedicinePage']
type Name = keyof Values

interface Field {
  name: Name
  label: string
  kind: 'text' | 'number' | 'choice' | 'flag'
  max?: number // longest text the column holds
  scale?: number // decimal places of a number
}
const text = (name: Name, label: string, max: number): Field => ({ name, label, kind: 'text', max })
const number = (name: Name, label: string, scale: number): Field => ({ name, label, kind: 'number', scale })
const choice = (name: Name, label: string): Field => ({ name, label, kind: 'choice' })
const flag = (name: Name, label: string): Field => ({ name, label, kind: 'flag' })

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: 'Product',
    fields: [
      choice('item_type', 'Type'), choice('unit_of_measure', 'Stock unit'),
      text('generic_name', 'Generic name', 255), text('brand_name', 'Brand name', 255),
      choice('dosage_form', 'Dosage form'), text('strength', 'Strength', 100),
      text('product_code', 'Product code', 64), text('hsn_code', 'HSN code', 32),
    ],
  },
  {
    title: 'Classification',
    fields: [
      choice('product_group_code', 'Product group'), choice('product_category_code', 'Product category'),
      choice('manufacturer_code', 'Manufacturer'), choice('marketer_code', 'Marketer'),
      choice('division_code', 'Division'), choice('route_administration', 'Route of administration'),
      choice('prescription_classification', 'Prescription classification'),
      choice('drug_classification', 'Drug classification'),
    ],
  },
  {
    title: 'Pricing and reordering',
    fields: [
      number('tax_percent', 'Tax %', 2), number('discount_percent', 'Discount %', 3),
      number('minimum_margin_percent', 'Minimum margin %', 3), number('reorder_level', 'Reorder level', 3),
      number('reorder_quantity', 'Reorder quantity', 3), number('minimum_order_quantity', 'Minimum order quantity', 3),
    ],
  },
  {
    title: 'Storage and coding',
    fields: [
      text('storage_temperature', 'Storage temperature', 128),
      text('snomed_branded_medicine_id', 'SNOMED branded id', 128),
      text('snomed_generic_medicine_id', 'SNOMED generic id', 128),
    ],
  },
  {
    title: 'Handling',
    fields: [
      flag('is_expirable', 'Expirable'), flag('is_claimable', 'Claimable'),
      flag('is_non_returnable', 'Non-returnable'), flag('is_non_discountable', 'Non-discountable'),
      flag('is_high_risk_medicine', 'High-risk medicine'), flag('is_emergency_medicine', 'Emergency medicine'),
      flag('is_consignment_product', 'Consignment product'),
    ],
  },
]

const NEW_PRODUCT: Values = {
  item_name: '', item_type: 'MEDICINE', unit_of_measure: '', generic_name: '', brand_name: '', dosage_form: '',
  strength: '', product_code: '', hsn_code: '', product_group_code: '', product_category_code: '',
  manufacturer_code: '', marketer_code: '', division_code: '', route_administration: '',
  prescription_classification: '', drug_classification: '', storage_temperature: '',
  snomed_branded_medicine_id: '', snomed_generic_medicine_id: '', tax_percent: 0, discount_percent: 0,
  minimum_margin_percent: 0, reorder_level: 0, reorder_quantity: 0, minimum_order_quantity: 0,
  is_expirable: true, is_claimable: false, is_non_returnable: false, is_non_discountable: false,
  is_high_risk_medicine: false, is_emergency_medicine: false, is_consignment_product: false,
}

const NUMBER_FIELDS = SECTIONS.flatMap((section) => section.fields).filter((field) => field.kind === 'number').map((field) => field.name)
/** Only the form's own fields of a stored product. */
const formValues = (stored: Medicine) =>
  Object.fromEntries(Object.keys(NEW_PRODUCT).map((name) => [name, stored[name as Name]])) as Values

const named = (...names: string[]) => names.map((name) => ({ value: name.toLowerCase(), label: name }))
/** Choices that do not come from the hospital's lists, or stand in while a list is empty. */
const BUILT_IN: Partial<Record<Name, { value: string; label: string }[]>> = {
  item_type: [
    { value: 'MEDICINE', label: 'Medicine' }, { value: 'CONSUMABLE', label: 'Consumable' }, { value: 'OTHER', label: 'Other' },
  ],
  unit_of_measure: named('Strip', 'Bottle', 'Piece', 'Box', 'Vial', 'Tube', 'Sachet', 'Packet', 'Ampoule', 'Cartridge'),
  dosage_form: named(
    'Tablet', 'Capsule', 'Syrup', 'Suspension', 'Drops', 'Powder', 'Granules', 'Injection', 'Ointment', 'Cream',
    'Gel', 'Lotion', 'Patch', 'Inhaler', 'Spray',
  ),
}

/** What a dropdown offers: the hospital's list (else the built-in one), plus the stored value if it is on neither. */
function choices(name: Name, options: Options | undefined, stored: string) {
  const listed = (options?.[name] ?? []).map((option) => ({ value: option.code, label: option.name }))
  const offered = listed.length ? listed : (BUILT_IN[name] ?? [])
  return stored && !offered.some((option) => option.value === stored)
    ? [...offered, { value: stored, label: stored }]
    : offered
}

/** The drawer over the Medicines list: /medicines/new or /medicines/:itemId. */
export function MedicineEditor() {
  const navigate = useNavigate()
  const { itemId } = useParams()
  const close = () => navigate('/medicines')
  const stored = useQuery({
    queryKey: ['medicines', 'item', itemId],
    queryFn: () => api<Medicine>(`/api/medicines/${itemId}`),
    enabled: Boolean(itemId),
  })

  return (
    <SidePanel
      onClose={close}
      size={760}
      title={itemId ? 'Edit product' : 'New product'}
      subject={itemId ? stored.data?.item_name : undefined}
      loading={Boolean(itemId) && stored.isPending}
      error={itemId ? stored.error : null}
    >
      {!itemId && <ProductForm initial={NEW_PRODUCT} onDone={close} />}
      {itemId && stored.data && <ProductForm key={stored.data.item_id} initial={formValues(stored.data)} itemId={stored.data.item_id} onDone={close} />}
    </SidePanel>
  )
}

function ProductForm(props: { initial: Values; itemId?: number; onDone: () => void }) {
  const queryClient = useQueryClient()
  const options = useMedicineOptions()
  const form = useForm<Values>({
    initialValues: props.initial,
    validate: { item_name: (value) => (value.trim() ? null : 'Enter the product name.') },
  })

  // Look-alikes ("Paracetamol 650" next to "Paracetamol 650mg Tab") are shown before anyone saves.
  const [typedName] = useDebouncedValue(form.values.item_name.trim(), 300)
  const similar = useQuery({
    queryKey: ['medicines', 'similar', typedName],
    queryFn: () => api<Page>(`/api/medicines?limit=5&q=${encodeURIComponent(typedName)}`),
    enabled: typedName.length >= 2,
  })
  const lookAlikes = (typedName.length >= 2 ? similar.data?.items ?? [] : []).filter((row) => row.item_id !== props.itemId)

  const save = useMutation({
    mutationFn: (values: Values) => {
      // an emptied number box means 0, an empty stock unit means the plain "unit"
      const body: Record<string, unknown> = { ...values, unit_of_measure: values.unit_of_measure || 'unit' }
      for (const name of NUMBER_FIELDS) if (body[name] === '') body[name] = 0
      return props.itemId
        ? api<Medicine>(`/api/medicines/${props.itemId}`, 'PUT', body)
        : api<Medicine>('/api/medicines', 'POST', body)
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['medicines'] })
      notifySuccess(`${saved.item_name} saved.`)
      props.onDone()
    },
  })

  function control(field: Field) {
    const input = form.getInputProps(field.name, { type: field.kind === 'flag' ? 'checkbox' : 'input' })
    if (field.kind === 'flag') return <Checkbox key={field.name} label={field.label} {...input} />
    if (field.kind === 'number') {
      return <NumberInput key={field.name} label={field.label} min={0} allowNegative={false} decimalScale={field.scale} hideControls {...input} />
    }
    if (field.kind === 'choice') {
      return (
        <Select
          key={field.name}
          label={field.label}
          placeholder="Select"
          data={choices(field.name, options.data, String(props.initial[field.name] ?? ''))}
          value={(form.values[field.name] as string) || null}
          onChange={(value) => form.setFieldValue(field.name, value ?? '')}
          clearable={field.name !== 'item_type'}
          allowDeselect={field.name !== 'item_type'}
          searchable
        />
      )
    }
    return <TextInput key={field.name} label={field.label} maxLength={field.max} {...input} />
  }

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))} noValidate>
      <Stack gap="lg">
        <Stack gap={4}>
          <TextInput label="Product name" required maxLength={255} data-autofocus {...form.getInputProps('item_name')} />
          {lookAlikes.length > 0 && (
            <Text size="xs" c="dimmed">
              Similar products: <Text span fw={600} c="dark">{lookAlikes.map((row) => row.item_name).join(', ')}</Text>
            </Text>
          )}
        </Stack>
        {SECTIONS.map((section) => (
          <Stack key={section.title} gap="sm">
            <Divider label={<Text size="sm" fw={600} c="dark">{section.title}</Text>} labelPosition="left" />
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="sm">
              {section.fields.map(control)}
            </SimpleGrid>
          </Stack>
        ))}
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" pos="sticky" bottom={0} bg="white" py="sm">
          <Button type="submit" loading={save.isPending}>Save product</Button>
        </Group>
      </Stack>
    </form>
  )
}
