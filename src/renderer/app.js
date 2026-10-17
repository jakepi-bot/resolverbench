'use strict';
/**
 * The window's logic.
 *
 * It talks to the benchmark only through `window.resolverbench` (see
 * preload.js). When that bridge is absent — which is how the UI is exercised in
 * a plain browser during development — a fixture-backed stand-in keeps every
 * view rendering real payloads instead of mock-ups.
 */

(function () {
  const api = window.resolverbench || fallbackBridge();

  const TRANSPORT_LABEL = { udp: 'Plain DNS', tcp: 'DNS over TCP', dot: 'DNS-over-TLS', doh: 'DNS-over-HTTPS' };
  const GROUP_ORDER = ['system', 'udp', 'tcp', 'dot', 'doh', 'custom'];

  const state = {
    info: null,
    entries: new Map(),
    order: [],
    selected: new Set(),
    custom: [],
    results: null,
    live: new Map(),
    running: false,
    planned: 0,
    done: 0,
    startedAt: 0,
    lastLogAt: 0,
    sortBy: 'cached',
    scaleMode: 'auto',
    scaleMax: 300,
  };

  const el = (id) => document.getElementById(id);
  let chart = null;

  // ------------------------------------------------------------------ init ---

  async function init() {
    wireTabs();
    chart = new window.ResolverChart(el('chart'));

    const [info, catalog, system] = await Promise.all([api.info(), api.catalog(), api.systemResolvers()]);
    state.info = info;

    for (const entry of system) {
      state.entries.set(entry.id, { ...entry, group: 'system' });
      state.selected.add(entry.id);
    }
    const defaults = new Set(catalog.defaults || []);
    for (const entry of catalog.catalog) {
      const selected = defaults.size === 0 || defaults.has(entry.id);
      state.entries.set(entry.id, { ...entry, group: entry.transport });
      if (selected) state.selected.add(entry.id);
    }
    state.order = [...state.entries.keys()];

    el('app-sub').textContent = `DNS resolver benchmark · v${info.version} · ${info.arch === 'arm64' ? 'Apple silicon' : info.arch}`;
    renderSidebar();
    renderAll();
    log(`ResolverBench ${info.version} on ${info.platform}/${info.arch} (Electron ${info.electron}, Node ${info.node})`);
    if (state.entries.size === 0) log('No resolvers found.', 'warn');

    api.onEvent(handleEvent);
    api.onMenu(handleMenu);
    window.addEventListener('resize', () => chart.resize());

    el('run').addEventListener('click', startRun);
    el('stop').addEventListener('click', stopRun);
    el('mode').addEventListener('change', () => {
      state.planned = plannedSamples();
      updateProgress();
    });
    el('sort').addEventListener('change', (event) => {
      state.sortBy = event.target.value;
      renderAll();
    });
    el('scale').addEventListener('change', (event) => {
      state.scaleMode = event.target.value;
      el('scale-max').disabled = state.scaleMode !== 'fixed';
      renderChart();
    });
    el('scale-max').addEventListener('change', (event) => {
      state.scaleMax = Number(event.target.value) || 300;
      if (state.scaleMode === 'fixed') renderChart();
    });
    el('scale-max').disabled = true;

    el('select-all').addEventListener('click', () => setSelection([...state.entries.keys()]));
    el('select-none').addEventListener('click', () => setSelection([]));
    el('select-fast').addEventListener('click', selectFastest);
    el('add').addEventListener('click', () => openAddDialog());
    el('import').addEventListener('click', openAddDialog);
    el('prune').addEventListener('click', pruneSelection);
    el('copy-results').addEventListener('click', copyResults);
    el('export-csv').addEventListener('click', async () => {
      const outcome = await api.exportCSV(state.results, {
        delimiter: el('csv-semicolon')?.checked ? ';' : ',',
      });
      report(outcome, 'CSV');
    });
    el('export-report').addEventListener('click', async () => {
      report(await api.exportReport(state.results), 'report');
    });

    updateRunButtons();
  }

  // --------------------------------------------------------------- sidebar ---

  function visibleEntries() {
    return [...state.entries.values()];
  }

  function renderSidebar() {
    const list = el('resolver-list');
    list.textContent = '';
    const groups = new Map();
    for (const entry of visibleEntries()) {
      const key = entry.group;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    for (const key of GROUP_ORDER) {
      const entries = groups.get(key);
      if (!entries || entries.length === 0) continue;
      const head = document.createElement('div');
      head.className = 'group-head';
      const title = document.createElement('span');
      title.textContent = key === 'system' ? `This Mac (${entries.length})` : `${TRANSPORT_LABEL[key] || key} (${entries.length})`;
      head.append(title);
      const toggle = document.createElement('button');
      toggle.className = 'ghost';
      toggle.textContent = entries.every((e) => state.selected.has(e.id)) ? 'none' : 'all';
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const all = entries.every((e) => state.selected.has(e.id));
        for (const entry of entries) {
          if (all) state.selected.delete(entry.id);
          else state.selected.add(entry.id);
        }
        renderSidebar();
        renderChart();
        updateRunButtons();
      });
      head.append(toggle);
      list.append(head);

      for (const entry of entries) list.append(resolverRow(entry));
    }

    el('selected-count').textContent = `${state.selected.size} selected`;
  }

  function resolverRow(entry) {
    const live = state.live.get(entry.id) || state.results?.servers.find((s) => s.id === entry.id);
    const row = document.createElement('label');
    row.className = `resolver${state.selected.has(entry.id) ? ' selected' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(entry.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(entry.id);
      else state.selected.delete(entry.id);
      renderSidebar();
      renderChart();
      updateRunButtons();
    });

    const name = document.createElement('div');
    name.className = 'name';
    const dot = document.createElement('span');
    dot.className = `dot ${statusClass(live)}`;
    name.append(dot);
    const text = document.createElement('span');
    text.textContent = entry.label;
    name.append(text);
    if (entry.group === 'system') name.append(tag('system', 'system'));
    if (entry.isCustom) name.append(tag('', 'custom'));
    const flags = flagsFor(live);
    for (const flag of flags) name.append(tag(flag.kind, flag.text));

    const metrics = document.createElement('div');
    metrics.className = 'metrics';
    if (live && live.cached && live.cached.median !== null) {
      const parts = [`${live.cached.median.toFixed(1)} ms`];
      if (live.reliability && live.reliability.lost > 0) parts.push(`${live.reliability.lost} lost`);
      metrics.textContent = parts.join(' · ');
    } else if (live && live.status === 'dead') {
      metrics.textContent = 'no reply';
    }

    const endpoint = document.createElement('div');
    endpoint.className = 'endpoint';
    endpoint.textContent = entry.url ? entry.url.replace(/^https:\/\//, '') : `${entry.host}${entry.port && entry.port !== 53 ? `:${entry.port}` : ''}`;

    row.append(checkbox, name, metrics, endpoint);
    row.title = `${entry.label}\n${endpoint.textContent}`;
    return row;
  }

  function statusClass(live) {
    if (state.running && live && live.pending > 0) return 'running';
    if (!live || !live.status) return '';
    return live.status;
  }

  function flagsFor(live) {
    const flags = [];
    if (!live || !live.probes) return flags;
    if (live.probes.hijack?.hijacked) flags.push({ kind: 'bad', text: 'hijack' });
    else if (live.probes.hijack?.noErrorWithoutAnswer) flags.push({ kind: 'warn', text: 'nodata' });
    if (live.probes.rebinding && live.probes.rebinding.protectedCount < live.probes.rebinding.ranges) {
      flags.push({ kind: 'warn', text: 'rebind' });
    }
    if (live.probes.dnssec && live.probes.dnssec.validated > 0) flags.push({ kind: '', text: 'dnssec' });
    return flags;
  }

  function tag(kind, text) {
    const span = document.createElement('span');
    span.className = `tag ${kind}`.trim();
    span.textContent = text;
    return span;
  }

  function setSelection(ids) {
    state.selected = new Set(ids);
    renderSidebar();
    renderChart();
    updateRunButtons();
  }

  function selectFastest() {
    const ranked = sortedServers().filter((s) => s.status !== 'dead' && s.cached?.mean !== null);
    if (ranked.length === 0) {
      log('Nothing measured yet — the Fastest button uses results from a completed run.', 'warn');
      return;
    }
    const keep = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2))).map((s) => s.id);
    setSelection(keep);
    log(`Selected the ${keep.length} fastest resolvers measured so far.`);
  }

  function pruneSelection() {
    const before = state.selected.size;
    for (const id of [...state.selected]) {
      const live = state.live.get(id) || state.results?.servers.find((s) => s.id === id);
      if (!live && !state.running) continue;
      if (live && (live.status === 'dead' || (live.reliability && live.reliability.lost > 0))) state.selected.delete(id);
    }
    renderSidebar();
    renderChart();
    updateRunButtons();
    log(`Pruned ${before - state.selected.size} resolver(s) that did not answer or lost queries.`);
  }

  // ------------------------------------------------------------------ dialogs --

  function openAddDialog() {
    const dialog = el('add-dialog');
    const textarea = el('add-text');
    const error = el('add-error');
    error.hidden = true;
    textarea.value = '';
    dialog.showModal();

    const confirm = el('add-confirm');
    const handler = async (event) => {
      if (event.target.value !== 'ok') {
        confirm.removeEventListener('click', handler);
        return;
      }
      event.preventDefault();
      const outcome = await api.parseResolvers(textarea.value);
      if (!outcome.ok) {
        error.textContent = outcome.error;
        error.hidden = false;
        return;
      }
      if (outcome.servers.length === 0) {
        error.textContent = 'Nothing that looks like a resolver was found.';
        error.hidden = false;
        return;
      }
      for (const entry of outcome.servers) {
        if (state.selected.has(entry.id)) continue;
        state.entries.set(entry.id, { ...entry, group: entry.transport === 'udp' ? 'custom' : entry.transport });
        state.selected.add(entry.id);
        state.custom.push(entry.id);
      }
      if (outcome.rejected?.length) {
        log(`Ignored ${outcome.rejected.length} item(s) that are not resolvers: ${outcome.rejected.slice(0, 5).join(', ')}`, 'warn');
      }
      log(`Added ${outcome.servers.length} custom resolver(s).`);
      confirm.removeEventListener('click', handler);
      dialog.close();
      renderSidebar();
      renderChart();
      updateRunButtons();
    };
    confirm.addEventListener('click', handler);
  }

  // -------------------------------------------------------------------- run ---

  function selectedServers() {
    return [...state.selected]
      .map((id) => state.entries.get(id))
      .filter(Boolean)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        operator: entry.operator,
        transport: entry.transport,
        host: entry.host,
        ip: entry.ip,
        port: entry.port,
        url: entry.url,
        sni: entry.sni,
        isSystem: !!entry.isSystem,
        isCustom: !!entry.isCustom,
      }));
  }

  function mode() {
    return el('mode').value;
  }

  function samplesForMode() {
    return { quick: 20, standard: 50, thorough: 100 }[mode()] || 50;
  }

  function plannedSamples() {
    return selectedServers().length * samplesForMode();
  }

  async function startRun() {
    if (state.running) return;
    const servers = selectedServers();
    if (servers.length === 0) {
      log('Select at least one resolver first.', 'warn');
      return;
    }
    state.running = true;
    state.live = new Map();
    state.planned = plannedSamples();
    state.done = 0;
    state.startedAt = Date.now();
    updateRunButtons();
    updateProgress();
    setStatus(`Benchmarking ${servers.length} resolver(s)…`);
    log(`Run started: ${servers.length} resolvers × ${samplesForMode()} lookups (${mode()} mode), timeout ${el('opt-timeout').value} ms`);
    renderSidebar();

    const outcome = await api.run({
      mode: mode(),
      servers,
      timeoutMs: Number(el('opt-timeout').value) || 1200,
      dnssec: el('opt-dnssec').checked,
      rebinding: el('opt-rebinding').checked,
      hijack: el('opt-hijack').checked,
    });

    state.running = false;
    updateRunButtons();

    if (!outcome.ok) {
      setStatus(`Benchmark failed: ${outcome.error}`);
      log(`Run failed: ${outcome.error}`, 'err');
      el('progress-bar').style.width = '0%';
      return;
    }
    await finishRun(outcome.results);
  }
  async function stopRun() {
    if (!state.running) return;
    log('Stop requested — keeping the samples collected so far.', 'warn');
    await api.stop();
  }

  async function finishRun(results) {
    state.results = results;
    state.live = new Map(results.servers.map((s) => [s.id, s]));
    state.done = results.servers.reduce((acc, s) => acc + s.reliability.sent, 0);
    state.planned = Math.max(state.planned, state.done);
    updateProgress();
    renderAll();
    const answered = results.servers.filter((s) => s.status !== 'dead').length;
    const fastest = sortedServers().find((s) => s.status !== 'dead');
    setStatus(
      `${results.meta.aborted ? 'Stopped early. ' : 'Done. '}${answered}/${results.servers.length} resolvers answered in ` +
        `${(results.durationMs / 1000).toFixed(1)} s${fastest ? `; fastest cached ${fastest.cached.median} ms (${fastest.label})` : ''}.`,
    );
    const findings = await api.conclusions(results);
    renderConclusions(findings);
    log(`Run finished in ${(results.durationMs / 1000).toFixed(1)} s: ${answered} of ${results.servers.length} resolvers answered.`, 'ok');
    el('status-right').textContent = `${state.done} lookups`;
  }

  function updateRunButtons() {
    el('run').disabled = state.running || state.selected.size === 0;
    el('stop').disabled = !state.running;
  }

  // ----------------------------------------------------------------- events ---

  function handleEvent(event) {
    switch (event.type) {
      case 'phase':
        setStatus(phaseText(event.phase));
        log(`phase: ${event.phase}`);
        break;
      case 'timed-start':
        // The plan is already known from the mode; do not re-derive the total
        // from the round count, because the three metrics are not sampled
        // equally (20 lookups is 8 + 6 + 6, not 3 × 8).
        log(`timing ${event.rounds} rounds per resolver`);
        break;
      case 'server':
        log(`${event.serverId}: ${event.status}${event.note ? ` (${event.note})` : ''}`, event.status === 'dead' ? 'err' : 'ok');
        break;
      case 'probe':
        if (event.probe === 'hijack') {
          const r = event.result;
          if (r.hijacked) log(`${event.serverId} redirects nonexistent names to ${r.addresses.join(', ')}`, 'warn');
          else if (r.noErrorWithoutAnswer) log(`${event.serverId} answers nonexistent names with NOERROR/NODATA rather than NXDOMAIN`, 'warn');
        }
        if (event.probe === 'rebinding') {
          const r = event.result;
          if (r.protectedCount < r.ranges) log(`${event.serverId} returned private-range addresses (${r.protectedCount}/${r.ranges} ranges filtered)`, 'warn');
        }
        if (event.probe === 'dnssec') {
          log(`${event.serverId} DNSSEC: ${event.result.validated}/${event.result.zones} signed zones authenticated`, 'ok');
        }
        break;
      case 'update':
        for (const snapshot of event.servers) state.live.set(snapshot.id, snapshot);
        state.done = event.servers.reduce(
          (acc, s) => acc + s.cached.sent + s.uncached.sent + s.dotcom.sent,
          0,
        );
        updateProgress();
        renderSidebar();
        renderChart();
        renderTable();
        maybeLogProgress();
        break;
      case 'done':
        break;
      default:
        break;
    }
  }

  function phaseText(phase) {
    return {
      connect: 'Opening connections…',
      warm: 'Warming caches (untimed)…',
      timed: 'Measuring lookups…',
      probes: 'Running characterisation probes…',
      aborted: 'Stopping…',
    }[phase] || phase;
  }

  function maybeLogProgress() {
    const now = Date.now();
    if (now - state.lastLogAt < 1000) return;
    state.lastLogAt = now;
    const live = [...state.live.values()].filter((s) => s.status === 'ok' || s.status === 'unreliable');
    const answered = live.filter((s) => s.cached.samples > 0);
    if (answered.length === 0) return;
    const best = answered.reduce((a, b) => (a.cached.median <= b.cached.median ? a : b));
    log(
      `progress: ${state.done}/${state.planned} lookups · ${answered.length} resolvers answering · best cached so far ${best.cached.median.toFixed(1)} ms (${best.label})`,
    );
  }

  function updateProgress() {
    const bar = theProgressBar();
    const completed = state.results && !state.results.meta.aborted;
    bar.style.width = completed
      ? '100%'
      : `${Math.min(100, state.planned ? (100 * state.done) / state.planned : 0)}%`;
    el('status-right').textContent = state.planned
      ? `${state.done}/${state.planned} lookups${state.running ? ` · ${((Date.now() - state.startedAt) / 1000).toFixed(0)} s` : ''}`
      : '';
    if (state.running) setStatus(`${phaseOrRun()} · ${state.done}/${state.planned} lookups`);
  }

  const theProgressBar = () => el('progress-bar');
  const phaseOrRun = () => 'Benchmarking';

  function setStatus(text) {
    el('status').textContent = text;
  }

  function log(text, kind = '') {
    const line = document.createElement('div');
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = `${new Date().toLocaleTimeString()}  `;
    const body = document.createElement('span');
    body.className = kind;
    body.textContent = text;
    line.append(time, body);
    const pane = el('log');
    pane.append(line);
    while (pane.childElementCount > 800) pane.firstElementChild.remove();
    pane.scrollTop = pane.scrollHeight;
  }

  function report(outcome, what) {
    if (outcome?.ok) log(`Saved ${what} to ${outcome.path}`, 'ok');
    else if (!outcome?.canceled) log(`Could not save ${what}: ${outcome?.error || 'unknown error'}`, 'err');
  }

  // --------------------------------------------------------------- rendering ---

  function sortedServers() {
    const servers = state.results
      ? state.results.servers
      : [...state.live.values()].map((snapshot) => {
          const entry = state.entries.get(snapshot.id) || {};
          return { ...snapshot, transport: entry.transport, endpoint: entry.label, isSystem: entry.isSystem, operator: entry.operator };
        });
    const metric = state.sortBy;
    return [...servers].sort((a, b) => {
      if (metric === 'label') return a.label.localeCompare(b.label);
      const av = a[metric]?.mean;
      const bv = b[metric]?.mean;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av - bv;
    });
  }

  function renderAll() {
    renderChart();
    renderTable();
    if (!state.results) el('conclusions').innerHTML = '<p class="empty">Run a benchmark to see what the numbers mean.</p>';
  }

  function renderChart() {
    if (!chart) return;
    chart.setData({
      servers: sortedServers().map((s) => ({
        id: s.id,
        label: s.label,
        transport: s.transport,
        endpoint: s.endpoint,
        isSystem: s.isSystem,
        status: s.status,
        cached: s.cached,
        uncached: s.uncached,
        dotcom: s.dotcom,
        reliability: s.reliability,
        probes: s.probes,
      })),
      scaleMode: state.scaleMode,
      scaleMax: state.scaleMax,
    });
    chart.resize();
  }

  const COLUMNS = [
    { key: 'rank', label: '#', align: 'left' },
    { key: 'label', label: 'Resolver', align: 'left' },
    { key: 'transport', label: 'Transport', align: 'left' },
    { key: 'endpoint', label: 'Endpoint', align: 'left' },
    { key: 'cached_median', label: 'Cached med', align: 'right' },
    { key: 'cached_mean', label: 'Cached avg', align: 'right' },
    { key: 'cached_stdev', label: 'σ', align: 'right' },
    { key: 'uncached_median', label: 'Uncached med', align: 'right' },
    { key: 'dotcom_median', label: '.com med', align: 'right' },
    { key: 'setupMs', label: 'Setup', align: 'right' },
    { key: 'reliability', label: 'Answered', align: 'right' },
    { key: 'samples', label: 'Samples', align: 'right' },
    { key: 'flags', label: 'Flags', align: 'left' },
  ];

  function renderTable() {
    const servers = sortedServers();
    const table = el('results-table');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    thead.textContent = '';
    tbody.textContent = '';

    const headRow = document.createElement('tr');
    for (const column of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = column.label;
      if (column.align === 'left') th.classList.add('flags');
      headRow.append(th);
    }
    thead.append(headRow);

    servers.forEach((server, index) => {
      const tr = document.createElement('tr');
      if (server.status === 'dead') tr.className = 'dead';
      const cells = [
        index + 1,
        server.label,
        server.transport === 'doh' ? 'DoH' : server.transport === 'dot' ? 'DoT' : server.transport === 'tcp' ? 'TCP' : 'Plain',
        server.endpoint || '',
        num(server.cached?.median),
        num(server.cached?.mean),
        num(server.cached?.stdev),
        num(server.uncached?.median),
        num(server.dotcom?.median),
        server.setupMs === null || server.setupMs === undefined ? '—' : server.setupMs.toFixed(0),
        server.reliability ? `${server.reliability.percent}%` : '—',
        server.cached ? server.cached.samples + server.cached.lost : '—',
        flagText(server),
      ];
      cells.forEach((value, columnIndex) => {
        const td = document.createElement('td');
        td.textContent = String(value);
        if (columnIndex === 4) td.classList.add('strong');
        tr.append(td);
      });
      tbody.append(tr);
    });
  }

  function num(value) {
    if (value === null || value === undefined) return '—';
    return value.toFixed(1);
  }

  function flagText(server) {
    const parts = [];
    if (server.isSystem) parts.push('system');
    if (server.status === 'dead') parts.push('no reply');
    if (server.reliability?.lost > 0) parts.push(`${server.reliability.lost} lost`);
    if (server.probes?.hijack?.hijacked) parts.push('hijacks NXDOMAIN');
    else if (server.probes?.hijack?.noErrorWithoutAnswer) parts.push('NODATA not NXDOMAIN');
    if (server.probes?.rebinding) {
      parts.push(`rebinding ${server.probes.rebinding.protectedCount}/${server.probes.rebinding.ranges}`);
    }
    if (server.probes?.dnssec) parts.push(`dnssec ${server.probes.dnssec.validated}/${server.probes.dnssec.zones}`);
    if (server.errors && Object.keys(server.errors).length > 0) {
      parts.push(Object.entries(server.errors).map(([k, v]) => `${v}× ${k}`).join(', '));
    }
    return parts.join(' · ');
  }

  function renderConclusions(findings) {
    const pane = el('conclusions');
    pane.textContent = '';
    if (!findings || findings.length === 0) {
      pane.innerHTML = '<p class="empty">No conclusions — run a benchmark first.</p>';
      return;
    }
    for (const finding of findings) {
      const p = document.createElement('p');
      p.className = finding.severity;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = { bad: 'Problem', warn: 'Worth knowing', good: 'Good', info: 'Detail' }[finding.severity] || finding.severity;
      p.append(label, document.createTextNode(finding.text));
      pane.append(p);
    }
  }

  async function copyResults() {
    if (!state.results) {
      log('Nothing to copy yet.', 'warn');
      return;
    }
    const lines = [`ResolverBench ${state.info.version} — ${new Date(state.results.finishedAt).toISOString()}`, ''];
    lines.push(['#', 'resolver', 'transport', 'endpoint', 'cached med', 'uncached med', '.com med', 'setup', 'answered', 'flags'].join('\t'));
    sortedServers().forEach((s, index) => {
      lines.push(
        [
          index + 1,
          s.label,
          s.transport,
          s.endpoint,
          num(s.cached?.median),
          num(s.uncached?.median),
          num(s.dotcom?.median),
          s.setupMs === null || s.setupMs === undefined ? '—' : s.setupMs.toFixed(0),
          `${s.reliability?.percent ?? '—'}%`,
          flagText(s),
        ].join('\t'),
      );
    });
    const outcome = await api.copy(lines.join('\n'));
    log(outcome?.ok ? 'Copied the measured values to the clipboard.' : 'Could not copy to the clipboard.', outcome?.ok ? 'ok' : 'err');
  }

  // ------------------------------------------------------------------- tabs ---

  function wireTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    }
  }

  function showTab(name) {
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('active', pane.id === `pane-${name}`);
    if (name === 'chart') requestAnimationFrame(() => chart.resize());
  }

  function handleMenu(payload) {
    if (!payload) return;
    if (payload.action === 'run') startRun();
    if (payload.action === 'stop') stopRun();
    if (payload.action === 'export-csv') el('export-csv').click();
    if (payload.action === 'export-report') el('export-report').click();
    if (payload.action === 'tab') showTab(payload.tab);
  }

  // ---------------------------------------------------------------- self-test -

  /**
   * Driven by `--selftest-ui` in the main process: runs one small benchmark
   * through the real IPC path, then reports what the window actually rendered.
   * It exists so the app can be checked end to end with nobody watching —
   * including on a build machine, where "it launched" is not evidence.
   */
  window.__selftest = async function selftest(ids) {
    const wanted =
      typeof ids === 'string' && ids
        ? ids.split(',').map((s) => s.trim())
        : ['cloudflare', 'cloudflare-dot', 'cloudflare-doh'];
    const available = wanted.filter((id) => state.entries.has(id));
    if (available.length === 0) return { ok: false, error: 'none of the requested resolvers are in the catalog' };

    el('mode').value = 'quick';
    setSelection(available);
    const before = canvasInk();
    await startRun();
    const after = canvasInk();
    const results = state.results;

    return {
      ok: !!results && results.servers.length === available.length,
      selected: available,
      running: state.running,
      status: el('status').textContent,
      progress: el('progress-bar').style.width,
      canvas: { inkBefore: before, inkAfter: after, drewSomething: after > before },
      sidebarRows: document.querySelectorAll('.resolver').length,
      tableRows: document.querySelectorAll('#results-table tbody tr').length,
      conclusionCount: document.querySelectorAll('#conclusions p').length,
      logLines: document.querySelectorAll('#log div').length,
      servers: (results?.servers || []).map((s) => ({
        label: s.label,
        transport: s.transport,
        status: s.status,
        cachedMedian: s.cached.median,
        uncachedMedian: s.uncached.median,
        dotcomMedian: s.dotcom.median,
        setupMs: s.setupMs,
        reliability: s.reliability.percent,
        hijacked: !!s.probes.hijack?.hijacked,
        nxdomain: s.probes.hijack?.rcode ?? null,
        protectedRanges: s.probes.rebinding?.protectedCount ?? null,
      })),
    };
  };

  /** Non-transparent pixels on the chart canvas: proof something was drawn. */
  function canvasInk() {
    const canvas = el('chart');
    if (!canvas || !canvas.width) return 0;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink += 1;
    return ink;
  }

  // ----------------------------------------------------------------- fixture --
  /**
   * Stand-in bridge used when the page runs outside Electron (browser-based UI
   * checks). It replays a captured fixture, including the live event stream, so
   * the same code paths render as they do in the app.
   */
  function fallbackBridge() {
    const fixture = window.__RESOLVERBENCH_FIXTURE__ || {};
    let emit = () => {};
    return {
      info: async () =>
        fixture.info || {
          name: 'ResolverBench',
          version: '0.0.0',
          electron: 'n/a',
          chrome: 'n/a',
          node: 'n/a',
          platform: 'browser',
          arch: 'n/a',
          projectUrl: '',
        },
      catalog: async () => ({ catalog: fixture.catalog || [], defaults: (fixture.catalog || []).map((e) => e.id) }),
      systemResolvers: async () => fixture.system || [],
      parseResolvers: async (text) => {
        const servers = text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line, index) => ({
            id: `fixture-${index}`,
            label: line,
            transport: /^https:/.test(line) ? 'doh' : /^tls:/.test(line) ? 'dot' : 'udp',
            host: line,
            port: 53,
            url: /^https:/.test(line) ? line : null,
            isCustom: true,
          }));
        return { ok: true, servers, rejected: [] };
      },
      run: async () => {
        for (const event of fixture.events || []) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 4));
          emit(event);
        }
        return fixture.results ? { ok: true, results: fixture.results } : { ok: false, error: 'no fixture loaded' };
      },
      stop: async () => ({ ok: true }),
      isRunning: async () => false,
      onEvent: (handler) => {
        emit = handler;
        return () => {};
      },
      onMenu: () => () => {},
      conclusions: async () => fixture.findings || [],
      exportCSV: async () => ({ ok: false, error: 'not available in a browser' }),
      exportJSON: async () => ({ ok: false, error: 'not available in a browser' }),
      exportReport: async () => ({ ok: false, error: 'not available in a browser' }),
      copy: async () => ({ ok: true }),
      open: async () => ({ ok: true }),
    };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
