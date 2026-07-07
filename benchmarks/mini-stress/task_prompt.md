# mini-stress (forced layer firing)

You are in `payload/`. **PROHIBITED** for the entire run: any use of `>`,
`| head`, `| tail`, `| wc`, `| grep`, or any other redirect/pipe on tool
output that would shrink bash stdout below 1K chars. Each call must let
the FULL bash stdout flow back to the runtime. This is a hard test
constraint.

## Steps (do not skip, do not reorder)

### 1. Read `src/index.ts` and `src/helper.js` twice each (file_view cache).

### 2. Run `bash big.sh` ONCE. The output is ~100K chars. DON'T redirect.

### 3. Run `bash long_sleep.sh` ONCE. It sleeps 32s — that's the time-microcompact gap.

### 4. Run `bash gen_1.sh`, `bash gen_2.sh`, `bash gen_3.sh`,
`bash gen_4.sh` — each ONCE, no redirects. Each returns ~12K chars.
The SECRET_n_MARKER is somewhere in each output; you can use grep on
the persisted_output_path if the runtime shows it was truncated.

### 5. Write `final.md` with:
- The 4 SECRET_N_MARKER values you found
- Total tool calls made
End the file with `###TASK_COMPLETED###`.
