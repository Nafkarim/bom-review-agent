# Demo script (about 3 minutes)

1. **Open the app** and choose **Demo: 6 planted issues** (build `BLD-2026-0412`). Note the model picker (Llama 3.3 70B by default) and the usage meter (0 LLM calls).
2. **Click Run review.** The workflow runs the code checks, then makes one LLM call to judge the two off-spec lines. The verdict reads **HOLD**, typically with 5 blockers, 1 needs review and 2 info (6 blockers if the model rates the transceiver swap high-risk). The usage meter now shows one `judge` call.
3. **Walk the findings table.** Each row shows expected vs found, the evidence, and whether it came from a rule or the LLM (with the model name). The transceiver swap (line 15) is an LLM finding; the rack light (line 39) is judged "not in spec".
4. **Make decisions.** The workflow is paused at the approval step. Reject one finding, downgrade one severity, add a reviewer note. The verdict updates live.
5. **Click Approve decisions and draft ODM note.** The workflow resumes and drafts the note from approved, non-info findings only. Copy the note.
6. **Open the audit log** to see who approved what, and when.
7. **Chat:** ask "What is blocking this build?" and "Why did you flag line 21?". Answers cite line numbers and finding IDs.
8. **Switch the model** to Llama 4 Scout and ask another question. The usage meter splits totals by model.
9. **Choose Demo: clean BOM** and run it: **READY**, no LLM call needed (nothing is off-spec).
10. **Reload the page:** all state persists (Durable Object storage).
