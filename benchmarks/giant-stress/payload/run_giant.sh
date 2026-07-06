#!/usr/bin/env bash
# Deterministic 1.5MB stdout generator for the giant A/B stress test.
{
  for i in $(seq 1 30000); do
    printf 'line %05d :: seq=%d value=%064d hash=000000000000%04x status=ok\n' "$i" "$i" "$i" "$i"
  done
}
