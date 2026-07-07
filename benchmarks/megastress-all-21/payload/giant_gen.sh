#!/bin/bash
# giant_gen: 100K-char output (forces PTL recovery if it overflows)
python3 -c "print('x' * 100000)"
