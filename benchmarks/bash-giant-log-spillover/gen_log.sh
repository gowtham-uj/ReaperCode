#!/bin/env bash
# Generate a deterministic 12K-line log without openssl/rand.
# Output: ~840,000 bytes (210K tokens at 4 chars/token).
{
  for i in $(seq 1 12000); do
    printf 'line %05d :: seq=%d value=%064d hash=000000000000%04x status=ok\n' "$i" "$i" "$i" "$i"
  done
} > /tmp/reaper-stress-bash-giant-log-spillover.log
wc -c /tmp/reaper-stress-bash-giant-log-spillover.log