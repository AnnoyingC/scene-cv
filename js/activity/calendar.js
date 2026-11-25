export const sources = ['GitHub', 'Codex', 'Claude'];
const dayMs = 86400000;
const shortDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  weekday: 'short',
});
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export async function calendar(useLocal) {
  let snapshot = null;
  if (useLocal) {
    try {
      const r = await fetch(new URL('../../assets/activity-local/daily.json', import.meta.url), {
        cache: 'no-store',
      });
      if (r.ok) {
        const file = await r.json();
        if (/^\d{4}-\d{2}-\d{2}$/.test(file.asOf) && Number.isFinite(Date.parse(file.asOf)) && file.days)
          snapshot = file;
      }
    } catch {
      /* An offline personal preview can still show the labelled sample. */
    }
  }
  const end = new Date(snapshot?.asOf || new Date().toLocaleDateString('sv-SE'));
  const start = end.getTime() - (77 + end.getUTCDay()) * dayMs;
  const last = 77 + end.getUTCDay();
  function sample(i, source) {
    const wave = Math.sin((i + 1) * 91.13 + (source + 2) * 57.43) * 4375.37;
    const value = wave - Math.floor(wave);
    const threshold = (i % 7 === 0 || i % 7 === 6 ? 0.67 : 0.3) + source * 0.045;
    return value < threshold
      ? 0
      : Math.ceil(((value - threshold) / (1 - threshold)) * (source ? 1800000 : 11));
  }
  const days = Array.from({ length: last + 1 }, (_, i) => {
    const date = new Date(start + i * dayMs);
    const values = sources.map((source, k) => {
      if (!snapshot) return sample(i, k);
      const value = snapshot.days[date.toISOString().slice(0, 10)]?.[source.toLowerCase()];
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    });
    return { date, values };
  });
  const thresholds = sources.map((_, k) => {
    const counts = days
      .map((d) => d.values[k])
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    return [0.25, 0.5, 0.75].map((q) => counts[Math.floor((counts.length - 1) * q)]);
  });
  function level(i, k) {
    const n = days[i].values[k];
    return n === null ? -1 : n === 0 ? 0 : 1 + thresholds[k].filter((t) => n > t).length;
  }
  function reading(i, k, full = false) {
    const { date, values } = days[i],
      n = values[k];
    const unit = k === 0 ? (n === 1 ? ' contribution' : ' contributions') : ' tokens';
    return (
      shortDate.format(date) +
      ' · ' +
      (n === null ? 'No record' : (full ? n.toLocaleString('en-US') : compact.format(n)) + unit)
    );
  }
  return {
    days,
    last,
    level,
    reading,
    end,
    caption: snapshot ? 'Through ' + shortDate.format(end) : 'Sample data',
  };
}
