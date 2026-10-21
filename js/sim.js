/*
 * Simulations behind the portfolio's interactive pieces.
 * Pure logic: no DOM, no WebGL, no clock. Every run is seeded and deterministic,
 * so the renderer only *shows* state and the tests in tests/sim.test.js check the rules.
 *
 * Works as a browser global (window.CaitSim) and as a Node module (require('./sim.js')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaitSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Seeded random numbers (mulberry32)                                  */
  /* ------------------------------------------------------------------ */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Priority queue: a binary min-heap with a caller-supplied ordering   */
  /* push / pop are O(log n), peek is O(1)                               */
  /* ------------------------------------------------------------------ */
  class PriorityQueue {
    constructor(less) { this.a = []; this.less = less; this.swaps = 0; }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    push(x) {
      const a = this.a; a.push(x);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.less(a[i], a[p])) break;
        [a[i], a[p]] = [a[p], a[i]]; this.swaps++; i = p;
      }
    }
    pop() {
      const a = this.a; if (!a.length) return undefined;
      const top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && this.less(a[l], a[m])) m = l;
          if (r < a.length && this.less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]]; this.swaps++; i = m;
        }
      }
      return top;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Order engine: the same orders through a FIFO queue vs. a heap       */
  /* ------------------------------------------------------------------ */
  function makeOrders(n, seed, urgentShare) {
    const r = rng(seed), out = []; let t = 0; urgentShare = urgentShare == null ? 0.15 : urgentShare;
    for (let i = 0; i < n; i++) {
      t += -Math.log(1 - r());                         // ~1 arrival per time unit
      const urgent = r() < urgentShare;
      out.push({ id: i + 1, arrive: t, urgent, deadline: t + (urgent ? 8 : 40) });
    }
    return out;
  }
  function runOrderEngine(orders, strategy, service) {
    service = service || 1.25;                        // slower than arrivals, so a queue builds and order choice matters
    const byUrgency = (x, y) => x.urgent !== y.urgent ? x.urgent : x.deadline !== y.deadline ? x.deadline < y.deadline : x.id < y.id;
    const fifo = [], heap = new PriorityQueue(byUrgency);
    const size = () => strategy === 'priority' ? heap.size : fifo.length - head;
    let head = 0, t = 0, i = 0, maxQueue = 0; const done = [];
    while (i < orders.length || size()) {
      if (!size() && orders[i].arrive > t) t = orders[i].arrive;
      while (i < orders.length && orders[i].arrive <= t) { strategy === 'priority' ? heap.push(orders[i]) : fifo.push(orders[i]); i++; }
      maxQueue = Math.max(maxQueue, size());
      const o = strategy === 'priority' ? heap.pop() : fifo[head++];
      t += service;
      done.push({ id: o.id, urgent: o.urgent, wait: t - o.arrive, late: t > o.deadline });
    }
    const urgent = done.filter(d => d.urgent);
    return {
      strategy, processed: done.length, maxQueue,
      late: done.filter(d => d.late).length,
      urgent: urgent.length,
      urgentLate: urgent.filter(d => d.late).length,
      avgUrgentWait: urgent.reduce((s, d) => s + d.wait, 0) / Math.max(1, urgent.length),
      avgWait: done.reduce((s, d) => s + d.wait, 0) / Math.max(1, done.length),
      heapSwaps: strategy === 'priority' ? heap.swaps : 0,
      results: done,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Deployment pipeline: which check catches which fault                */
  /* ------------------------------------------------------------------ */
  const STAGES = [
    { id: 'push',    name: 'open PR',          secs: 4 },
    { id: 'secrets', name: 'secret scan',      secs: 18, catches: 'secret' },
    { id: 'deps',    name: 'dependency check', secs: 35, catches: 'vuln' },
    { id: 'static',  name: 'static analysis',  secs: 70, catches: 'unsafe' },
    { id: 'tests',   name: 'unity tests',      secs: 220, catches: 'test' },
    { id: 'build',   name: 'webgl build',      secs: 445, catches: 'license' },
    { id: 'deploy',  name: 'deploy',           secs: 50 },
  ];
  const FAULTS = {
    secret:  { label: 'Commit an API key',                         stops: 'secrets', why: 'Secret scanning reads the diff for credential patterns and fails the check, so the key never reaches a build or the main branch. It is already in the branch history, though: the key has to be revoked and rotated. Push protection or a pre-commit hook would stop it even earlier.' },
    vuln:    { label: 'Add a package with a known vulnerability',  stops: 'deps',    why: 'The dependency check compares package versions against published advisories and blocks the merge until the package is updated or replaced.' },
    unsafe:  { label: 'Use an unsafe code pattern',                stops: 'static',  why: 'Static analysis flags risky code paths without running them, so they are caught before tests spend minutes on a build.' },
    test:    { label: 'Break a gameplay test',                     stops: 'tests',   why: 'The Unity test runner executes edit-mode and play-mode tests; one failure blocks the merge, so a broken game is never published.' },
    license: { label: 'Remove the Unity license secret',           stops: 'build',   why: 'The WebGL build needs the Unity license from the repository secrets. Without it the build step fails with a clear activation error.' },
  };
  function runPipeline(faults) {
    const f = new Set(faults || []); let stopped = null; let elapsed = 0;
    const stages = STAGES.map(s => {
      if (stopped) return { ...s, status: 'skipped' };
      elapsed += s.secs;
      if (s.catches && f.has(s.catches)) { stopped = s; return { ...s, status: 'failed', fault: s.catches, at: elapsed }; }
      return { ...s, status: 'passed', at: elapsed };
    });
    return { stages, deployed: !stopped, stoppedAt: stopped ? stopped.id : null, elapsed };
  }

  /* ------------------------------------------------------------------ */
  /* Delivery network: one manufacturer, two carriers, 24 client sites   */
  /* (a scaled-down, illustrative model of a real ~200-client workflow)  */
  /* Units: 1 tick = 1 minute from 8:00. Distances in map units.         */
  /* ------------------------------------------------------------------ */
  const DAY = 600;           // orders arrive 8:00–18:00
  const END = 840;           // the simulation runs until 22:00
  const SLA = 240;           // promised within 4 hours
  const PREP = 18;           // manufacturer prep time
  const HANDOFF = 14;        // manufacturer → depot
  const REROUTE = 12;        // depot → other depot
  const CAP = 8;             // orders per truck
  const SPEED = 0.42;        // map units per tick
  const STOP = 2;            // ticks per delivery stop
  const MAX_EXTRA_TRUCKS = 2;
  const TRIAGE_ETA = 45;    // rough minutes from depot to doorstep, used to triage

  const LAYOUT = (function () {
    const streets = { N: { y: 4.4, x0: 0.6, x1: 13 }, S: { y: -4.4, x0: 0.6, x1: 13 } };
    const clients = [];
    ['N', 'S'].forEach(st => {
      const s = streets[st];
      for (let k = 0; k < 6; k++) {
        const x = 1.7 + k * 1.95;
        clients.push({ id: clients.length, street: st, x, y: s.y + 1.3 });
        clients.push({ id: clients.length, street: st, x: x + 0.95, y: s.y - 1.3 });
      }
    });
    return { manufacturer: { x: -10, y: 0 }, depots: { A: { x: -4.2, y: 2.9 }, B: { x: -4.2, y: -2.9 } }, streets, clients, zone: { N: 'A', S: 'B' } };
  })();

  function createDelivery(opts) {
    opts = opts || {};
    const r = rng(opts.seed == null ? 7 : opts.seed);
    const sim = {
      t: 0, done: false, layout: LAYOUT,
      demand: opts.demand || 190,
      policy: opts.policy || 'zones',
      down: { A: false, B: false },
      orders: [], trucks: [], events: [], extraTrucks: 0, nextId: 1,
    };
    const trucksPer = opts.trucks || { A: 2, B: 2 };
    let tid = 1;
    for (const c of ['A', 'B']) for (let k = 0; k < trucksPer[c]; k++) sim.trucks.push(newTruck(tid++, c));
    function newTruck(id, carrier) {
      const d = LAYOUT.depots[carrier];
      return { id, carrier, state: 'idle', x: d.x, y: d.y, heading: 0, path: null, seg: 0, wait: 0, load: [], tours: 0 };
    }
    const clock = t => { const m = 8 * 60 + t; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
    const log = (text, kind) => { sim.events.push({ t: sim.t, time: clock(sim.t), text, kind: kind || 'info' }); };
    sim.clock = clock;

    function load(carrier) {           // orders committed to a carrier and not yet on a truck
      return sim.orders.filter(o => o.carrier === carrier && (o.stage === 'handoff' || o.stage === 'waiting')).length;
    }
    function assign(o) {
      const client = LAYOUT.clients[o.client], zoneCarrier = LAYOUT.zone[client.street], other = zoneCarrier === 'A' ? 'B' : 'A';
      if (sim.policy === 'zones') return zoneCarrier;
      if (sim.down[zoneCarrier] && !sim.down[other]) return other;
      if (!sim.down[other] && load(zoneCarrier) > load(other) + 6) return other;
      return zoneCarrier;
    }
    function buildPath(carrier, street, stops) {
      const d = LAYOUT.depots[carrier], s = LAYOUT.streets[street];
      const pts = [{ x: d.x, y: d.y }, { x: s.x0, y: s.y }];
      const xs = [...new Set(stops.map(c => LAYOUT.clients[c].x))].sort((a, b) => a - b);
      const stopAt = {};
      xs.forEach(x => { stopAt[pts.length] = stops.filter(c => LAYOUT.clients[c].x === x); pts.push({ x, y: s.y }); });
      pts.push({ x: s.x0, y: s.y }, { x: d.x, y: d.y });
      return { pts, stopAt };
    }

    sim.decisions = [];
    sim.setPolicy = function (p) { if (p !== sim.policy) { sim.policy = p; sim.decisions.push({ t: sim.t, what: 'policy:' + p }); log(p === 'balance' ? 'Routing switched to balance load across both carriers' : 'Routing switched to fixed zones', 'decision'); } };
    sim.setDown = function (c, v) {
      if (sim.down[c] === v) return; sim.down[c] = v;
      log(v ? `Carrier ${c} is offline: its trucks stop dispatching` : `Carrier ${c} is back online`, v ? 'alert' : 'decision');
    };
    sim.addTruck = function (c) {
      if (sim.extraTrucks >= MAX_EXTRA_TRUCKS) return false;
      sim.extraTrucks++; sim.trucks.push(newTruck(sim.trucks.length + 1, c)); sim.decisions.push({ t: sim.t, what: 'truck:' + c }); log(`Added a truck to carrier ${c}`, 'decision'); return true;
    };

    sim.step = function () {
      if (sim.done) return;
      const t = sim.t;

      // 1 · demand arrives during business hours
      if (t < DAY) {
        let lambda = sim.demand / DAY;
        while (lambda > 0) {
          if (r() < Math.min(1, lambda)) {
            sim.orders.push({ id: sim.nextId++, client: Math.floor(r() * LAYOUT.clients.length), created: t, due: t + SLA,
              stage: 'prep', readyAt: t + PREP + Math.floor(r() * 10), carrier: null, at: null, delivered: null, late: false });
          }
          lambda -= 1;
        }
      }

      // 2 · prep → handoff to a carrier; handoff → waiting at the depot
      for (const o of sim.orders) {
        if (o.stage === 'prep' && t >= o.readyAt) { o.carrier = assign(o); o.stage = 'handoff'; o.from = 'M'; o.leftAt = t; o.at = t + HANDOFF; }
        else if (o.stage === 'handoff' && t >= o.at) { o.stage = 'waiting'; o.waitingSince = t; }
      }

      // 3 · with balancing on, orders stuck at an offline depot are rerouted
      if (sim.policy === 'balance') {
        for (const c of ['A', 'B']) {
          const other = c === 'A' ? 'B' : 'A';
          if (!sim.down[c] || sim.down[other]) continue;
          const stuck = sim.orders.filter(o => o.carrier === c && o.stage === 'waiting');
          if (stuck.length) {
            stuck.forEach(o => { o.carrier = other; o.stage = 'handoff'; o.from = c; o.leftAt = t; o.at = t + REROUTE; });
            log(`Rerouted ${stuck.length} waiting order${stuck.length > 1 ? 's' : ''} from ${c} to ${other}`, 'decision');
          }
        }
      }

      // 4 · dispatch idle trucks
      for (const k of sim.trucks) {
        if (k.state !== 'idle' || sim.down[k.carrier]) continue;
        // triage: orders that can still arrive on time go first; already-late ones follow, oldest first
        const savable = o => t + TRIAGE_ETA <= o.due;
        const waiting = sim.orders.filter(o => o.carrier === k.carrier && o.stage === 'waiting')
          .sort((a, b) => (savable(b) - savable(a)) || (a.created - b.created));
        if (!waiting.length) continue;
        const street = LAYOUT.clients[waiting[0].client].street;
        const forStreet = waiting.filter(o => LAYOUT.clients[o.client].street === street);
        const oldestWait = Math.max(...forStreet.map(o => t - o.waitingSince));
        if (forStreet.length < CAP && oldestWait < 25 && t < DAY) continue;
        k.load = forStreet.slice(0, CAP);
        k.load.forEach(o => { o.stage = 'transit'; o.truck = k.id; });
        const p = buildPath(k.carrier, street, [...new Set(k.load.map(o => o.client))]);
        k.path = p.pts; k.stopAt = p.stopAt; k.seg = 0; k.state = 'route'; k.wait = 0; k.tours++;
      }

      // 5 · move trucks along their routes, delivering at each stop
      for (const k of sim.trucks) {
        if (k.state !== 'route') continue;
        if (k.wait > 0) { k.wait--; continue; }
        let budget = SPEED;
        while (budget > 0 && k.state === 'route') {
          const target = k.path[k.seg + 1];
          const dx = target.x - k.x, dy = target.y - k.y, dist = Math.hypot(dx, dy);
          if (dist > 1e-9) k.heading = Math.atan2(dy, dx);
          if (dist <= budget) {
            k.x = target.x; k.y = target.y; budget -= dist; k.seg++;
            const atStop = k.stopAt[k.seg];
            if (atStop) {
              for (const o of k.load) if (o.stage === 'transit' && atStop.includes(o.client)) {
                o.stage = 'delivered'; o.delivered = t; o.late = t > o.due;
              }
              k.wait = STOP; budget = 0;
            }
            if (k.seg >= k.path.length - 1) { k.state = 'idle'; k.load = []; k.path = null; }
          } else { k.x += dx / dist * budget; k.y += dy / dist * budget; budget = 0; }
        }
      }

      // 6 · notable moments
      const m = sim.metrics();
      if (m.late && !sim._firstLate) { sim._firstLate = true; log('First order delivered late', 'alert'); }
      for (const c of ['A', 'B']) {
        const w = m.waiting[c], key = '_peak' + c;
        if (w >= 15 && !sim[key]) { sim[key] = true; log(`${w} orders piling up at carrier ${c}`, 'alert'); }
        if (w < 5) sim[key] = false;
      }
      if (t === DAY) log('Last orders of the day are in', 'info');

      sim.t++;
      const open = sim.orders.some(o => o.stage !== 'delivered');
      if ((sim.t >= DAY && !open) || sim.t >= END) {
        sim.done = true;
        const f = sim.metrics();
        log(`Day closed: ${f.delivered} delivered, ${(f.onTimeRate * 100).toFixed(1)}% on time`, f.onTimeRate >= 0.95 ? 'success' : 'alert');
      }
    };

    sim.metrics = function () {
      const delivered = sim.orders.filter(o => o.stage === 'delivered');
      const late = delivered.filter(o => o.late).length;
      const overdue = sim.orders.filter(o => o.stage !== 'delivered' && sim.t > o.due).length;
      const w = c => sim.orders.filter(o => o.carrier === c && o.stage === 'waiting').length;
      return {
        time: clock(sim.t), t: sim.t,
        created: sim.orders.length, delivered: delivered.length, late, overdue,
        backlog: sim.orders.length - delivered.length,
        onTime: delivered.length - late,
        // on-time = delivered on time ÷ orders that are already due (delivered or overdue);
        // at day's end every undelivered order counts as missed
        onTimeRate: (() => { const judged = sim.done ? sim.orders.length : delivered.length + overdue; return judged ? (delivered.length - late) / judged : 1; })(),
        prep: sim.orders.filter(o => o.stage === 'prep').length,
        handoff: { A: sim.orders.filter(o => o.carrier === 'A' && o.stage === 'handoff').length, B: sim.orders.filter(o => o.carrier === 'B' && o.stage === 'handoff').length },
        waiting: { A: w('A'), B: w('B') },
        trucksOut: sim.trucks.filter(k => k.state === 'route').length,
        extraTrucksLeft: MAX_EXTRA_TRUCKS - sim.extraTrucks,
      };
    };

    sim.runTo = function (t, hook) { while (!sim.done && sim.t < t) { if (hook) hook(sim); sim.step(); } return sim; };
    return sim;
  }

  return { rng, PriorityQueue, makeOrders, runOrderEngine, STAGES, FAULTS, runPipeline, createDelivery,
           CONST: { DAY, END, SLA, PREP, HANDOFF, CAP, SPEED, STOP } };
});
