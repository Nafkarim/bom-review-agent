# Answer key: BLD-2026-0507 (seed 20261029)

50 BOM lines against spec RS-COMPUTE-48U rev C, need-by 2026-12-18, reviewed as of 2026-10-29.
Regenerate with `node scripts/make-test-bom.mjs 20261029` (another seed gives a different layout).

| # | Line(s) | Part | Expected finding | Severity | Found by | What's wrong |
|---:|---|---|---|---|---|---|
| 1 | 4 | RK-SRV-2U-G5 | missing-data | needs-review | rule | cert FAI-SRV-2U-G5-R2 is referenced but not in certs.csv |
| 2 | 5, 6 | RK-PSU-1600 | cert | blocker | rule | cert FAI-PSU-1600-OLD is against drawing rev B, spec is rev C |
| 3 | 11, 12 | HX-U2-3840 | substitution | needs-review (blocker if the model rates it high-risk) | llm | Halcyon Storage HX-U2-3840 replaces RK-SSD-3T84 (Meridian Compute), not on the approved list |
| 4 | 19 | RK-SW-MGMT-1G | revision-mismatch | blocker | rule | rev A, spec needs rev B |
| 5 | 22 | RK-DAC-100G-2M | quantity | blocker | rule | total 31, spec needs 32 (short 1, split across 2 lines) |
| 6 | 38 | RK-PANEL-SIDE | vendor | blocker | rule | Brightwater Mfg is not an approved manufacturer (spec: Granite Racks) |
| 7 | 42 | RK-PDU-MON | not-in-spec | blocker | llm | RK-PDU-MON (PDU environmental monitoring dongle) is not in the spec |
| 8 | 48 | RK-TRAY-VERT | lead-time | blocker | rule | 81-day lead time lands 31 days after need-by 2026-12-18 |

Rack power is also reported as an info finding when it is above 90% of the budget.
Without a model, the two LLM items go to the reviewer as needs-review, and the replaced spec part shows as missing (blocker).
