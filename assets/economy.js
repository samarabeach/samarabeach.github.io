// Economic Chart Portfolio. Charts and helpers come from Smardash's Economy page
// (github.com/samarabeach/smardash). Here the data is a saved copy in
// data/economy.json, refreshed by scripts/update_economy_data.py.

// Tiny data store the page scripts share: datasets, computed datasets,
// page parameters and redraw notifications.
window.dash = (() => {
  const store = new Map();   // id -> { status, data, error }
  const calcs = new Map();   // id -> { inputs, fn }
  const listeners = [];
  const DEFAULTS = { freq: 'monthly', range: '10y', cpi_measure: 'yoy', ind_range: '5y' };
  const PKEY = 'smardash-params';
  let params = { ...DEFAULTS };
  try { Object.assign(params, JSON.parse(localStorage.getItem(PKEY) || '{}')); } catch (e) { /* ignore */ }
  const KEEP = ['freq', 'range', 'cpi_measure', 'ind_range', 'rel_daily'];

  const colors = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'var(--series-' + i + ')');

  function data(id) {
    if (calcs.has(id)) return computed(id);
    return store.get(id) || { status: 'loading', data: null };
  }
  const memo = new Map(); // id -> { stamp, result }
  let stamp = 0;
  function computed(id) {
    const m = memo.get(id);
    if (m && m.stamp === stamp) return m.result;
    const c = calcs.get(id);
    const ins = c.inputs.map(data);
    let result;
    if (ins.some((d) => d.status === 'error')) result = { status: 'error', data: null };
    else if (ins.some((d) => d.status !== 'ok')) result = { status: 'loading', data: null };
    else {
      try { result = { status: 'ok', data: c.fn(...ins.map((d) => d.data)) }; }
      catch (e) { console.error('calc ' + id, e); result = { status: 'error', data: null, error: String(e) }; }
    }
    memo.set(id, { stamp, result });
    return result;
  }

  let queued = false;
  function notify() {
    stamp++;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } }
    });
  }

  return {
    colors,
    data,
    calc(id, spec) { calcs.set(id, spec); },
    onData(fn) { listeners.push(fn); },
    params() { return params; },
    setParams(p) {
      for (const [k, v] of Object.entries(p)) { if (v == null) delete params[k]; else params[k] = v; }
      try { localStorage.setItem(PKEY, JSON.stringify(Object.fromEntries(KEEP.filter((k) => k in params).map((k) => [k, params[k]])))); } catch (e) { /* ignore */ }
      notify();
    },
    setLink(page) { try { history.replaceState(null, '', '#' + page); } catch (e) { /* ignore */ } },
    _set(id, rows) { store.set(id, { status: 'ok', data: rows }); stamp++; },
    _fail(id, msg) { store.set(id, { status: 'error', data: null, error: msg }); stamp++; },
    _notify: notify,
  };
})();

/* ---------- tabs and headline ---------- */
(() => {
  const PAGES = ['national', 'maps', 'indicators'];
  const tabs = [...document.querySelectorAll('.ec-tab')];
  window.EC_PAGE = 'national';
  const show = (page) => {
    page = PAGES.includes(page) ? page : 'national';
    window.EC_PAGE = page;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.page === page)));
    document.querySelectorAll('#economy .ec-page').forEach((p) => { p.hidden = p.id !== page; });
    dash.setLink(page);
    if (window.EC_DRAW && window.EC_DRAW[page]) window.EC_DRAW[page]();
  };
  window.EC_SHOW = show;
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.page)));
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES.includes(h) && h !== window.EC_PAGE) show(h); });

  document.querySelectorAll('.ec-seg[data-param]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      dash.setParams({ [seg.dataset.param]: b.dataset.v });
    });
  });

  const tileTone = { cpi: 'up-bad', core: 'up-bad', gdp: 'up-good', u3: 'up-bad' };
  dash.onData(() => {
    const p = dash.params();
    document.querySelectorAll('.ec-seg[data-param]').forEach((seg) => {
      const cur = p[seg.dataset.param];
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
    });
    const h = dash.data('headline');
    const marks = document.querySelectorAll('[data-source="headline"]');
    if (h.status !== 'ok') {
      marks.forEach((m) => { m.textContent = '—'; m.classList.toggle('dash-skeleton', h.status === 'loading'); });
      return;
    }
    const by = new Map(h.data.map((r) => [r.metric, r]));
    marks.forEach((m) => {
      m.classList.remove('dash-skeleton');
      const metric = m.dataset.where.split('=')[1], field = m.dataset.field, r = by.get(metric);
      if (!r) { m.textContent = '—'; return; }
      if (field === 'value') m.textContent = EC.fmt1(r.value);
      else if (field === 'change') {
        m.textContent = EC.sgn1(r.change);
        const up = r.change > 0, down = r.change < 0, goodUp = tileTone[metric] === 'up-good';
        m.classList.toggle('good', (up && goodUp) || (down && !goodUp));
        m.classList.toggle('bad', (up && !goodUp) || (down && goodUp));
      } else m.textContent = r[field];
    });
  });

  setTimeout(() => show(location.hash.slice(1)), 0);
})();

/* ---------- computed values readers can inspect ---------- */
dash.calc('headline', {
  title: 'Latest headline readings',
  description: 'Latest value of each headline series, the reading before it, and the change, each rounded to one decimal.',
  inputs: ['cpi_monthly', 'gdp_contrib', 'unemp_monthly'],
  fn: (cpi_monthly, gdp_contrib, unemp_monthly) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = (date, quarterly) => {
      const y = date.slice(0, 4), m = +date.slice(5, 7);
      return quarterly ? 'Q' + Math.ceil(m / 3) + ' ' + y : months[m - 1] + ' ' + y;
    };
    const round = (x) => Math.round(x * 10) / 10;
    const pick = (rows, column, metric, quarterly) => {
      const have = rows.filter((r) => r[column] != null);
      const now = have[have.length - 1], before = have[have.length - 2];
      return {
        metric, period: now.date, period_label: label(now.date, quarterly),
        value: round(now[column]), prior_period: before.date, prior: round(before[column]),
        change: round(round(now[column]) - round(before[column])),
      };
    };
    return [
      pick(cpi_monthly, 'cpi_yoy', 'cpi', false),
      pick(cpi_monthly, 'core_yoy', 'core', false),
      pick(gdp_contrib, 'gdp', 'gdp', true),
      pick(unemp_monthly, 'u3', 'u3', false),
    ];
  },
});

