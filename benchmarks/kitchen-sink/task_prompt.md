# kitchen-sink (force ALL 21 layers)

You are in `payload/`. There are 42 small bash scripts `gen_01.sh`
through `gen_42.sh`. Each script produces ~12K chars of stdout AND
sleeps 15 seconds.

**HARD CONSTRAINTS** (do not violate, layers will not fire otherwise):
- NO `>`, NO `| head`, NO `| tail`, NO `| wc`, NO `| grep` on bash output
- Each call must let the FULL raw stdout flow back to the runtime
- (You may use grep_search / file_view to inspect the persisted
  artifact paths the runtime surfaces.)

## Steps (do not skip, do not reorder)

1. file_view `src/index.ts` and `src/helper.js` 3 times each.
2. Run `bash gen_01.sh` through `bash gen_42.sh` in numerical order.
   Each takes ~15s. Don't pipe, don't redirect.
3. For each gen_NN.sh, find the SECRET_NN_MARKER value via grep_search
   on the runtime's logged path (the trajectory reveals persisted
   output paths).
4. Write `final.md` with all 42 SECRET_NN_MARKER values.

End with `###TASK_COMPLETED###`.
