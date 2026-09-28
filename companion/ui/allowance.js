/* Allowance as HP: observed numbers only. Missing data is explained, never drawn as an empty bar. */
const allowance = (() => {
  const names = { codex: 'Codex', claude: 'Claude' };
  const clock = seconds => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const weekday = seconds => new Date(seconds * 1000).toLocaleDateString([], { weekday: 'short' });
  const reset = (seconds, now) => !Number.isFinite(seconds) || seconds <= now ? '' : seconds - now < 86400 ? clock(seconds) : weekday(seconds);
  const age = seconds => seconds < 5400 ? `${Math.max(1, Math.round(seconds / 60))} min ago` : `${Math.round(seconds / 3600)} h ago`;
  // The games' HP colours: green above half, yellow down to a fifth, red below.
  const tone = left => left <= 0 ? 'out' : left <= 20 ? 'low' : left <= 50 ? 'mid' : 'high';
  function card(app, apps, connections, now) {
    const info = apps?.[app] || { connected: false }, link = connections?.[app] || {};
    if (!link.enabled || !info.connected) return { state: 'off', activity: 'off', found: Boolean(link.found) };
    const quota = info.quota || [];
    const five = quota.find(q => q.label === '5h') || quota[0];
    const week = quota.find(q => q.label === 'weekly' && q !== five);
    if (!five) {
      const note = app === 'codex' ? 'Shows up after a Codex reply that reports usage.'
        : link.usage_check?.enabled ? link.usage_check.problem || 'Asking Claude Code for its usage.'
          : link.status_line === false ? 'Claude Code shares this through a status line, which this install could not add.'
            : 'Terminal sessions share this live. For the Claude app, turn on the usage check in Settings.';
      return { state: 'missing', activity: info.activity, note };
    }
    const result = { state: five.stale ? 'stale' : 'ok', activity: info.activity, hp: five.remaining, tone: tone(five.remaining),
      window: five.label === '5h' ? '5 h' : five.label, reset: reset(five.resets_at, now) };
    if (week) Object.assign(result, { week: week.remaining, weekReset: reset(week.resets_at, now) });
    if (five.stale) result.note = `Last seen ${age(now - five.at)}`;
    return result;
  }
  // The desktop buddy stays quiet unless a current five-hour window is running low.
  function warning(apps) {
    const low = Object.entries(apps || {}).flatMap(([app, info]) => (info.quota || [])
      .filter(q => q.label === '5h' && !q.stale && q.remaining <= 20).map(q => ({ app, left: q.remaining })));
    low.sort((a, b) => a.left - b.left);
    return low.length ? `${names[low[0].app]} 5 h: ${low[0].left}% left` : '';
  }
  return { card, warning, tone, appName: app => names[app] || app };
})();
if (typeof module !== 'undefined') module.exports = allowance;