dash.calc('metro_change', {
  title: 'Metro rate, 12-month change',
  description: 'Each metro area\'s unemployment rate minus its rate in the same month a year earlier, in percentage points, rounded to one decimal.',
  inputs: ['metro_unemp'],
  fn: (metro_unemp) => {
    const rate = new Map(metro_unemp.map((r) => [r.code + '|' + r.date, r.rate]));
    return metro_unemp.filter((r) => r.rate != null).map((r) => {
      const before = rate.get(r.code + '|' + (+r.date.slice(0, 4) - 1) + r.date.slice(4));
      return { code: r.code, date: r.date, change_12m: before == null ? null : Math.round((r.rate - before) * 10) / 10 };
    });
  },
});

dash.calc('state_change', {
  title: 'State rate, 12-month change',
  description: 'Each state\'s unemployment rate minus its rate in the same month a year earlier, in percentage points, rounded to one decimal.',
  inputs: ['state_unemp'],
  fn: (state_unemp) => {
    const rate = new Map(state_unemp.map((r) => [r.fips + '|' + r.date, r.rate]));
    return state_unemp.filter((r) => r.rate != null).map((r) => {
      const before = rate.get(r.fips + '|' + (+r.date.slice(0, 4) - 1) + r.date.slice(4));
      return { fips: r.fips, date: r.date, change_12m: before == null ? null : Math.round((r.rate - before) * 10) / 10 };
    });
  },
});

/* ---------- shared helpers ---------- */
window.EC = (() => {
  const fmt1 = d3.format('.1f'), sgn1 = d3.format('+.1f');
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const mLabel = d3.utcFormat('%b %Y');
  const qLabel = (d) => 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
  const ok = (id) => dash.data(id).status === 'ok';
  const rows = (id) => (ok(id) ? dash.data(id).data : []);

  // resolve a CSS color (token) to rgb for interpolation
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.getElementById('economy').appendChild(probe);
  const resolve = (c) => { probe.style.color = c; return getComputedStyle(probe).color; };

  function stateOf(ids) {
    const st = ids.map((id) => dash.data(id).status);
    if (st.includes('error') || st.includes('connect') || st.includes('declined') || st.includes('missing')) return 'error';
    if (st.every((s) => s === 'ok')) return 'ok';
    return 'loading';
  }
  function placeholder(el, state) {
    el.replaceChildren();
    el.classList.toggle('dash-skeleton', state === 'loading');
    if (state === 'error') {
      const f = document.createElement('div'); f.className = 'ec-fail'; f.textContent = 'Failed to load'; el.appendChild(f);
    }
  }
  function tooltip(card) {
    let tt = card.querySelector(':scope > .ec-tt');
    if (!tt) { tt = document.createElement('div'); tt.className = 'ec-tt'; card.appendChild(tt); }
    return {
      show(event, title, lines) {
        tt.replaceChildren();
        const t = document.createElement('div'); t.className = 't'; t.textContent = title; tt.appendChild(t);
        for (const l of lines) {
          const r = document.createElement('div'); r.className = 'r';
          const left = document.createElement('span');
          if (l.color) { const i = document.createElement('i'); i.style.background = l.color; left.appendChild(i); left.append(' '); }
          left.append(l.name);
          const v = document.createElement('span'); v.textContent = l.value;
          r.append(left, v); tt.appendChild(r);
        }
        tt.style.display = 'block';
        const cr = card.getBoundingClientRect();
        let x = event.clientX - cr.left + 14, y = event.clientY - cr.top + 14;
        const w = tt.offsetWidth, h = tt.offsetHeight;
        if (x + w > cr.width - 6) x = event.clientX - cr.left - w - 14;
        if (x < 6) x = 6;
        if (y + h > cr.height - 6) y = event.clientY - cr.top - h - 14;
        tt.style.left = x + 'px'; tt.style.top = y + 'px';
      },
      hide() { tt.style.display = 'none'; },
    };
  }
  function legend(el, items) {
    el.replaceChildren(...items.map((it) => {
      const s = document.createElement('span');
      const i = document.createElement('i'); i.style.background = it.color;
      if (it.round) i.style.borderRadius = '50%';
      s.append(i, it.name); return s;
    }));
  }
  function textWidth(svg, strings, cls) {
    const g = svg.append('g').attr('class', 'tick');
    let w = 0;
    for (const s of strings) {
      const t = g.append('text').attr('class', cls || 'lbl').text(s);
      w = Math.max(w, t.node().getComputedTextLength());
    }
    g.remove(); return w;
  }
  function cutoff(lastDate, range) {
    if (range === 'all') return parse('2000-01-01');
    const yrs = range === '10y' ? 10 : 5;
    const d = new Date(lastDate); d.setUTCFullYear(d.getUTCFullYear() - yrs); return d;
  }

  /* Line chart: data rows {date: Date, [key]: number|null}; series [{key,name,color}] */
  function lineChart(el, card, data, series, opt) {
    el.replaceChildren(); el.classList.remove('dash-skeleton');
    const W = Math.max(280, el.clientWidth), H = 280;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img');
    const vals = data.flatMap((d) => series.map((s) => d[s.key])).filter((v) => v != null);
    let lo = d3.min(vals), hi = d3.max(vals);
    if (opt.zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    const y = d3.scaleLinear([lo, hi], [H - 28, 12]).nice();
    const yTicks = y.ticks(5);
    const yf = (v) => d3.format(Number.isInteger(yTicks[1] - yTicks[0]) ? 'd' : '.1f')(v) + '%';
    const last = series.map((s) => { const r = [...data].reverse().find((d) => d[s.key] != null); return r ? { s, d: r } : null; }).filter(Boolean);
    const endText = last.map((l) => l.s.name + ' ' + fmt1(l.d[l.s.key]) + '%');
    const ml = textWidth(svg, yTicks.map(yf)) + 10;
    const mr = (W < 420 ? 6 : textWidth(svg, endText, 'end') + 14);
    const x = d3.scaleUtc(d3.extent(data, (d) => d.date), [ml, W - mr]);
    // grid + y axis
    svg.append('g').attr('class', 'tick-y').attr('transform', `translate(${ml},0)`)
      .call(d3.axisLeft(y).tickValues(yTicks).tickSize(-(W - ml - mr)).tickFormat(yf).tickPadding(8))
      .attr('font-size', null).attr('font-family', null)
      .call((g) => g.selectAll('.tick line').style('stroke', 'var(--cds-chart-grid)'));
    if (y.domain()[0] < 0 && y.domain()[1] > 0)
      svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(0)).attr('y2', y(0)).style('stroke', 'var(--cds-chart-axis)');
    const nx = Math.max(2, Math.floor((W - ml - mr) / 80));
    svg.append('g').attr('transform', `translate(0,${H - 28})`)
      .call(d3.axisBottom(x).ticks(nx).tickSizeOuter(0).tickSize(0).tickPadding(10).tickFormat(d3.utcFormat('%Y')))
      .attr('font-size', null).attr('font-family', null);
    svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', H - 28).attr('y2', H - 28).style('stroke', 'var(--cds-chart-axis)');
    if (opt.marker) {
      svg.append('line').attr('x1', x(opt.marker)).attr('x2', x(opt.marker)).attr('y1', 12).attr('y2', H - 28)
        .style('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 3');
    }
    shade(svg, timeShade(x), 12, H - 28);
    const g = svg.append('g').attr('class', opt.animate ? 'ec-fade' : null);
    for (const s of series) {
      g.append('path').datum(data).style('fill', 'none').style('stroke', s.color).attr('stroke-width', s.width || 2)
        .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
        .attr('d', d3.line().defined((d) => d[s.key] != null).x((d) => x(d.date)).y((d) => y(d[s.key])));
    }
    // end labels, dodged apart
    if (W >= 420) {
      const labs = last.map((l, i) => ({ y: y(l.d[l.s.key]), x: x(l.d.date), text: endText[i], color: l.s.color })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 14) labs[i].y = labs[i - 1].y + 14;
      for (const l of labs) {
        svg.append('text').attr('class', 'end').attr('x', W - mr + 6).attr('y', l.y).attr('dy', '0.35em').style('fill', l.color).text(l.text);
      }
    }
    // hover
    const tip = tooltip(card);
    const rule = svg.append('line').attr('y1', 12).attr('y2', H - 28).style('stroke', 'var(--cds-chart-axis)').style('display', 'none');
    const dots = series.map((s) => svg.append('circle').attr('r', 3.5).style('fill', s.color).style('display', 'none'));
    const bis = d3.bisector((d) => d.date).center;
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', H - 28).style('fill', 'transparent')
      .on('pointermove', (event) => {
        const [px] = d3.pointer(event); const d = data[bis(data, x.invert(px))]; if (!d) return;
        rule.style('display', null).attr('x1', x(d.date)).attr('x2', x(d.date));
        series.forEach((s, i) => { if (d[s.key] == null) dots[i].style('display', 'none'); else dots[i].style('display', null).attr('cx', x(d.date)).attr('cy', y(d[s.key])); });
        tip.show(event, opt.dateLabel(d.date), series.map((s) => ({ color: series.length > 1 ? s.color : null, name: s.name, value: d[s.key] == null ? 'not published' : fmt1(d[s.key]) + '%' })));
      })
      .on('pointerleave', () => { rule.style('display', 'none'); dots.forEach((c) => c.style('display', 'none')); tip.hide(); });
  }

  /* Shaded periods (recessions in gray, personal periods in the accent color) behind a time chart.
     toX(start, end) returns [x0, x1] in pixels, or null when the period is out of view. */
  function shadeSpans() {
    const d = dash.data('shading');
    return d.status === 'ok' ? d.data.map((p) => ({ ...p, s: parse(p.start), e: parse(p.end) })) : [];
  }
  function shade(svg, toX, y0, y1, opts = {}) {
    const g = svg.append('g').attr('class', 'ec-shade').attr('aria-hidden', 'true');
    for (const p of shadeSpans()) {
      const r = toX(p.s, p.e);
      if (!r || r[1] - r[0] < 0.5) continue;
      const personal = p.kind !== 'recession';
      g.append('rect').attr('x', r[0]).attr('y', y0).attr('width', r[1] - r[0]).attr('height', y1 - y0)
        .style('fill', personal ? dash.colors[0] : 'var(--color-fg)').style('opacity', personal ? 0.13 : 0.08);
      if (personal && opts.label !== false && r[1] - r[0] > 60)
        g.append('text').attr('class', 'lbl ec-shade-lbl').attr('x', r[0] + 4).attr('y', y0 + 11).style('fill', dash.colors[0]).text(p.label);
    }
    return g;
  }
  const timeShade = (x) => (s, e) => {
    const [d0, d1] = x.domain(), a = Math.max(+s, +d0), b = Math.min(+e, +d1);
    return a < b ? [x(new Date(a)), x(new Date(b))] : null;
  };

  return { fmt1, sgn1, parse, mLabel, qLabel, ok, rows, resolve, stateOf, placeholder, tooltip, legend, textWidth, cutoff, lineChart, shade, timeShade, shadeSpans };
})();

