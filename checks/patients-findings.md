# Clerk check findings: Accounts > Patients (run of 16 Nov 2026)

Screenshots: `screens/<workflow>/<step>.png`. ★ = most important.

| # | Workflow / step | Problem | Proposed fix | Screenshot |
|---|---|---|---|---|
| ★1 | 1.2 Open session, 4.5 Receipt save | "Choose a pharmacy location first." although the top bar says Main Pharmacy. The new app keeps the location only in the browser; DocAssist never hears it. Blocks opening a session, closing one (all of flow 6) and Receipt Entry saves. | Send the top-bar location to DocAssist (on choosing it and on login), or pass `location_id` with every cashier/receipt request. | 1-cashier-sessions/FAILED, 4-receipt-entry/4.5b-saved |
| ★2 | 3.5 Refund from a row | The refund amount is the row's Amount box, which shows the balance due (₹18), not what was collected (₹2). The panel has no amount field, so the clerk must know to edit the row first; otherwise DocAssist refuses with a sentence. | Amount field inside the Refund panel, filled with the refundable amount, editable. | 3-cash-counter/3.5a-refund-form |
| ★3 | 7.1 Cash Register | User column shows "User 1", "User 99", not names; advance rows show the MRN as patient and "--" as location; one advance shows "Bill 7737". | Join cashier names and patient names; show the location of advances. | 7-cash-register/7.1-today |
| 4 | 3.3 Tick a bill | The payment bar appears above the table when a bill is ticked, pushing the table down 43 px. | Keep its space, or put it in the bottom bar. | 3-cash-counter/3.3a-ticked |
| 5 | 3.5 Refund notice | "PSL/…397: Refunded 1.00 against PSL/…397. Still refundable ₹1.00." — the bill number twice, amount without ₹. | "Refunded ₹1.00 on PSL/…397." | 3-cash-counter/3.5b-refunded |
| 6 | 3.1 Cash Counter rows | Patient name cut off ("AKTEST Clerk 111612…"). | Let the patient column wrap, or narrow Billed by. | 3-cash-counter/3.1-open |
| 7 | 4.2 Receipt Entry | Visit row is a sentence: "Current visit Walk-in (no visit), 3 bills, ₹51.00 balance due". | Labelled facts, as on Patient Bills. | 4-receipt-entry/4.2-found |
| 8 | 4.2 Receipt Entry header | "Matched by MRN" is noise when the clerk searched by MRN. | Show "Matched by" only for name/phone matches. | 4-receipt-entry/4.2-found |
| 9 | Patient links | Button "Take payment" opens a screen titled "Receipt entry". | One name: "Receipt entry" on the button too. | 5-patient-bills/5.2-statement |
| 10 | 5.1 Patient Bills search | The "Find a patient…" empty sentence still shows under the list of matches. | Hide it once matches show. | 5-patient-bills/5.1b-matches |
| 11 | 2.2 Patient Advance | Blank page while the patient loads: no skeleton. | Skeleton lines, as on Patient Bills. | 2-patient-advance/2.2-found |
| 12 | 7.1 Cash Register | "Cash in / Cash out / UPI in" line repeats the header figures. | Drop it, or fold the by-mode figures into the header. | 7-cash-register/7.1-today |

Not walked: 1.3–1.4 and all of flow 6 (blocked by #1); 5.4 rejecting the write-off (needs Payment Approvals; the AKTEST write-off request stays pending).
