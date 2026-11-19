# Clerk check: Accounts > Patients

Every interaction a counter clerk has with the Patients screens. `patients.mjs` walks all of them in this order,
on test data it makes itself (an AKTEST walk-in patient with three unpaid bills), and saves a screenshot per step in
`screens/<workflow>/<step>.png`. Rerun: `cd D:\abhinay\pharmacy\checks && node patients.mjs` (or `node patients.mjs 3 4` for some flows) (servers on :5002, :8000, :5173).

## 0. Setup (by request, not on screen)
- Add 3 units of opening stock of AKTEST 1106 at Main Pharmacy.
- Make 3 confirmed, unpaid walk-in bills for patient "AKTEST Clerk <run>", MRN "AKTEST-CC-<run>".

## 1. Cashier Sessions
- 1.1 Open the list.
- 1.2 Press Open cashier session, see the form, enter float 0 and a remark, open it.
- 1.3 Land on the session page; read the closing totals, transfers, transactions.
- 1.4 Go back to the list with the back button.

## 2. Patient Advance
- 2.1 Open the screen empty.
- 2.2 Find the patient by MRN.
- 2.3 Collect an advance of 10 in cash.
- 2.4 Refund 2 of it.
- 2.5 Go to the same patient's Bills with the link.

## 3. Cash Counter
- 3.1 Open the screen: the unpaid list, the session badge.
- 3.2 Search the patient's MRN.
- 3.3 Tick bill 1, change its amount to 2, choose UPI, collect.
- 3.4 Tick bill 2, choose Patient advance, collect.
- 3.5 Refund 1 on bill 1 from its row.
- 3.6 Open the patient's Bills from a row.

## 4. Receipt Entry
- 4.1 Open the screen empty.
- 4.2 Find the patient by MRN.
- 4.3 Select all unpaid, see the amounts spread.
- 4.4 Type a smaller receipt total, see it spread oldest first.
- 4.5 Press Save with nothing selected (the reason shows), then save a real receipt.

## 5. Patient Bills
- 5.1 Find the patient by name.
- 5.2 Choose them from the list; read the statement and the totals.
- 5.3 Write off bill 3: press Send without a reason, then with one.

## 6. Cashier session, closing
- 6.1 Open today's session again.
- 6.2 New cash transfer of 1: save, confirm it from the row.
- 6.3 Close the session with a wrong count, see the variance.
- 6.4 Approve the variance with a reason.
- 6.5 Add an adjustment of 1 with a reason.

## 7. Cash Register
- 7.1 Open on today; read the figures and the receipts.
- 7.2 By day, By user tabs.
- 7.3 Filter by payment mode UPI.

## 8. Payer Claims
- 8.1 Open; filter by a status; search.

## 9. Payment Approvals (runs after 5)
- 9.1 Open the list.
- 9.2 Approve the write-off: see the confirm, press Not now. Reject it from the row menu: see the confirm.
- 9.3 Reject it (puts the bill back).
- 9.4 Reject any write-offs left by earlier runs of this check.