/* ---------- national charts ---------- */
(() => {
  const { parse, mLabel, qLabel, stateOf, placeholder, lineChart, legend, cutoff, tooltip, fmt1 } = EC;
  let animated = false;

  function drawCPI() {
    const p = dash.params(), q = p.freq === 'quarterly', id = q ? 'cpi_quarterly' : 'cpi_monthly';
    const el = document.getElementById('chart-cpi');
    const note = document.getElementById('cpi-note');
    const ann = p.cpi_measure === 'ann';
    note.textContent = (ann
      ? (q ? 'Quarter-over-quarter change, compounded annual rate' : 'Month-over-month change, compounded annual rate')
      : (q ? 'Change from a year earlier, quarterly averages' : 'Change from a year earlier')) + '. CPI-U, seasonally adjusted; BLS via FRED.';
    const series = [
      { key: ann ? 'cpi_ann' : 'cpi_yoy', name: 'All items', color: dash.colors[0] },
      { key: ann ? 'core_ann' : 'core_yoy', name: 'Core', color: dash.colors[1] },
    ];
    legend(document.getElementById('cpi-legend'), series);
    const st = stateOf([id]);
    if (st !== 'ok') return placeholder(el, st);
    const all = dash.data(id).data.map((r) => ({ ...r, date: parse(r.date) }));
    const lastD = all[all.length - 1].date, from = cutoff(lastD, p.range);
    lineChart(el, document.getElementById('card-cpi'), all.filter((d) => d.date >= from), series,
      { zero: true, dateLabel: q ? qLabel : mLabel, animate: !animated });
  }

  function drawUnemp() {
    const p = dash.params(), q = p.freq === 'quarterly', id = q ? 'unemp_quarterly' : 'unemp_monthly';
    const el = document.getElementById('chart-unemp');
    const series = [
      { key: 'u3', name: 'U-3', color: dash.colors[0] },
      { key: 'u6', name: 'U-6', color: dash.colors[2] },
    ];
    legend(document.getElementById('unemp-legend'), series);
    const st = stateOf([id]);
    if (st !== 'ok') return placeholder(el, st);
    const all = dash.data(id).data.map((r) => ({ ...r, date: parse(r.date) }));
    const lastD = all[all.length - 1].date, from = cutoff(lastD, p.range);
    lineChart(el, document.getElementById('card-unemp'), all.filter((d) => d.date >= from), series,
      { zero: true, dateLabel: q ? qLabel : mLabel, animate: !animated });
  }

  function drawGDP() {
    const p = dash.params(), el = document.getElementById('chart-gdp'), card = document.getElementById('card-gdp');
    const comps = [
      { key: 'consumption', name: 'Consumption', color: dash.colors[0] },
      { key: 'investment', name: 'Investment', color: dash.colors[1] },
      { key: 'government', name: 'Government', color: dash.colors[2] },
      { key: 'net_exports', name: 'Net exports', color: dash.colors[3] },
    ];
    legend(document.getElementById('gdp-legend'), [...comps, { name: 'Real GDP', color: 'var(--color-fg)', round: true }]);
    const st = stateOf(['gdp_contrib']);
    if (st !== 'ok') return placeholder(el, st);
    el.replaceChildren(); el.classList.remove('dash-skeleton');
    const all = dash.data('gdp_contrib').data.filter((r) => r.gdp != null).map((r) => ({ ...r, d: parse(r.date) }));
    const from = cutoff(all[all.length - 1].d, p.range);
    const data = all.filter((r) => r.d >= from);
    const W = Math.max(280, el.clientWidth), H = 300;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img');
    const stack = d3.stack().keys(comps.map((c) => c.key)).value((r, k) => r[k] ?? 0).offset(d3.stackOffsetDiverging)(data);
    const lo = Math.min(0, d3.min(stack, (s) => d3.min(s, (v) => v[0])), d3.min(data, (r) => r.gdp));
    const hi = Math.max(0, d3.max(stack, (s) => d3.max(s, (v) => v[1])), d3.max(data, (r) => r.gdp));
    const y = d3.scaleLinear([lo, hi], [H - 28, 12]).nice();
    const yTicks = y.ticks(6), yf = (v) => d3.format('d')(v) + (v === yTicks[yTicks.length - 1] ? ' pp' : '');
    const ml = EC.textWidth(svg, yTicks.map(yf)) + 10, mr = 8;
    const x = d3.scaleBand(data.map((r) => r.date), [ml, W - mr]).paddingInner(data.length > 60 ? 0.15 : 0.3).paddingOuter(0.1);
    svg.append('g').attr('transform', `translate(${ml},0)`)
      .call(d3.axisLeft(y).tickValues(yTicks).tickSize(-(W - ml - mr)).tickFormat(yf).tickPadding(8))
      .attr('font-size', null).attr('font-family', null)
      .call((g) => g.selectAll('.tick line').style('stroke', 'var(--cds-chart-grid)'));
    // year labels on Q1 bars, thinned to fit
    const years = data.filter((r) => r.d.getUTCMonth() === 0);
    const every = Math.max(1, Math.ceil(years.length / Math.max(2, Math.floor((W - ml - mr) / 56))));
    svg.append('g').selectAll('text').data(years.filter((r, i) => i % every === 0)).join('text')
      .attr('class', 'lbl').attr('x', (r) => x(r.date) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle')
      .text((r) => r.d.getUTCFullYear());
    // shading: cover whole quarter slots that overlap each period
    const step = x.step(), pad = (step - x.bandwidth()) / 2;
    EC.shade(svg, (s, e) => {
      const qs = data.filter((r) => { const qe = new Date(r.d); qe.setUTCMonth(qe.getUTCMonth() + 3); return r.d < e && qe > s; });
      return qs.length ? [x(qs[0].date) - pad, x(qs[qs.length - 1].date) + x.bandwidth() + pad] : null;
    }, 12, H - 28);
    const g = svg.append('g').attr('class', !animated ? 'ec-fade' : null);
    const bw = Math.min(32, x.bandwidth());
    const off = (x.bandwidth() - bw) / 2;
    stack.forEach((s, i) => {
      g.append('g').style('fill', comps[i].color).selectAll('rect').data(s).join('rect')
        .attr('x', (v) => x(v.data.date) + off).attr('width', bw)
        .attr('y', (v) => y(Math.max(v[0], v[1]))).attr('height', (v) => Math.abs(y(v[0]) - y(v[1])));
    });
    svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(0)).attr('y2', y(0)).style('stroke', 'var(--cds-chart-axis)');
    g.append('g').selectAll('circle').data(data).join('circle')
      .attr('cx', (r) => x(r.date) + x.bandwidth() / 2).attr('cy', (r) => y(r.gdp)).attr('r', Math.max(2, Math.min(4, bw / 3)))
      .style('fill', 'var(--color-fg)').style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    const tip = tooltip(card);
    const hl = svg.append('rect').style('fill', 'var(--color-fg)').attr('opacity', 0.06).attr('y', 12).attr('height', H - 40).style('display', 'none');
    svg.append('g').selectAll('rect').data(data).join('rect')
      .attr('x', (r) => x(r.date) - (x.step() - x.bandwidth()) / 2).attr('width', x.step()).attr('y', 0).attr('height', H - 20).style('fill', 'transparent')
      .on('pointermove', (event, r) => {
        hl.style('display', null).attr('x', x(r.date)).attr('width', x.bandwidth());
        tip.show(event, qLabel(r.d), [
          { name: 'Real GDP', value: d3.format('+.1f')(r.gdp) + '%' },
          ...comps.map((c) => ({ color: c.color, name: c.name, value: r[c.key] == null ? '—' : d3.format('+.2f')(r[c.key]) + ' pp' })),
        ]);
      })
      .on('pointerleave', () => { hl.style('display', 'none'); tip.hide(); });
  }

  const draw = () => {
    if (window.EC_PAGE !== 'national') return;
    drawCPI(); drawUnemp(); drawGDP();
    if (['cpi_monthly', 'unemp_monthly', 'gdp_contrib'].every((id) => EC.ok(id))) animated = true;
  };
  window.EC_DRAW = window.EC_DRAW || {}; window.EC_DRAW.national = draw;
  dash.onData(draw);
})();

