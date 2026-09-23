// Probe the app's config() path + send a driver-view assignment demo message.
process.chdir('/app');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const rows = await p.systemSetting.findMany({ where: { key: { in: ['telegram.bot_token', 'telegram.enabled'] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const token = map['telegram.bot_token'] || null;
  const enabled = map['telegram.enabled'] === 'true';
  console.log('config():', { token: token ? 'SET' : null, enabled });

  const all = await p.carAssignment.findMany({
    orderBy: { assignedAt: 'desc' },
    take: 5,
    select: { id: true, carRequestId: true, driverId: true, driver: { select: { name: true, telegramChatId: true } } },
  });
  console.log('recent assignments:');
  for (const x of all) console.log(' ·', x.id.slice(0, 8), '| carRequestId:', x.carRequestId ? x.carRequestId.slice(0, 8) : 'NULL', '| driver:', x.driver?.name, x.driver?.telegramChatId ? `(chat ${x.driver.telegramChatId})` : '(unbound)');

  const a = await p.carAssignment.findFirst({
    where: { driver: { telegramChatId: { not: null } }, carRequest: { isNot: null } },
    orderBy: { assignedAt: 'desc' },
    include: {
      driver: true,
      vehicle: true,
      carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true } },
      request: { select: { docNumber: true, requester: { select: { fullName: true, employee: { select: { phone: true } } } } } },
    },
  });
  if (!a?.driver?.telegramChatId) { console.log('no eligible assignment with bound driver + carRequest'); return; }
  const cr = a.carRequest;
  console.log('sending for:', a.request.docNumber, '| driver:', a.driver.name, '| chat:', a.driver.telegramChatId);
  const fmt = (d) => new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Yangon', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const when = `${fmt(cr.startDate)} · ${fmt(cr.endDate)} (${cr.timeSlot})`;
  const phone = a.request.requester.employee?.phone;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    `🚗 <b>Car Assigned — ${a.request.docNumber}</b>`,
    ``,
    `📅 ${esc(when)}`,
    `🚙 ${esc(a.vehicle.brandModel)} · ${esc(a.vehicle.vehicleNo)}`,
    `📍 Pickup: ${esc(cr.pickupLocation || '—')}`,
    `🗺 Destination: ${esc(cr.destination)}`,
    `👤 Requester: ${esc(a.request.requester.fullName)}${phone ? ` (${esc(phone)})` : ''}`,
    cr.purpose ? `📝 ${esc(cr.purpose)}` : '',
    ``,
    `✅ လမ်းကြောင်း လက်ခံရန် "✓ Noted" နှိပ်ပါ`,
  ].filter((l) => l !== undefined).join('\n');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${cr.pickupLocation || ''} to ${cr.destination}`)}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: a.driver.telegramChatId,
      text: `${lines}\n🗺 <a href="${mapsUrl}">Open in Maps</a>`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[
        { text: '✓ Noted', callback_data: `noted:${a.id}` },
        { text: '🚦 Ready', callback_data: `arrived:${a.id}` },
      ]] },
    }),
  });
  const j = await res.json();
  console.log('sendMessage:', JSON.stringify(j).slice(0, 140));
  if (j.ok) {
    await p.carAssignment.update({ where: { id: a.id }, data: { telegramMessageId: String(j.result.message_id) } });
    console.log('telegramMessageId set →', j.result.message_id, '(buttons will edit THIS message)');
  }
  await p.$disconnect();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
