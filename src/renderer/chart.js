'use strict';
/**
 * The response-time bar chart.
 *
 * One row per resolver, three horizontal bars per row — cached, uncached and
 * .com referral — which is the layout GRC's benchmark uses and the reason its
 * chart reads at a glance: you can see a resolver that is fast from cache but
 * slow to the authoritative servers without reading a single number.
 *
 * Everything is drawn on one canvas with device-pixel scaling, so it stays
 * crisp on a Retina display, and `rowAt` lets the caller put up the exact-value
 * inspector under the pointer.
 */

(function (global) {
  const ROW_HEIGHT = 30;
  const BAR_HEIGHT = 7;
  const BAR_GAP = 2;
  const GUTTER = 200;
  const RIGHT_PAD = 64;
  const TOP_PAD = 26;
  const BOTTOM_PAD = 30;

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return value && value.trim() ? value.trim() : fallback;
  }

  function niceStep(max) {
    const candidates = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
    for (const candidate of candidates) {
      if (max / candidate <= 8) return candidate;
    }
    return 1000;
  }

  function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return `${text.slice(0, Math.max(1, low))}…`;
  }

  function fmt(value) {
    if (value === null || value === undefined) return '—';
    return value >= 100 ? value.toFixed(0) : value.toFixed(1);
  }

  class ResolverChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.servers = [];
      this.scaleMode = 'auto';
      this.scaleMax = 300;
      this.hover = null;
      this.selectedId = null;
      this.rows = [];
      this.geometry = null;
      canvas.addEventListener('mousemove', (event) => {
        const rect = canvas.getBoundingClientRect();
        const hit = this.rowAt(event.clientY - rect.top, event.clientX - rect.left);
        this.hover = hit ? hit.index : null;
        this.draw();
      });
      canvas.addEventListener('mouseleave', () => {
        this.hover = null;
        this.draw();
      });
    }

    setData({ servers, scaleMode, scaleMax }) {
      this.servers = servers || [];
      if (scaleMode) this.scaleMode = scaleMode;
      if (scaleMax) this.scaleMax = scaleMax;
      this.draw();
    }

    /** Effective full-scale value in milliseconds. */
    effectiveMax() {
      const values = [];
      for (const s of this.servers) {
        for (const metric of ['cached', 'uncached', 'dotcom']) {
          const stat = s[metric];
          if (!stat) continue;
          const value = stat.mean ?? stat.median;
          if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
        }
      }
      if (values.length === 0) return this.scaleMode === 'fixed' ? this.scaleMax : 100;
      const auto = Math.max(...values) * 1.08;
      if (this.scaleMode === 'fixed') return Math.max(this.scaleMax, 1);
      const step = niceStep(auto);
      return Math.max(step, Math.ceil(auto / step) * step);
    }

    resize() {
      const width = this.canvas.parentElement.clientWidth - 24;
      const rows = Math.max(this.servers.length, 1);
      const height = TOP_PAD + rows * ROW_HEIGHT + BOTTOM_PAD;
      const dpr = global.devicePixelRatio || 1;
      this.canvas.width = Math.max(320, Math.floor(width * dpr));
      this.canvas.height = Math.floor(height * dpr);
      this.canvas.style.height = `${height}px`;
      this.geometry = { width: Math.max(320, width), height, dpr };
      this.draw();
    }

    draw() {
      const ctx = this.ctx;
      if (!this.geometry || this.canvas.width === 0) this.resize();
      const { width, height, dpr } = this.geometry;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const colors = {
        cached: cssVar('--cached', '#e5484d'),
        uncached: cssVar('--uncached', '#30a46c'),
        dotcom: cssVar('--dotcom', '#8e4ec6'),
        text: cssVar('--text', '#e6e8ec'),
        dim: cssVar('--text-dim', '#a4abb8'),
        faint: cssVar('--text-faint', '#757d8c'),
        border: cssVar('--border', '#31363f'),
        hover: cssVar('--bg-hover', '#2a2f38'),
        bad: cssVar('--bad', '#ef5b5b'),
        accent: cssVar('--accent', '#4c8dff'),
      };

      const max = this.effectiveMax();
      const plotX = GUTTER;
      const plotWidth = Math.max(60, width - GUTTER - RIGHT_PAD);

      // axis
      const step = niceStep(max);
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'alphabetic';
      for (let value = 0; value <= max + 0.001; value += step) {
        const x = plotX + (value / max) * plotWidth;
        ctx.strokeStyle = value === 0 ? colors.border : colors.border;
        ctx.globalAlpha = value === 0 ? 1 : 0.4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_PAD - 6);
        ctx.lineTo(Math.round(x) + 0.5, height - BOTTOM_PAD + 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors.faint;
        ctx.textAlign = 'center';
        ctx.fillText(`${value}`, x, height - BOTTOM_PAD + 16);
      }
      ctx.fillStyle = colors.faint;
      ctx.textAlign = 'left';
      ctx.fillText('milliseconds', plotX, TOP_PAD - 12);

      if (this.servers.length === 0) {
        ctx.fillStyle = colors.faint;
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('No results yet — pick resolvers and press Run Benchmark.', plotX, TOP_PAD + 20);
        this.rows = [];
        return;
      }

      this.rows = [];
      this.servers.forEach((server, index) => {
        const top = TOP_PAD + index * ROW_HEIGHT;
        const isHover = this.hover === index;
        const dead = server.status === 'dead';

        if (isHover) {
          ctx.fillStyle = colors.hover;
          ctx.fillRect(0, top, width, ROW_HEIGHT);
        }

        // label block
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = dead ? colors.bad : colors.text;
        const badge = server.isSystem ? ' ●' : '';
        const label = truncate(ctx, `${server.label}${badge}`, GUTTER - 46);
        ctx.fillText(label, 8, top + 13);

        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = colors.faint;
        ctx.fillText(server.transport === 'doh' ? 'DoH' : server.transport === 'dot' ? 'DoT' : 'DNS', 4, top + 25);
        ctx.fillText(truncate(ctx, server.endpoint || '', GUTTER - 46), 32, top + 25);

        if (dead) {
          ctx.fillStyle = colors.faint;
          ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText('no reply — not benchmarked', plotX + 4, top + 16);
          this.rows.push({ index, top, bars: [] });
          return;
        }

        const bars = [];
        const metrics = [
          ['cached', colors.cached],
          ['uncached', colors.uncached],
          ['dotcom', colors.dotcom],
        ];
        metrics.forEach(([metric, color], metricIndex) => {
          const stat = server[metric] || {};
          const value = stat.mean ?? stat.median;
          const y = top + 5 + metricIndex * (BAR_HEIGHT + BAR_GAP);
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            ctx.fillStyle = colors.faint;
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText('—', plotX + 2, y + BAR_HEIGHT - 1);
            bars.push({ metric, y, x: plotX, width: 0, value: null });
            return;
          }
          const barWidth = Math.max(1.5, (Math.min(value, max) / max) * plotWidth);
          ctx.fillStyle = color;
          ctx.fillRect(plotX, y, barWidth, BAR_HEIGHT);

          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = colors.dim;
          const text = fmt(value);
          const textX = plotX + barWidth + 4 + ctx.measureText(text).width < width - 4
            ? plotX + barWidth + 4
            : plotX + Math.max(0, barWidth - ctx.measureText(text).width - 6);
          ctx.fillText(text, textX, y + BAR_HEIGHT - 1);

          bars.push({ metric, y, x: plotX, width: barWidth, value });
        });

        // reliability marker: a resolver that lost queries gets a count on the right
        const lost = server.reliability?.lost ?? 0;
        if (lost > 0) {
          ctx.fillStyle = colors.bad;
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`${lost} lost`, width - 6, top + 13);
          ctx.textAlign = 'left';
        }

        this.rows.push({ index, top, bars });
      });
    }

    /** @returns {{index:number, metric:string|null}|null} */
    rowAt(y, x) {
      if (!this.geometry) return null;
      const index = Math.floor((y - TOP_PAD) / ROW_HEIGHT);
      if (index < 0 || index >= this.rows.length) return null;
      const row = this.rows[index];
      if (!row) return null;
      if (x !== undefined) {
        const hit = row.bars.find((bar) => {
          if (x < bar.x - 2 || x > bar.x + bar.width + 40) return false;
          return y >= row.top + (bar.y - row.top) - 2 && y <= row.top + (bar.y - row.top) + BAR_HEIGHT + 2;
        });
        if (hit) return { index, metric: hit.metric };
      }
      return { index, metric: null };
    }
  }

  global.ResolverChart = ResolverChart;
})(window);
