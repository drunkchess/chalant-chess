// Position evaluation for the eval bar. Two interchangeable engines:
//   'native'  - the server's Stockfish via GET /api/eval (fast, needs the server)
//   'browser' - Stockfish 19 lite compiled to WASM, in a Web Worker (vendor/stockfish/, runs on your CPU)
// Evaluator.request(kind, fen, depth, cb): cb(result, error). Results are from WHITE's point of view:
//   { cp, mate, depth, best_san?, ms?, done, engine }   (cp null when mate is set)  or  { over, result, done }
// A newer request supersedes the older one; the older one's callbacks are dropped.
const Evaluator = (() => {
  const WORKER_URL = 'vendor/stockfish/stockfish-19-lite-single.js';

  // ---- browser engine ----
  const B = { worker: null, ready: false, searching: false, pending: null, active: null, last: null, failed: null };

  function post(cmd) { B.worker.postMessage(cmd); }

  function browserStart() {
    if (B.worker || B.failed) return;
    try {
      B.worker = new Worker(WORKER_URL);
    } catch (e) { B.failed = e; return; }
    B.worker.onerror = (ev) => {
      B.failed = new Error(ev.message || 'engine worker failed to load');
      const r = B.pending || B.active;
      B.pending = B.active = null;
      if (r) r.cb(null, B.failed);
    };
    B.worker.onmessage = (ev) => browserLine(String(ev.data));
    post('uci');
  }

  function browserPump() {
    if (!B.ready || B.searching || !B.pending) return;
    B.active = B.pending; B.pending = null; B.searching = true; B.last = null;
    B.active.t0 = performance.now();
    post('position fen ' + B.active.fen);
    post('go depth ' + B.active.depth);
  }

  function toWhite(score, fen) { return fen.split(' ')[1] === 'w' ? score : -score; }

  function browserLine(line) {
    if (line === 'uciok') { post('setoption name Hash value 32'); post('isready'); return; }
    if (line === 'readyok') { B.ready = true; browserPump(); return; }
    const req = B.active;
    if (line.startsWith('info ') && req && !B.pending) {            // only the newest request gets updates
      const d = /\bdepth (\d+)/.exec(line), s = /\bscore (cp|mate) (-?\d+)/.exec(line);
      if (!d || !s || /\b(lowerbound|upperbound)\b/.test(line)) return;
      const mp = /\bmultipv (\d+)/.exec(line);
      if (mp && mp[1] !== '1') return;
      const v = toWhite(parseInt(s[2], 10), req.fen), pv = /\bpv (\S+)/.exec(line);
      B.last = { cp: s[1] === 'cp' ? v : null, mate: s[1] === 'mate' ? v : null, depth: +d[1],
                 best_uci: pv ? pv[1] : null, engine: 'browser', done: false };
      req.cb(B.last, null);
    } else if (line.startsWith('bestmove')) {
      B.searching = false;
      B.active = null;                      // clear BEFORE the callback: it may start the next request right away
      if (req && !B.pending && B.last) req.cb({ ...B.last, done: true, ms: Math.round(performance.now() - req.t0) }, null);
      browserPump();
    }
  }

  function browserRequest(req) {
    browserStart();
    if (B.failed) { req.cb(null, B.failed); return; }
    B.pending = req;
    if (B.searching) post('stop');       // old search ends with a 'bestmove', then the pending one starts
    else browserPump();
  }

  // ---- native engine ----
  let nativeCtl = null;
  function nativeRequest(req) {
    if (nativeCtl) nativeCtl.abort();
    const ctl = nativeCtl = new AbortController();
    fetch('/api/eval?depth=' + req.depth + '&fen=' + encodeURIComponent(req.fen), { signal: ctl.signal, cache: 'no-store' })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then(j => req.cb({ ...j, done: true }, null))
      .catch(e => { if (e.name !== 'AbortError') req.cb(null, e); });
  }

  // ---- public ----
  let latest = null;
  function request(kind, fen, depth, cb) {
    const req = { kind, fen, depth, cb: (r, e) => { if (latest === req) cb(r, e); } };
    latest = req;
    if (kind !== 'browser' && B.searching) { B.pending = null; post('stop'); }   // switching away: stop burning CPU
    (kind === 'browser' ? browserRequest : nativeRequest)(req);
  }
  function cancel() {
    latest = null;
    if (nativeCtl) nativeCtl.abort();
    B.pending = null;
    if (B.searching) post('stop');
  }

  // Lichess win-chance curve: centipawns (white's view) -> white's share of the bar, 0..1
  function whiteShare(r) {
    if (!r) return 0.5;
    if (r.over) return r.result === '1-0' ? 1 : r.result === '0-1' ? 0 : 0.5;
    if (r.mate !== null && r.mate !== undefined) return r.mate > 0 ? 1 : r.mate < 0 ? 0 : 0.5;
    return 0.5 + 0.5 * (2 / (1 + Math.exp(-0.00368208 * r.cp)) - 1);
  }
  function label(r) {
    if (!r) return '';
    if (r.over) return r.result;
    if (r.mate !== null && r.mate !== undefined) return (r.mate > 0 ? '+' : '-') + 'M' + Math.abs(r.mate);
    return (r.cp > 0 ? '+' : '') + (r.cp / 100).toFixed(1);
  }

  return { request, cancel, whiteShare, label };
})();
