// Tiny synthesized sound set — no audio files to ship or load.
// Bullet clocks are unforgiving, so the low-time warning matters more than polish.

let ctx = null;
let enabled = true;

function audio() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip({ freq, duration = 0.08, type = 'sine', gain = 0.12, sweep = 0 }) {
  if (!enabled) return;
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  const now = ac.currentTime;

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), now + duration);

  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(gain, now + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(amp).connect(ac.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

export const sounds = {
  setEnabled(value) {
    enabled = value;
  },
  isEnabled() {
    return enabled;
  },
  /** Called from a click handler so browsers permit audio later on. */
  unlock() {
    audio();
  },
  move: () => blip({ freq: 320, duration: 0.06, type: 'triangle', gain: 0.1 }),
  capture: () => blip({ freq: 180, duration: 0.09, type: 'square', gain: 0.08, sweep: -60 }),
  check: () => blip({ freq: 660, duration: 0.12, type: 'triangle', gain: 0.11 }),
  lowTime: () => blip({ freq: 880, duration: 0.07, type: 'sine', gain: 0.13 }),
  end: () => {
    blip({ freq: 440, duration: 0.16, type: 'sine', gain: 0.1 });
    setTimeout(() => blip({ freq: 294, duration: 0.24, type: 'sine', gain: 0.1 }), 150);
  },
};
