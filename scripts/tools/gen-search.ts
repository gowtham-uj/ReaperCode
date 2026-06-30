#!/usr/bin/env node
/**
 * Generate the complete web-search.ts implementation.
 * This is a build-time script that produces the actual tool file.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

const L = '