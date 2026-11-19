import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { ConsignmentList, ConsignmentStock } from './pages/Consignments'
import { LocationRequestHistory, LocationStockRequests } from './pages/LocationRequests'
import { Deliveries } from './pages/Deliveries'
import { CashRegister, PaymentHistory, PurchaseRegister, SupplierOutstanding } from './pages/AccountsLists'
import { CashierSession, CashierSessions } from './pages/CashierSessions'
import { DebitNotes } from './pages/DebitNotes'
import { CashCounter } from './pages/CashCounter'
import { AuditLog } from './pages/AuditLog'
import { Dashboard } from './pages/Dashboard'
import { Masters } from './pages/Masters'
import { Reports } from './pages/Reports'
import { ReportsSummary } from './pages/ReportsSummary'
import { PayerClaims } from './pages/PayerClaims'
import { ReceiptEntry } from './pages/ReceiptEntry'
import { PatientAdvance, PatientBills } from './pages/PatientAccounts'
import { PaySupplier, PaymentApprovals } from './pages/SupplierPayments'
import { NewSale } from './pages/NewSale'
import { SaleBill } from './pages/SaleBill'
import { SalesHistory } from './pages/SalesHistory'
import { SalesRegister } from './pages/SalesRegister'
import { OverallStocks } from './pages/OverallStocks'
import { NewProductRequests } from './pages/NewProductRequests'
import { MedicineEditor } from './pages/MedicineEditor'
import { Medicines } from './pages/Medicines'
import { OpeningStock } from './pages/OpeningStock'
import { PhysicalStock } from './pages/PhysicalStock'
import { PurchaseList } from './pages/PurchaseList'
import { SaleBasedReport } from './pages/SaleBasedReport'
import { StockLedger } from './pages/StockLedger'
import { StockQuery } from './pages/StockQuery'
import { REGISTERS, StockRegister } from './pages/StockRegister'
import { WantedList } from './pages/WantedList'
import { NotBuilt, Shell } from './Shell'
import { cssVariables, theme } from './theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariables}>
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="medicines" element={<Medicines />}>
                <Route path="new" element={<MedicineEditor />} />
                <Route path=":itemId" element={<MedicineEditor />} />
              </Route>
              <Route path="masters/:key?" element={<Masters />} />
              <Route path="stock/overall-stocks" element={<OverallStocks />} />
              <Route path="purchase/wanted-list" element={<WantedList />} />
              <Route path="purchase/sale-based-order-report" element={<SaleBasedReport />} />
              <Route path="purchase/new-product-requests" element={<NewProductRequests />} />
              <Route path="purchase/consignment-receipts" element={<ConsignmentList key="receipts" kind="receipts" />} />
              <Route path="purchase/consignment-returns" element={<ConsignmentList key="returns" kind="returns" />} />
              <Route path="purchase/consignment-stock" element={<ConsignmentStock />} />
              <Route path="purchase/purchase-orders" element={<PurchaseList key="orders" kind="orders" />} />
              <Route path="purchase/goods-receipts" element={<PurchaseList key="receipts" kind="receipts" />} />
              <Route path="purchase/purchase-returns" element={<PurchaseList key="returns" kind="returns" />} />
              <Route path="stock/stock-issues" element={<StockRegister key="issues" register={REGISTERS['issues']} />} />
              <Route path="stock/stock-transfers" element={<StockRegister key="transfers" register={REGISTERS['transfers']} />} />
              <Route path="stock/stock-receipts" element={<StockRegister key="receipts" register={REGISTERS['receipts']} />} />
              <Route path="stock/stock-requests" element={<StockRegister key="requests" register={REGISTERS['requests']} />} />
              <Route path="stock/internal-stock-issue-history" element={<StockRegister key="internal-issues" register={REGISTERS['internal-issues']} />} />
              <Route path="stock/stock-adjustments" element={<StockRegister key="adjustments" register={REGISTERS['adjustments']} />} />
              <Route path="stock/stock-relocation" element={<StockRegister key="relocations" register={REGISTERS['relocations']} />} />
              <Route path="stock/physical-stock-history" element={<StockRegister key="counts" register={REGISTERS['counts']} />} />
              <Route path="stock/stock-write-offs" element={<StockRegister key="write-offs" register={REGISTERS['write-offs']} />} />
              <Route path="stock/opening-stock" element={<OpeningStock />} />
              <Route path="stock/internal-stock-issue-return" element={<StockRegister key="issue-returns" register={REGISTERS['internal-issue-returns']} />} />
              <Route path="stock/location-stock-requests" element={<LocationStockRequests />} />
              <Route path="stock/location-stock-request-history" element={<LocationRequestHistory />} />
              <Route path="sales/sales-history" element={<SalesHistory key="history" />} />
              <Route path="sales/bills/:id" element={<SaleBill />} />
              <Route path="sales/new-sale" element={<NewSale />} />
              <Route path="accounts/supplier-outstanding" element={<SupplierOutstanding />} />
              <Route path="accounts/payment-history" element={<PaymentHistory />} />
              <Route path="accounts/purchase-register" element={<PurchaseRegister />} />
              <Route path="accounts/cash-register" element={<CashRegister />} />
              <Route path="accounts/cashier-sessions" element={<CashierSessions />} />
              <Route path="accounts/pay-supplier" element={<PaySupplier />} />
              <Route path="accounts/cash-counter" element={<CashCounter />} />
              <Route path="accounts/receipt-entry" element={<ReceiptEntry />} />
              <Route path="accounts/payer-claims" element={<PayerClaims />} />
              <Route path="reports/reports" element={<Reports key="library" />} />
              <Route path="reports/summary" element={<ReportsSummary />} />
              <Route path="reports/audit-log" element={<AuditLog />} />
              <Route path="stock/unsold-stocks" element={<Reports key="unsold" fixed="unsold_stock" title="Unsold stocks" />} />
              <Route path="stock/ageing-stocks" element={<Reports key="ageing" fixed="ageing_stock" title="Ageing stocks" />} />
              <Route path="stock/expiring-stocks" element={<Reports key="expiring" fixed="short_expiry_stock" title="Expiring stocks" />} />
              <Route path="accounts/patient-bills" element={<PatientBills />} />
              <Route path="accounts/patient-advance" element={<PatientAdvance />} />
              <Route path="accounts/supplier-debit-notes" element={<DebitNotes />} />
              <Route path="accounts/payment-approvals" element={<PaymentApprovals />} />
              <Route path="accounts/cashier-sessions/:id" element={<CashierSession />} />
              <Route path="sales/deliveries" element={<Deliveries />} />
              <Route path="sales/sale-returns" element={<SalesHistory key="returns" returns />} />
              <Route path="sales/sales-register" element={<SalesRegister key="register" />} />
              <Route path="sales/estimates" element={<SalesRegister key="estimates" estimates />} />
              <Route path="stock/stock-query" element={<StockQuery />} />
              <Route path="stock/stock-ledger" element={<StockLedger />} />
              <Route path="stock/physical-stock" element={<PhysicalStock />} />
              <Route path="*" element={<NotBuilt />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
)
