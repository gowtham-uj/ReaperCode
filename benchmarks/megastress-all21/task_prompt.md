# megastress-all21 (force all 21 context-engineering layers)

You are in `payload/`. **PROHIBITED for this entire run**: any use of
`>`, `| head`, `| tail`, `| wc`, `| grep`, or any redirect that shrinks
bash stdout below 1K chars. Each call must let the FULL stdout flow
back to the runtime. Hard test constraint.

## Steps (do not skip, do not reorder)

1. Read `src/index.ts` and `src/helper.js` twice each (file_view cache).

2. Read `src/index.ts` a third time to confirm cache hit.

3. Run `bash gen_1.sh` through `bash gen_8.sh` ONCE each, in numerical
order, no redirects, no pipes. Each sleeps 35s. After all 8 complete,
compile a list of SECRET_n_MARKER values.

4. Write `final.md` with the 8 SECRET_n_MARKER values. End with
`###TASK_COMPLETED###`.

This fixture is designed to force:
- bash head+tail (each gen_*.sh outputs > 8K chars)
- time-microcompact (35s gaps between gen_*.sh commands)
- shake (cumulative tool results)
- full summarization (final context > 8000 - 16K threshold)
