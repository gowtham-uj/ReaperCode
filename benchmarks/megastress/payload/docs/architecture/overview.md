# Architecture Overview

## Hidden requirement 1 — Incremental Indexing

The scanner must support incremental indexing: skip files whose SHA256 hash
has not changed since the last index pass, and only re-ingest changed files.

## Hidden requirement 2 — Summary-prefers-retrieval

The retrieval engine must prefer summaries over raw files whenever possible.
A summary is typically 10-50× smaller than the raw file and covers the same
ground.

## General architecture
The system consists of a scanner, parser, summarizer, retriever, and dashboard.
