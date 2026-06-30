#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../../src/tools/read/web-search.ts');
const existing = fs.readFileSync(target, 'utf8');

const LT = '