// Health score 0-100: the average pass rate of each area that ran, so one area with many checks
// (for example 30 crawled pages) cannot hide a broken API.
export function healthScore(results) {
  const areas = {
    API: results.api || [],
    'User flows': results.ui?.tests || [],
    Pages: results.ui?.pages || [],
    'Other pages': results.crawl?.pages || [],
    Load: results.load ? [results.load] : [],
  };
  const parts = [];
  for (const [name, list] of Object.entries(areas)) {
    const counted = list.filter((x) => !x.skipped);
    if (!counted.length) continue;
    const passed = counted.filter((x) => x.passed).length;
    parts.push({ name, passed, total: counted.length, rate: passed / counted.length });
  }
  if (results.summary?.stopped) return { score: null, label: 'Stopped early', parts };
  if ((results.engineErrors || []).length) return { score: null, label: "Couldn't finish", parts };
  if (!parts.length) return { score: null, label: 'Nothing ran', parts };
  const score = Math.round((parts.reduce((a, p) => a + p.rate, 0) / parts.length) * 100);
  const label = score >= 90 ? 'Healthy' : score >= 70 ? 'Needs attention' : 'At risk';
  return { score, label, parts };
}