/* ---------- maps, detail chart and metro table ---------- */
(() => {
  const { parse, mLabel, stateOf, placeholder, tooltip, fmt1, sgn1, resolve, lineChart, legend } = EC;
  let sortKey = 'rate', sortDir = -1, query = '';
  const BINS = 7;
  // states hard to click on the map: [FIPS, postal abbreviation]
  const SMALL = [['50', 'VT'], ['33', 'NH'], ['25', 'MA'], ['44', 'RI'], ['09', 'CT'], ['34', 'NJ'], ['10', 'DE'], ['24', 'MD'], ['11', 'DC']];

  const slider = document.getElementById('map-slider');
  slider.addEventListener('input', () => {
    if (S) dash.setParams({ map_date: S.dates[+slider.value] });
  });
  document.getElementById('map-latest').addEventListener('click', () => dash.setParams({ map_date: null }));
  document.getElementById('detail-clear').addEventListener('click', () => dash.setParams({ area: null }));
  document.getElementById('metro-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); drawTable(); });
  document.querySelectorAll('#metro-table th[data-sort] button').forEach((b) => b.addEventListener('click', () => {
    const k = b.parentElement.dataset.sort;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'metro' ? 1 : -1; }
    drawTable();
  }));
  document.querySelector('#metro-table tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]'); if (tr) dash.setParams({ area: 'metro:' + tr.dataset.code });
  });

  // ---- shared map state, rebuilt in draw()
  let S = null;
  function model() {
    const sr = EC.rows('state_unemp'), mr = EC.rows('metro_unemp');
    const dates = [...new Set(sr.map((r) => r.date))].sort();
    const p = dash.params();
    // open on the latest month both maps have (metros come out a few weeks after states)
    const has = (rows) => new Set(rows.filter((r) => r.rate != null).map((r) => r.date));
    const sHas = has(sr), mHas = has(mr);
    const both = dates.filter((d) => sHas.has(d) && mHas.has(d));
    const date = p.map_date && dates.includes(p.map_date) ? p.map_date : (both.length ? both[both.length - 1] : dates[dates.length - 1]);
    const sNow = new Map(sr.filter((r) => r.date === date && r.rate != null).map((r) => [r.fips, r]));
    const mNow = new Map(mr.filter((r) => r.date === date && r.rate != null).map((r) => [r.code, r]));
    const sChg = new Map(EC.rows('state_change').filter((r) => r.date === date).map((r) => [r.fips, r.change_12m]));
    const mChg = new Map(EC.rows('metro_change').filter((r) => r.date === date).map((r) => [r.code, r.change_12m]));
    // one color scale for both maps: 2nd to 98th percentile of every rate shown since 2019
    const pool = sr.concat(mr).map((r) => r.rate).filter((v) => v != null).sort(d3.ascending);
    const lo = Math.floor(d3.quantileSorted(pool, 0.02) * 2) / 2, hi = Math.ceil(d3.quantileSorted(pool, 0.98) * 2) / 2;
    const accent = resolve(dash.colors[0]), base = resolve('var(--color-panel)');
    const ramp = d3.range(BINS).map((i) => d3.interpolateRgb(base, accent)(0.14 + 0.86 * (i / (BINS - 1))));
    const color = d3.scaleQuantize([lo, hi], ramp);
    return { dates, date, idx: dates.indexOf(date), sNow, mNow, sChg, mChg, color, lo, hi, ramp };
  }

  function drawBar() {
    document.getElementById('map-month').textContent = S ? mLabel(parse(S.date)) : '—';
    if (!S) return;
    slider.max = String(S.dates.length - 1); slider.value = String(S.idx);
    const sc = document.getElementById('map-scale'), sl = document.getElementById('map-scale-l');
    sc.replaceChildren(...S.ramp.map((c) => { const s = document.createElement('span'); s.style.background = c; return s; }));
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = '≤' + fmt1(S.lo) + '%'; b.textContent = '≥' + fmt1(S.hi) + '%';
    sl.replaceChildren(a, b);
    const empty = S.sNow.size === 0;
    document.getElementById('metro-note').textContent = empty
      ? 'No state or metro estimates were published for this month.'
      : 'Metropolitan statistical areas with a smoothed seasonally adjusted series. Gray areas have no estimate for the month.';
  }

  function mapSVG(el) {
    el.replaceChildren(); el.classList.remove('dash-skeleton');
    return d3.select(el).append('svg').attr('width', '100%').attr('viewBox', '0 0 975 610').attr('role', 'img');
  }
  const sel = () => dash.params().area || '';
  // on touch screens there is no hover, so the selected area's tooltip stays open
  const touch = () => window.matchMedia('(hover: none)').matches;
  const pin = (tip, node, showAt) => {
    if (!touch()) return;
    if (!node) { tip.hide(); return; }
    const r = node.getBoundingClientRect();
    showAt({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  };

  function drawStates() {
    const el = document.getElementById('map-states'), card = document.getElementById('card-statemap');
    const side = document.getElementById('small-states');
    const st = stateOf(['state_unemp', 'state_shapes', 'state_borders', 'state_change']);
    if (st !== 'ok') { side.replaceChildren(); return placeholder(el, st); }
    const wrap = document.getElementById('statewrap');
    wrap.classList.toggle('narrow', wrap.clientWidth < 420);
    const svg = mapSVG(el), tip = tooltip(card), cur = sel();
    const tipFor = (event, fips, fallback) => {
      const r = S.sNow.get(fips), c = S.sChg.get(fips);
      tip.show(event, (r ? r.state : fallback) + ' · ' + mLabel(parse(S.date)), [
        { name: 'Unemployment rate', value: r ? fmt1(r.rate) + '%' : 'no estimate' },
        { name: 'Change over 12 months', value: c == null ? '—' : sgn1(c) + ' pp' },
      ]);
    };
    const paths = svg.append('g').selectAll('path').data(dash.data('state_shapes').data).join('path')
      .attr('data-fips', (d) => d.fips)
      .attr('class', (d) => 'area' + (cur === 'state:' + d.fips ? ' sel' : ''))
      .attr('d', (d) => d.d)
      .style('fill', (d) => { const r = S.sNow.get(d.fips); return r ? S.color(r.rate) : 'var(--cds-chart-muted)'; })
      .on('pointermove', (event, d) => tipFor(event, d.fips, d.name))
      .on('pointerleave', () => { if (!touch()) tip.hide(); })
      .on('click', (event, d) => dash.setParams({ area: cur === 'state:' + d.fips ? null : 'state:' + d.fips }));
    const b = dash.data('state_borders').data;
    for (const row of b) svg.append('path').attr('d', row.d).style('fill', 'none').style('stroke', 'var(--color-panel)')
      .attr('stroke-width', row.layer === 'nation' ? 0 : 0.6).attr('pointer-events', 'none');
    svg.selectAll('path.sel').raise();

    // sidebar for states too small to click on the map, northeast to south
    const head = document.createElement('div'); head.className = 'ec-small-h'; head.textContent = 'Small states';
    const names = new Map(dash.data('state_shapes').data.map((d) => [d.fips, d.name]));
    side.replaceChildren(head, ...SMALL.map(([fips, abbr]) => {
      const r = S.sNow.get(fips), on = cur === 'state:' + fips;
      const b = document.createElement('button');
      b.type = 'button'; b.className = on ? 'on' : '';
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', (names.get(fips) || abbr) + (r ? ', ' + fmt1(r.rate) + ' percent' : ''));
      const sw = document.createElement('i'); sw.textContent = abbr;
      const fill = r ? S.color(r.rate) : resolve('var(--cds-chart-muted)');
      sw.style.background = fill;
      sw.style.color = d3.hsl(fill).l > 0.55 ? resolve('var(--color-fg)') : '#fff';
      const v = document.createElement('span'); v.className = 'v'; v.textContent = r ? fmt1(r.rate) + '%' : '—';
      b.append(sw, v);
      const path = paths.filter((d) => d.fips === fips);
      b.addEventListener('pointerenter', () => path.classed('hl', true).raise());
      b.addEventListener('pointermove', (event) => tipFor(event, fips, names.get(fips) || abbr));
      b.addEventListener('pointerleave', () => { path.classed('hl', false); if (!touch()) tip.hide(); svg.selectAll('path.sel').raise(); });
      b.addEventListener('click', () => dash.setParams({ area: on ? null : 'state:' + fips }));
      return b;
    }));
    const selFips = cur.startsWith('state:') ? cur.slice(6) : null;
    pin(tip, selFips && el.querySelector(`path[data-fips="${selFips}"]`),
      (pt) => tipFor(pt, selFips, names.get(selFips) || selFips));
  }

  function drawMetros() {
    const el = document.getElementById('map-metros'), card = document.getElementById('card-metromap');
    const st = stateOf(['metro_unemp', 'metro_shapes', 'metro_backdrop', 'metro_change']);
    if (st !== 'ok') return placeholder(el, st);
    const svg = mapSVG(el), tip = tooltip(card), cur = sel();
    svg.append('g').selectAll('path').data(dash.data('metro_backdrop').data).join('path')
      .attr('d', (d) => d.d).style('fill', 'var(--color-bg)').style('stroke', 'var(--color-border-line)').attr('stroke-width', 0.6);
    svg.append('g').selectAll('path').data(dash.data('metro_shapes').data).join('path')
      .attr('data-code', (d) => d.code)
      .attr('class', (d) => 'area' + (cur === 'metro:' + d.code ? ' sel' : ''))
      .attr('d', (d) => d.d)
      .style('fill', (d) => { const r = S.mNow.get(d.code); return r ? S.color(r.rate) : 'var(--cds-chart-muted)'; })
      .on('pointermove', (event, d) => metroTip(event, d.code, d.label))
      .on('pointerleave', () => { if (!touch()) tip.hide(); })
      .on('click', (event, d) => dash.setParams({ area: cur === 'metro:' + d.code ? null : 'metro:' + d.code }));
    svg.selectAll('path.sel').raise();
    function metroTip(event, code, fallback) {
      const r = S.mNow.get(code), c = S.mChg.get(code);
      tip.show(event, (r ? r.metro : fallback) + ' · ' + mLabel(parse(S.date)), [
        { name: 'Unemployment rate', value: r ? fmt1(r.rate) + '%' : 'no estimate' },
        { name: 'Change over 12 months', value: c == null ? '—' : sgn1(c) + ' pp' },
      ]);
    }
    const selCode = cur.startsWith('metro:') ? cur.slice(6) : null;
    const node = selCode && el.querySelector(`path[data-code="${selCode}"]`);
    pin(tip, node, (pt) => metroTip(pt, selCode, node.__data__.label));
  }

  function drawDetail() {
    const el = document.getElementById('chart-detail'), card = document.getElementById('card-detail');
    const title = document.getElementById('detail-title'), note = document.getElementById('detail-note');
    const area = sel(), [kind, code] = area.split(':');
    document.getElementById('detail-clear').hidden = !area;
    const st = stateOf(['state_unemp', 'metro_unemp', 'unemp_monthly']);
    if (st !== 'ok') return placeholder(el, st);
    const nat = new Map(dash.data('unemp_monthly').data.map((r) => [r.date, r.u3]));
    let own = null, name = null;
    if (kind === 'state') { own = dash.data('state_unemp').data.filter((r) => r.fips === code); name = own[0] && own[0].state; }
    if (kind === 'metro') { own = dash.data('metro_unemp').data.filter((r) => r.code === code); name = own[0] && own[0].metro; }
    const dates = S.dates;
    const ownBy = new Map((own || []).map((r) => [r.date, r.rate]));
    const data = dates.map((d) => ({ date: parse(d), area: own ? (ownBy.get(d) ?? null) : null, us: nat.get(d) ?? null }));
    const series = [];
    if (own && name) series.push({ key: 'area', name: name.length > 26 ? name.slice(0, 24) + '…' : name, color: dash.colors[0] });
    series.push({ key: 'us', name: 'United States', color: own && name ? 'var(--cds-chart-muted)' : dash.colors[0] });
    title.textContent = own && name ? name : 'Pick a state or metro';
    note.textContent = own && name
      ? 'Unemployment rate since 2019 against the national rate (U-3). The dashed line marks the month shown on the maps.'
      : 'Click an area on either map, or a row in the table, to compare it with the national rate since 2019.';
    legend(document.getElementById('detail-legend'), series);
    lineChart(el, card, data, series, { zero: true, dateLabel: mLabel, marker: parse(S.date) });
  }

  function drawTable() {
    const table = document.getElementById('metro-table'), tb = table.querySelector('tbody');
    const st = stateOf(['metro_unemp', 'metro_change']);
    if (st !== 'ok' || !S) { tb.replaceChildren(); return; }
    let rows = [...S.mNow.values()].map((r) => ({ ...r, change_12m: S.mChg.get(r.code) ?? null }));
    if (query) rows = rows.filter((r) => r.metro.toLowerCase().includes(query));
    rows.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null) return 1; if (vb == null) return -1;
      return (sortKey === 'metro' ? va.localeCompare(vb) : va - vb) * sortDir;
    });
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      if (th.dataset.sort === sortKey) th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    });
    const cur = sel(), maxRate = S.hi;
    tb.replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      tr.dataset.key = encodeURIComponent(r.code) + ',' + encodeURIComponent(r.date);
      tr.dataset.code = r.code;
      if (cur === 'metro:' + r.code) tr.className = 'sel';
      const a = document.createElement('td'); a.textContent = r.metro;
      const b = document.createElement('td'); b.className = 'num';
      const bar = document.createElement('span'); bar.className = 'bar';
      bar.style.width = Math.max(2, Math.min(1, r.rate / maxRate) * 48) + 'px'; bar.style.background = S.color(r.rate);
      b.append(bar, fmt1(r.rate));
      const c = document.createElement('td'); c.className = 'num';
      c.textContent = r.change_12m == null ? '—' : sgn1(r.change_12m);
      tr.append(a, b, c); return tr;
    }));
  }

  const draw = () => {
    const ready = stateOf(['state_unemp', 'metro_unemp']) === 'ok';
    S = ready ? model() : null;
    if (window.EC_PAGE !== 'maps') return;
    drawBar();
    if (!S) {
      const st = stateOf(['state_unemp', 'metro_unemp']);
      ['map-states', 'map-metros', 'chart-detail'].forEach((id) => placeholder(document.getElementById(id), st));
      return;
    }
    drawStates(); drawMetros(); drawDetail(); drawTable();
  };
  window.EC_DRAW = window.EC_DRAW || {}; window.EC_DRAW.maps = draw;
  dash.onData(draw);
})();

