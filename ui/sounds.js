// Chess sound effects, synthesised with the Web Audio API (no audio files, nothing to download or license).
//   Sounds.play(kind)  kind: move | capture | castle | promote | success | error
//   Sounds.kindOf(m)   chess.js move object -> kind
//   Sounds.sets / setSet(name) / currentSet()   the selectable sound sets (Wood, Soft, Crisp, Glass, Retro)
//   Sounds.render(kind, ctx, dest, t)  schedules a sound on any AudioContext (the page uses a live one, tests an offline one)
// A piece landing is a short "knock": a sine thump whose pitch drops quickly, plus a burst of band-passed noise
// (the click of wood on wood). Captures are heavier and brighter; the other kinds are small variations on it.
const Sounds = (() => {
  let ctx = null, out = null, muted = false;
  try { muted = localStorage.getItem('soundMuted') === '1'; } catch (e) {}

  function noiseBuffer(c, seconds) {
    const n = Math.floor(c.sampleRate * seconds), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // body: thump loudness, click: noise loudness, freq: thump pitch (Hz), bright: noise centre (Hz), decay: seconds
  function knock(c, dest, t, o) {
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(o.freq * 1.7, t);
    osc.frequency.exponentialRampToValueAtTime(o.freq, t + 0.04);
    g.gain.setValueAtTime(o.body, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + o.decay + 0.02);

    const src = c.createBufferSource(), bp = c.createBiquadFilter(), ng = c.createGain();
    src.buffer = noiseBuffer(c, o.decay);
    bp.type = 'bandpass'; bp.frequency.value = o.bright; bp.Q.value = 0.9;
    ng.gain.setValueAtTime(o.click, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + o.decay * 0.55);
    src.connect(bp); bp.connect(ng); ng.connect(dest);
    src.start(t); src.stop(t + o.decay);
  }

  function tone(c, dest, t, freq, len, type, vol) {
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + len + 0.02);
  }

  // Sound sets: "knock" sets give the thump + click parameters for a move and a capture; "tone" sets play pitched blips instead.
  const SETS = {
    Wood:  { move: { freq: 150, body: 0.5, click: 0.45, bright: 1500, decay: 0.1 },
             capture: { freq: 120, body: 0.65, click: 0.7, bright: 2400, decay: 0.13 } },
    Soft:  { move: { freq: 105, body: 0.55, click: 0.14, bright: 650, decay: 0.12 },
             capture: { freq: 85, body: 0.7, click: 0.3, bright: 900, decay: 0.16 } },
    Crisp: { move: { freq: 230, body: 0.28, click: 0.85, bright: 3200, decay: 0.07 },
             capture: { freq: 190, body: 0.4, click: 1.0, bright: 4200, decay: 0.09 } },
    Glass: { tone: { move: [880, 0.14, 'sine', 0.22], capture: [587, 0.22, 'sine', 0.26] } },
    Retro: { tone: { move: [330, 0.07, 'square', 0.09], capture: [196, 0.13, 'square', 0.11] } },
  };
  let setName = 'Wood';
  try { const v = localStorage.getItem('soundSet'); if (v && SETS[v]) setName = v; } catch (e) {}

  function hit(c, dest, t, isCapture) {   // one piece landing, in the chosen sound set
    const set = SETS[setName];
    if (set.tone) {
      const [f, len, type, vol] = isCapture ? set.tone.capture : set.tone.move;
      tone(c, dest, t, f, len, type, vol);
      if (isCapture) tone(c, dest, t + 0.05, f * 1.5, len, type, vol * 0.8);
    } else if (isCapture) {
      knock(c, dest, t, set.capture);
      knock(c, dest, t + 0.035, { freq: set.capture.freq * 1.4, body: set.capture.body * 0.45, click: set.capture.click * 0.55, bright: set.capture.bright * 0.75, decay: set.capture.decay * 0.7 });
    } else {
      knock(c, dest, t, set.move);
    }
  }

  function render(kind, c, dest, t) {
    switch (kind) {
      case 'capture':
        hit(c, dest, t, true);
        break;
      case 'castle':
        hit(c, dest, t, false);
        hit(c, dest, t + 0.13, false);
        break;
      case 'promote':
        hit(c, dest, t, false);
        tone(c, dest, t + 0.06, 784, 0.18, 'sine', 0.2);
        tone(c, dest, t + 0.13, 1175, 0.26, 'sine', 0.2);
        break;
      case 'success':   // rising arpeggio C5 E5 G5 C6
        [523, 659, 784, 1046].forEach((f, i) => tone(c, dest, t + i * 0.09, f, 0.35, 'triangle', 0.2));
        break;
      case 'error': {   // low, short, dull buzz
        const osc = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(130, t); osc.frequency.exponentialRampToValueAtTime(95, t + 0.16);
        lp.type = 'lowpass'; lp.frequency.value = 420;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(lp); lp.connect(g); g.connect(dest);
        osc.start(t); osc.stop(t + 0.2);
        break;
      }
      default:
        hit(c, dest, t, false);
    }
  }

  function live() {   // created on first use: browsers only allow audio after a user gesture (a drag counts)
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      out = ctx.createGain(); out.gain.value = 0.8; out.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function play(kind) {
    if (muted) return;
    try { const c = live(); if (c) render(kind, c, out, c.currentTime + 0.005); } catch (e) {}
  }

  // chess.js 0.10.3 move object: flags 'c' capture, 'e' en passant, 'k'/'q' castling, 'p' promotion; san ends in + or #
  function kindOf(m) {
    if (!m) return 'move';
    if (m.flags.includes('p')) return 'promote';
    if (m.flags.includes('k') || m.flags.includes('q')) return 'castle';
    if (m.flags.includes('c') || m.flags.includes('e')) return 'capture';
    return 'move';
  }

  function setMuted(v) { muted = !!v; try { localStorage.setItem('soundMuted', muted ? '1' : '0'); } catch (e) {} }

  function setSet(name) { if (!SETS[name]) return; setName = name; try { localStorage.setItem('soundSet', name); } catch (e) {} }

  return { play, kindOf, render, setMuted, isMuted: () => muted, sets: Object.keys(SETS), setSet, currentSet: () => setName };
})();
