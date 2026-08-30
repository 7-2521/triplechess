import { CLOCK_COUNT, formatMs, formatSpec } from '../shared/tc.js';

const LOW_TIME_MS = 10000;

/**
 * The three-clock stack for one player.
 *
 * The server sends a snapshot of every bank; we tick the running one down
 * locally between snapshots so the display stays smooth, then snap back to
 * the server's numbers whenever a fresh state arrives.
 */
export class ClockStack {
  constructor(root, color) {
    this.root = root;
    this.color = color;
    this.rows = [];
    this.snapshot = null;
    this.receivedAt = 0;
    this.lastLowBeepIndex = -1;
    this.onLowTime = null;

    root.classList.add('clock-stack');
    root.dataset.color = color;

    for (let i = 0; i < CLOCK_COUNT; i++) {
      const row = document.createElement('div');
      row.className = 'clock-row';
      row.dataset.index = String(i);

      const label = document.createElement('span');
      label.className = 'clock-label';

      const badge = document.createElement('span');
      badge.className = 'clock-badge';
      badge.textContent = String(i + 1);

      const spec = document.createElement('span');
      spec.className = 'clock-spec';

      label.append(badge, spec);

      const time = document.createElement('span');
      time.className = 'clock-time';

      const bar = document.createElement('div');
      bar.className = 'clock-bar';
      const fill = document.createElement('div');
      fill.className = 'clock-bar-fill';
      bar.appendChild(fill);

      row.append(label, time, bar);
      root.appendChild(row);
      this.rows.push({ row, spec, time, fill });
    }
  }

  update(state) {
    this.snapshot = state;
    this.receivedAt = performance.now();
    this.render();
  }

  /** Live value for one bank, extrapolated from the last server snapshot. */
  remaining(index) {
    const s = this.snapshot;
    if (!s) return 0;
    const stored = s.clocks[this.color][index];
    const isRunning = s.running === this.color && s.activeIndex[this.color] === index;
    if (!isRunning) return stored;
    return Math.max(0, stored - (performance.now() - this.receivedAt));
  }

  render() {
    const s = this.snapshot;
    if (!s) return;
    const activeIndex = s.activeIndex[this.color];
    const isRunning = s.running === this.color;

    for (let i = 0; i < CLOCK_COUNT; i++) {
      const { row, spec, time, fill } = this.rows[i];
      const left = this.remaining(i);
      const initial = s.spec[i].initial * 1000;

      spec.textContent = formatSpec(s.spec[i]);
      time.textContent = formatMs(left);

      const active = i === activeIndex;
      const running = active && isRunning;
      const low = running && left <= LOW_TIME_MS;

      row.classList.toggle('is-active', active);
      row.classList.toggle('is-running', running);
      row.classList.toggle('is-low', low);
      row.classList.toggle('is-out', left <= 0);

      fill.style.width = `${Math.max(0, Math.min(100, (left / initial) * 100))}%`;

      if (low && this.lastLowBeepIndex !== i) {
        this.lastLowBeepIndex = i;
        this.onLowTime?.();
      } else if (!low && this.lastLowBeepIndex === i) {
        this.lastLowBeepIndex = -1;
      }
    }
  }
}
