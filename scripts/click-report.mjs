// 点击行为报告：跨全库聚合 click 事件，按时间线输出
// 用法：node scripts/click-report.mjs [daemon地址] [条数上限]
// 说明：daemon 的 /api/behaviors 需要 domain 参数，故先取站点清单再逐域查询。
const daemon = (process.argv[2] || 'http://127.0.0.1:8756').replace(/\/+$/, '');
const limit = Number(process.argv[3] || 60);

const get = async (p) => {
  const r = await fetch(daemon + p);
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
  return r.json();
};

const sites = await get('/api/sites');
const all = [];
for (const s of sites) {
  const { items } = await get(`/api/behaviors?domain=${encodeURIComponent(s.domain)}&type=click&limit=500`);
  for (const it of items || []) all.push({ ...it, domain: s.domain });
}
all.sort((a, b) => a.ts - b.ts);

const fmt = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const short = (sel) => {
  if (!sel) return '';
  const parts = sel.split(' > ');
  return parts.slice(-2).join(' > ');
};

// 按域名聚合
const byDomain = new Map();
for (const c of all) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);

console.log(`点击总数：${all.length}　涉及域名：${byDomain.size}`);
console.log('\n按域名分布：');
for (const [d, n] of [...byDomain].sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(30)} ${String(n).padStart(4)}`);

console.log(`\n点击时间线（最近 ${Math.min(limit, all.length)} 条）：`);
for (const c of all.slice(-limit)) {
  const text = (c.element && c.element.text ? c.element.text : '').replace(/\s+/g, ' ').slice(0, 26);
  const tag = c.element && c.element.tag ? c.element.tag.toLowerCase() : '';
  console.log(`  ${fmt(c.ts)}  ${c.domain.padEnd(24)} ${(text || '[' + tag + ']').padEnd(28)} ${short(c.selector)}`);
}