// Indicators tab: one small chart per FRED series, grouped by theme.
(() => {
  const { parse, qLabel, tooltip, textWidth, placeholder } = EC;
  const root = document.getElementById('ind-groups');
  const nav = document.getElementById('ind-nav');
  const YEARS = { '2y': 2, '5y': 5, '10y': 10 };
  const DATE_FMT = {
    D: d3.utcFormat('%b %-d, %Y'),
    W: (d) => 'Week of ' + d3.utcFormat('%b %-d, %Y')(d),
    M: d3.utcFormat('%b %Y'),
    Q: qLabel,
  };
  // flags shown when a series crosses a level worth noticing
  const FLAGS = {
    SAHMREALTIME: (v) => v >= 0.5 && 'At or above the 0.50 recession signal',
    T10Y2Y: (v) => v < 0 && 'Inverted',
    T10Y3M: (v) => v < 0 && 'Inverted',
  };
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const fmtVal = (s, v) => d3.format(',.' + s.decimals + 'f')(v) + s.unit;
  const chgUnit = (s) => (s.unit === '%' ? ' pp' : s.unit);
  const fmtChg = (s, v) => d3.format('+,.' + s.decimals + 'f')(v) + chgUnit(s);

  let built = null; // id -> card parts
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function build(list) {
    built = new Map();
    const groups = d3.groups(list, (s) => s.group);
    nav.replaceChildren(...groups.map(([g]) => {
      const b = el('button', 'ind-nav-link', g);
      b.type = 'button';
      b.dataset.target = 'ind-' + slug(g);
      b.addEventListener('click', () => document.getElementById(b.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return b;
    }));
    root.replaceChildren(...groups.map(([g, items]) => {
      const sec = el('section', 'ind-group');
      sec.id = 'ind-' + slug(g);
      const grid = el('div', 'ind-grid');
      for (const s of items) {
        const card = el('div', 'ec-card ind-card');
        card.id = 'ind-card-' + s.id;
        const head = el('div', 'ind-head');
        const title = el('h3', null, s.title);
        const sid = el('span', 'ind-id', s.id);
        head.append(title, sid);
        const value = el('div', 'ind-val', '—');
        const meta = el('div', 'ind-meta');
        const flag = el('div', 'ind-flag');
        const chart = el('div', 'ind-chart');
        const note = el('p', 'ec-note ind-note', s.note);
        card.append(head, value, meta, flag, chart, note);
        grid.append(card);
        built.set(s.id, { card, value, meta, flag, chart });
      }
      sec.append(el('h2', 'ind-group-title', g), grid);
      return sec;
    }));
  }

  function yearAgo(obs, last) {
    const target = new Date(last.d); target.setUTCFullYear(target.getUTCFullYear() - 1);
    const t = +target + 3 * 864e5; // a few days of slack for weekly and daily dates
    for (let i = obs.length - 1; i >= 0; i--) if (+obs[i].d <= t && obs[i].v != null) return obs[i];
    return null;
  }

  function miniChart(s, parts, obs, range) {
    const box = parts.chart;
    box.replaceChildren();
    const last = obs[obs.length - 1];
    let from = new Date(2000, 0, 1);
    if (YEARS[range]) { from = new Date(last.d); from.setUTCFullYear(from.getUTCFullYear() - YEARS[range]); }
    const data = obs.filter((o) => o.d >= from);
    if (data.filter((o) => o.v != null).length < 2) { box.append(el('div', 'ec-empty', 'Not enough data in this range')); return; }
    const W = Math.max(220, box.clientWidth), H = 150, mt = 8, mb = 22;
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
      .attr('aria-label', s.title + ' chart');
    const vals = data.map((o) => o.v).filter((v) => v != null);
    if (s.ref != null) vals.push(s.ref);
    const y = d3.scaleLinear(d3.extent(vals), [H - mb, mt]).nice(4);
    const ticks = y.ticks(4);
    const tf = (v) => d3.format(',.' + Math.max(0, d3.precisionFixed((ticks[1] - ticks[0]) || 1)) + 'f')(v);
    const ml = textWidth(svg, ticks.map(tf)) + 8, mr = 6;
    const x = d3.scaleUtc(d3.extent(data, (o) => o.d), [ml, W - mr]);
    svg.append('g').attr('transform', `translate(${ml},0)`)
      .call(d3.axisLeft(y).tickValues(ticks).tickSize(-(W - ml - mr)).tickFormat(tf).tickPadding(6))
      .attr('font-size', null).attr('font-family', null)
      .call((g) => g.selectAll('.tick line').style('stroke', 'var(--cds-chart-grid)'));
    const span = (x.domain()[1] - x.domain()[0]) / 3.156e10; // years shown
    const xt = span < 2.5 ? d3.utcMonth.every(span < 1.2 ? 3 : 6) : d3.utcYear.every(Math.max(1, Math.ceil(span / Math.max(2, Math.floor((W - ml) / 60)))));
    svg.append('g').attr('transform', `translate(0,${H - mb})`)
      .call(d3.axisBottom(x).ticks(xt).tickSize(0).tickPadding(8).tickFormat(span < 2.5 ? d3.utcFormat('%b %y') : d3.utcFormat('%Y')))
      .attr('font-size', null).attr('font-family', null);
    EC.shade(svg, EC.timeShade(x), mt, H - mb, { label: W > 300 });
    if (s.ref != null && s.ref >= y.domain()[0] && s.ref <= y.domain()[1]) {
      svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(s.ref)).attr('y2', y(s.ref))
        .style('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 3');
    }
    const color = dash.colors[0];
    svg.append('path').datum(data).style('fill', 'none').style('stroke', color).attr('stroke-width', 1.75)
      .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
      .attr('d', d3.line().defined((o) => o.v != null).x((o) => x(o.d)).y((o) => y(o.v)));
    if (s.ref_label && s.ref >= y.domain()[0] && s.ref <= y.domain()[1]) {
      const ry = y(s.ref), above = ry - 4 > mt + 10; // keep the label inside the plot
      svg.append('text').attr('class', 'lbl ind-ref').attr('x', ml + 4).attr('y', above ? ry - 4 : ry + 12).text(s.ref_label);
    }
    const lastDef = [...data].reverse().find((o) => o.v != null);
    svg.append('circle').attr('cx', x(lastDef.d)).attr('cy', y(lastDef.v)).attr('r', 3).style('fill', color);
    const tip = tooltip(parts.card);
    const dot = svg.append('circle').attr('r', 3.5).style('fill', color).style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5).style('display', 'none');
    const rule = svg.append('line').attr('y1', mt).attr('y2', H - mb).style('stroke', 'var(--cds-chart-axis)').style('display', 'none');
    const defined = data.filter((o) => o.v != null);
    const bis = d3.bisector((o) => o.d).center;
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', H - mb).style('fill', 'transparent')
      .on('pointermove', (event) => {
        const o = defined[bis(defined, x.invert(d3.pointer(event)[0]))];
        if (!o) return;
        rule.style('display', null).attr('x1', x(o.d)).attr('x2', x(o.d));
        dot.style('display', null).attr('cx', x(o.d)).attr('cy', y(o.v)).raise();
        tip.show(event, DATE_FMT[s.freq](o.d), [{ name: s.title, value: fmtVal(s, o.v) }]);
      })
      .on('pointerleave', () => { rule.style('display', 'none'); dot.style('display', 'none'); tip.hide(); });
  }

  function draw() {
    if (window.EC_PAGE !== 'indicators') return;
    const d = dash.data('indicators');
    document.getElementById('ind-count').textContent = d.status === 'ok' ? d.data.length + ' series from FRED' : '';
    if (d.status !== 'ok') {
      if (!built) placeholder(root, d.status === 'loading' ? 'loading' : 'error');
      return;
    }
    root.classList.remove('dash-skeleton');
    if (!built || built.size !== d.data.length || !d.data.every((s) => built.has(s.id))) build(d.data);
    const range = dash.params().ind_range || '5y';
    for (const s of d.data) {
      const parts = built.get(s.id);
      const obs = s.obs.map(([date, v]) => ({ d: parse(date), v }));
      const defined = obs.filter((o) => o.v != null);
      if (!defined.length) { parts.value.textContent = '—'; parts.meta.textContent = 'No data'; continue; }
      const last = defined[defined.length - 1];
      parts.value.textContent = fmtVal(s, last.v);
      const ya = yearAgo(defined, last);
      parts.meta.textContent = DATE_FMT[s.freq](last.d) + (ya ? ' · ' + fmtChg(s, last.v - ya.v) + ' vs a year earlier' : '');
      const flag = FLAGS[s.id] && FLAGS[s.id](last.v);
      parts.flag.textContent = flag || '';
      parts.flag.hidden = !flag;
      miniChart(s, parts, obs, range);
    }
    markCurrent();
  }

  // highlight the theme currently in view in the sidebar
  function markCurrent() {
    if (window.EC_PAGE !== 'indicators' || !built) return;
    const secs = [...root.querySelectorAll('.ind-group')];
    let cur = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top < window.innerHeight * 0.35) cur = s;
    nav.querySelectorAll('.ind-nav-link').forEach((b) => b.classList.toggle('on', cur && b.dataset.target === cur.id));
  }
  window.addEventListener('scroll', () => requestAnimationFrame(markCurrent), { passive: true });

  window.EC_DRAW = window.EC_DRAW || {};
  window.EC_DRAW.indicators = () => { draw(); markCurrent(); };
  dash.onData(draw);
})();

