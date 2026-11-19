import {
  IconBuildingWarehouse, IconCash, IconChartBar, IconLayoutDashboard, IconListDetails,
  IconPill, IconReceipt, IconTruckDelivery, type Icon,
} from '@tabler/icons-react'

export interface NavItem {
  label: string
  path?: string // a screen; absent on a group that only holds other items
  icon?: Icon
  built?: boolean
  children?: NavItem[]
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** Screens of the sections below that have been moved here; the rest show "Not built yet". */
const BUILT = new Set([
  '/stock/overall-stocks', '/stock/stock-query', '/stock/stock-ledger',
  '/purchase/purchase-orders', '/purchase/goods-receipts', '/purchase/purchase-returns', '/purchase/wanted-list',
  '/purchase/sale-based-order-report', '/purchase/new-product-requests',
  '/purchase/consignment-receipts', '/purchase/consignment-stock', '/purchase/consignment-returns',
  '/stock/stock-issues', '/stock/stock-transfers', '/stock/stock-receipts', '/stock/stock-requests', '/stock/internal-stock-issue-history', '/stock/stock-adjustments', '/stock/stock-relocation', '/stock/physical-stock-history',
  '/stock/opening-stock', '/stock/internal-stock-issue-return', '/stock/location-stock-requests',
  '/stock/location-stock-request-history', '/sales/sales-history', '/sales/sales-register', '/sales/estimates', '/sales/sale-returns', '/sales/deliveries', '/sales/new-sale',
  '/accounts/supplier-outstanding', '/accounts/payment-history', '/accounts/purchase-register', '/accounts/cash-register', '/accounts/cashier-sessions',
  '/accounts/pay-supplier', '/accounts/payment-approvals', '/accounts/supplier-debit-notes',
  '/accounts/patient-bills', '/accounts/patient-advance', '/accounts/cash-counter', '/accounts/receipt-entry', '/accounts/payer-claims',
  '/reports/reports', '/reports/summary', '/reports/audit-log', '/stock/unsold-stocks', '/stock/ageing-stocks', '/stock/expiring-stocks',
])
const screens = (section: string, labels: string[]): NavItem[] =>
  labels.map((label) => {
    const path = `/${section}/${slug(label)}`
    return { label, path, built: BUILT.has(path) }
  })

/** Every screen the DocAssist pharmacy has, in its own sections. `built` marks the ones moved here. */
export const NAV: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: IconLayoutDashboard, built: true },
  { label: 'Medicines', path: '/medicines', icon: IconPill, built: true },
  {
    label: 'Sales', icon: IconReceipt,
    children: screens('sales', ['New Sale', 'Sales History', 'Sales Register', 'Estimates', 'Sale Returns', 'Deliveries']),
  },
  {
    label: 'Purchase', icon: IconTruckDelivery,
    children: screens('purchase', [
      'Wanted List', 'Purchase Orders', 'Goods Receipts', 'Purchase Returns', 'Sale-based Order Report',
      'New Product Requests', 'Consignment Receipts', 'Consignment Stock', 'Consignment Returns',
    ]),
  },
  {
    label: 'Stock', icon: IconBuildingWarehouse,
    children: [
      {
        label: 'Movements',
        children: screens('stock', [
          'Stock Issues', 'Stock Transfers', 'Stock Receipts', 'Internal Stock Issue History',
          'Internal Stock Issue Return', 'Stock Requests', 'Location Stock Requests',
          'Location Stock Request History', 'Stock Relocation',
        ]),
      },
      {
        label: 'Counts and adjustments',
        children: [
          { label: 'Physical Stock', path: '/stock/physical-stock', built: true },
          ...screens('stock', ['Physical Stock History', 'Stock Adjustments', 'Opening Stock']),
        ],
      },
      {
        label: 'Registers and reports',
        children: screens('stock', [
          'Overall Stocks', 'Stock Query', 'Stock Ledger', 'Unsold Stocks', 'Ageing Stocks', 'Expiring Stocks',
        ]),
      },
    ],
  },
  {
    label: 'Accounts', icon: IconCash,
    children: [
      {
        label: 'Patients',
        children: screens('accounts', [
          'Cash Counter', 'Receipt Entry', 'Patient Advance', 'Patient Bills', 'Cash Register',
          'Cashier Sessions', 'Payer Claims',
        ]),
      },
      {
        label: 'Suppliers',
        children: screens('accounts', [
          'Pay Supplier', 'Payment Approvals', 'Payment History', 'Supplier Debit Notes',
          'Purchase Register', 'Supplier Outstanding',
        ]),
      },
    ],
  },
  { label: 'Reports', icon: IconChartBar, children: screens('reports', ['Reports', 'Summary', 'Audit Log']) },
  { label: 'Masters', path: '/masters', icon: IconListDetails, built: true },
]

/** Whether `path` is the screen `item` (or a page under it), or sits somewhere inside it. */
/** Screens reached from another screen rather than from the menu: the menu lights up the one they belong to. */
const UNDER: Record<string, string> = { '/stock/stock-write-offs': '/stock/stock-adjustments', '/stock/physical-stock': '/stock/physical-stock', '/sales/bills': '/sales/sales-history' }

export function holds(item: NavItem, at: string): boolean {
  const path = Object.entries(UNDER).find(([from]) => at === from || at.startsWith(`${from}/`))?.[1] ?? at
  if (item.path) return item.path === '/' ? path === '/' : path === item.path || path.startsWith(`${item.path}/`)
  return (item.children ?? []).some((child) => holds(child, path))
}

/** The screen at `path` with the groups above it, outermost first. */
export function trail(path: string, items: NavItem[] = NAV): NavItem[] {
  for (const item of items) {
    if (!holds(item, path)) continue
    return item.path ? [item] : [item, ...trail(path, item.children)]
  }
  return []
}
