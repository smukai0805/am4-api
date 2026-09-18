// Backward-compatible report-only exports.
//
// The durable implementation now lives in match-editorial-sync so predictions
// and reports cannot drift into separate recovery semantics. Retain this
// module path for focused report tests and any internal legacy import.

import {
  MATCH_EDITORIAL_BACKFILL_GENERATION,
  matchEditorialBackfillNeedsScan,
  queueMatchEditorialBackfill,
  queueUnlinkedMatchEditorialReconciliation,
} from './match-editorial-sync.js';

export const MATCH_REPORT_BACKFILL_GENERATION = MATCH_EDITORIAL_BACKFILL_GENERATION;

export function matchReportBackfillNeedsScan(state) {
  return matchEditorialBackfillNeedsScan(state, ['match_report']);
}

export async function queueMatchReportBackfill(options = {}) {
  const result = await queueMatchEditorialBackfill({ ...options, types: ['match_report'] });
  return result.types.match_report;
}

export async function queueUnlinkedMatchReportReconciliation(options = {}) {
  const result = await queueUnlinkedMatchEditorialReconciliation({ ...options, types: ['match_report'] });
  return result.types.match_report;
}