/* ---------- load the saved data (replaces Smardash's Refresh button) ---------- */
(() => {
  const DATA = ['cpi_monthly', 'cpi_quarterly', 'gdp_contrib', 'unemp_monthly', 'unemp_quarterly', 'state_unemp', 'metro_unemp', 'indicators', 'shading'];
  const SHAPES = ['state_shapes', 'state_borders', 'metro_shapes', 'metro_backdrop'];
  const stamp = document.getElementById('pulled');
  const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  // state and metro rates are saved compactly (one array of rates per area); expand to rows
  const expand = (c) => c.areas.flatMap(({ rates, ...area }) => c.dates.map((date, i) => ({ date, ...area, rate: rates[i] })));

  for (const id of SHAPES) {
    fetch('data/shapes/' + id + '.json')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((rows) => { dash._set(id, rows); dash._notify(); })
      .catch((e) => { dash._fail(id, String(e)); dash._notify(); });
  }

  // GitHub Pages lets browsers reuse files for 10 minutes; always check for a newer copy
  // (an unchanged file comes back as a cheap 304 Not Modified)
  fetch('data/economy.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((j) => {
      for (const id of DATA) {
        const d = j.datasets[id];
        dash._set(id, d && d.areas ? expand(d) : d);
      }
      dash._notify();
      const t = document.createElement('time');
      t.dateTime = j.meta.pulled_at;
      t.textContent = when(j.meta.pulled_at);
      stamp.replaceChildren(t);
    })
    .catch((e) => {
      for (const id of DATA) dash._fail(id, String(e));
      dash._notify();
      stamp.parentElement.classList.add('err');
      stamp.textContent = 'Couldn’t load the data';
    });

  // charts measure text and read colors when drawn, so redraw on theme, size and font changes
  window.addEventListener('themechange', () => dash._notify());
  let w = window.innerWidth, timer = 0;
  window.addEventListener('resize', () => {
    if (window.innerWidth === w) return;
    w = window.innerWidth;
    clearTimeout(timer); timer = setTimeout(() => dash._notify(), 150);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => dash._notify());
})();
