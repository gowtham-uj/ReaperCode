#!/usr/bin/env node
/**
 * Write the complete web-search.ts implementation.
 */
const fs = require('fs');
const path = require('path');

const IMPL = `
export async function webSearchTool(
  args: WebSearchArgs,
  options: { fetchImpl?: any; now?: Date } = {},
): Promise