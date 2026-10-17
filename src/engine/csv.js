'use strict';
/**
 * CSV export.
 *
 * GRC's benchmark advertises a "fully detailed, locale-aware,
 * (internationalized)" CSV export and a logging mode for unattended runs. This
 * mirrors that: every column is present whether or not it was measured, the
 * delimiter and decimal separator are configurable (a spreadsheet in a
 * comma-decimal locale is the usual reason a CSV "opens wrong"), and the
 * function returns the text so the caller decides where it goes — a file in the
 * app, a file in headless mode.
 */

const HEADERS = [
  'rank',
  'label',
  'operator',
  'transport',
  'endpoint',
  'host',
  'ip',
  'address_pinned',
  'is_system_resolver',
  'status',
  'setup_ms',
  'cached_mean_ms',
  'cached_median_ms',
  'cached_min_ms',
  'cached_max_ms',
  'cached_stdev_ms',
  'cached_p95_ms',
  'cached_samples',
  'cached_lost',
  'uncached_mean_ms',
  'uncached_median_ms',
  'uncached_min_ms',
  'uncached_max_ms',
  'uncached_stdev_ms',
  'uncached_p95_ms',
  'uncached_samples',
  'uncached_lost',
  'dotcom_mean_ms',
  'dotcom_median_ms',
  'dotcom_min_ms',
  'dotcom_max_ms',
  'dotcom_stdev_ms',
  'dotcom_p95_ms',
  'dotcom_samples',
  'dotcom_lost',
  'queries_sent',
  'queries_lost',
  'reliability_percent',
  'errors',
  'nxdomain_hijacked',
  'nxdomain_answer',
  'rebinding_ranges_filtered',
  'rebinding_ranges_tested',
  'dnssec_validated_zones',
  'dnssec_zones_tested',
];

function cell(value, options) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'number') {
    text = Number.isInteger(value) ? String(value) : value.toFixed(2);
    if (options.decimalComma) text = text.replace('.', ',');
  } else {
    text = String(value);
  }
  if (text.includes(options.delimiter) || /["\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function row(values, options) {
  return values.map((v) => cell(v, options)).join(options.delimiter);
}

/**
 * @param {object} results  payload returned by runBenchmark()
 * @param {object} [options]
 * @param {string} [options.delimiter=',']  use ';' for comma-decimal locales
 * @param {boolean} [options.decimalComma=false]
 * @param {'cached'|'uncached'} [options.sortBy='cached']
 * @param {string[]} [options.recommended] labels in recommended order
 */
function toCSV(results, options = {}) {
  const opts = {
    delimiter: options.delimiter || ',',
    decimalComma: options.decimalComma ?? options.delimiter === ';',
    sortBy: options.sortBy || 'cached',
    recommended: options.recommended || [],
  };

  const servers = [...(results.servers || [])];
  const ranked = servers
    .filter((s) => s[opts.sortBy] && s[opts.sortBy].mean !== null)
    .sort((a, b) => a[opts.sortBy].mean - b[opts.sortBy].mean);
  const rankOf = new Map(ranked.map((s, i) => [s.id, i + 1]));
  servers.sort((a, b) => (rankOf.get(a.id) || 1e6) - (rankOf.get(b.id) || 1e6));

  const lines = [];
  lines.push(
    row(
      ['# ResolverBench results'],
      opts,
    ),
  );
  lines.push(
    `# generated,${new Date(results.finishedAt || Date.now()).toISOString()},corpus_domains,${results.meta.corpusSize},samples_per_resolver,${results.meta.samplesPerResolver.cached + results.meta.samplesPerResolver.uncached + results.meta.samplesPerResolver.dotcom},timeout_ms,${results.meta.timeoutMs}`,
  );
  if (opts.recommended.length > 0) {
    lines.push(`# recommended_order,${opts.recommended.map((r) => cell(r, opts)).join(' | ')}`);
  }
  lines.push(row(HEADERS, opts));

  for (const s of servers) {
    const probe = s.probes || {};
    lines.push(
      row(
        [
          rankOf.get(s.id) || '',
          s.label,
          s.operator || '',
          s.transport,
          s.endpoint,
          s.host,
          s.ip || '',
          s.pinned ? 'yes' : 'no',
          s.isSystem ? 'yes' : 'no',
          s.status,
          s.setupMs,
          s.cached?.mean,
          s.cached?.median,
          s.cached?.min,
          s.cached?.max,
          s.cached?.stdev,
          s.cached?.p95,
          s.cached?.samples,
          s.cached?.lost,
          s.uncached?.mean,
          s.uncached?.median,
          s.uncached?.min,
          s.uncached?.max,
          s.uncached?.stdev,
          s.uncached?.p95,
          s.uncached?.samples,
          s.uncached?.lost,
          s.dotcom?.mean,
          s.dotcom?.median,
          s.dotcom?.min,
          s.dotcom?.max,
          s.dotcom?.stdev,
          s.dotcom?.p95,
          s.dotcom?.samples,
          s.dotcom?.lost,
          s.reliability?.sent,
          s.reliability?.lost,
          s.reliability?.percent,
          Object.entries(s.errors || {})
            .map(([k, v]) => `${k}x${v}`)
            .join(' '),
          probe.hijack ? (probe.hijack.hijacked ? 'yes' : 'no') : '',
          probe.hijack ? (probe.hijack.addresses || []).join(' ') : '',
          probe.rebinding ? probe.rebinding.protectedCount : '',
          probe.rebinding ? probe.rebinding.ranges : '',
          probe.dnssec ? probe.dnssec.validated : '',
          probe.dnssec ? probe.dnssec.zones : '',
        ],
        opts,
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}

module.exports = { toCSV, HEADERS };
