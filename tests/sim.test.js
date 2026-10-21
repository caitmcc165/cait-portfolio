// Run with: npm test   (or: node --test tests/sim.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/sim.js');

const play = (seed, hook) => { const s = S.createDelivery({ seed }); while (!s.done) { if (hook) hook(s); s.step(); } return s; };
const outage = (respond) => s => { if (s.t === 180) s.setDown('B', true); if (respond && s.t === 210) respond(s); };

test('priority queue always pops the smallest item', () => {
  const q = new S.PriorityQueue((a, b) => a < b), r = S.rng(1), xs = [];
  for (let i = 0; i < 500; i++) { const x = Math.floor(r() * 1000); xs.push(x); q.push(x); }
  xs.sort((a, b) => a - b);
  for (const x of xs) assert.equal(q.pop(), x);
  assert.equal(q.pop(), undefined);
});

test('heap property holds after every push', () => {
  const q = new S.PriorityQueue((a, b) => a < b), r = S.rng(2);
  for (let i = 0; i < 300; i++) {
    q.push(r());
    q.a.forEach((v, j) => { if (j) assert.ok(q.a[(j - 1) >> 1] <= v); });
  }
});

test('order engine: priority never makes urgent orders later than FIFO', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const o = S.makeOrders(100, seed);
    const f = S.runOrderEngine(o, 'fifo'), p = S.runOrderEngine(o, 'priority');
    assert.equal(f.processed, 100); assert.equal(p.processed, 100);
    assert.ok(p.urgentLate <= f.urgentLate, `seed ${seed}`);
  }
});

test('pipeline: each fault is caught by its own stage and nothing deploys', () => {
  assert.equal(S.runPipeline([]).deployed, true);
  for (const [fault, f] of Object.entries(S.FAULTS)) {
    const run = S.runPipeline([fault]);
    assert.equal(run.deployed, false);
    assert.equal(run.stoppedAt, f.stops);
    const i = run.stages.findIndex(s => s.status === 'failed');
    assert.ok(run.stages.slice(i + 1).every(s => s.status === 'skipped'));
  }
});

test('pipeline: the earliest failing check stops the run', () => {
  assert.equal(S.runPipeline(['test', 'secret']).stoppedAt, 'secrets');
});

test('delivery: same seed, same day (deterministic)', () => {
  const a = play(11).metrics(), b = play(11).metrics();
  assert.deepEqual(a, b);
});

test('delivery: every order is accounted for and trucks never overload', () => {
  const s = S.createDelivery({ seed: 11 });
  while (!s.done) {
    s.step();
    for (const k of s.trucks) assert.ok(k.load.length <= S.CONST.CAP);
  }
  const m = s.metrics();
  assert.equal(m.delivered + m.backlog, m.created);
});

test('delivery: a normal day meets the 95% goal', () => {
  assert.ok(play(11).metrics().onTimeRate >= 0.95);
});

test('delivery: an unanswered outage misses the goal', () => {
  assert.ok(play(11, outage()).metrics().onTimeRate < 0.95);
});

test('delivery: rerouting alone helps, but is not enough', () => {
  const nothing = play(11, outage()).metrics().onTimeRate;
  const rerouteOnly = play(11, outage(s => s.setPolicy('balance'))).metrics().onTimeRate;
  assert.ok(rerouteOnly > nothing);
  assert.ok(rerouteOnly < 0.95);
});

test('delivery: trucks sent to the offline carrier are wasted', () => {
  const rerouteOnly = play(11, outage(s => s.setPolicy('balance'))).metrics().onTimeRate;
  const wrongCarrier = play(11, outage(s => { s.setPolicy('balance'); s.addTruck('B'); s.addTruck('B'); })).metrics().onTimeRate;
  assert.equal(wrongCarrier, rerouteOnly);
});

test('delivery: a slow response costs on-time deliveries', () => {
  const late = play(11, s => { if (s.t === 180) s.setDown('B', true); if (s.t === 400) { s.setPolicy('balance'); s.addTruck('A'); s.addTruck('A'); } }).metrics().onTimeRate;
  assert.ok(late < 0.95);
});

test('delivery: dispatch triages orders that can still make it on time', () => {
  const s = S.createDelivery({ seed: 11 });
  while (!s.done) { if (s.t === 180) s.setDown('B', true); if (s.t === 210) s.setPolicy('balance'); s.step(); }
  // under overload, triage should deliver a meaningful share on time rather than letting everything slip
  assert.ok(s.metrics().onTime > s.metrics().late);
});

test('delivery: rerouting plus capacity recovers the day', () => {
  const m = play(11, outage(s => { s.setPolicy('balance'); s.addTruck('A'); s.addTruck('A'); })).metrics();
  assert.ok(m.onTimeRate >= 0.95);
});

test('delivery: extra trucks are capped', () => {
  const s = S.createDelivery({ seed: 1 });
  assert.equal(s.addTruck('A'), true); assert.equal(s.addTruck('B'), true); assert.equal(s.addTruck('A'), false);
});
