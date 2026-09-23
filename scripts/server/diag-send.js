const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const API = (t, m) => `https://api.telegram.org/bot${t}/${m}`;
(async () => {
  const a = await p.carAssignment.findUnique({
    where: { id: 'cab5b485-093b-4dda-bece-ca161037e07d' },
    include: {
      driver: true,
      vehicle: true,
      carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true } },
      request: { select: { docNumber: true, requester: { select: { fullName: true, employee: { select: { phone: true } } } } } },
    },
  });
  console.log('1. assignment found:', !!a);
  console.log('2. driver?.telegramChatId:', a && a.driver && a.driver.telegramChatId);
  console.log('3. carRequest present:', !!(a && a.carRequest));
  const token = (await p.systemSetting.findUnique({ where: { key: 'telegram.bot_token' } })).value;
  const enabled = (await p.systemSetting.findUnique({ where: { key: 'telegram.enabled' } })).value === 'true';
  console.log('4. token/enabled:', !!token, enabled);
  if (!a) return;
  const cr = a.carRequest;
  const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);
  const fmtTime = (d) => new Date(d).toISOString().slice(11, 16);
  const when = `${fmtDate(cr.startDate)} · ${fmtTime(cr.startDate)} – ${fmtTime(cr.endDate)} (${cr.timeSlot})`;
  const lines = [
    `🚗 *Car Assigned — ${a.request.docNumber}*`, ``,
    `📅 ${when}`,
    `🚙 ${a.vehicle.brandModel} · ${a.vehicle.vehicleNo}`,
    `📍 Pickup: ${cr.pickupLocation || '—'}`,
    `🗺 Destination: ${cr.destination}`,
    `👤 Requester: ${a.request.requester.fullName}${a.request.requester.employee?.phone ? ` (${a.request.requester.employee.phone})` : ''}`,
    cr.purpose ? `📝 ${cr.purpose}` : '', ``,
    `✅ လမ်းကြောင်း လက်ခံရန် "✓ Noted" နှိပ်ပါ`,
  ];
  const text = lines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .map((l) => l.replace(/\*(.*?)\*/g, '<b>$1</b>')).join('\n');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${cr.pickupLocation || '—'} to ${cr.destination}`)}`;
  const res = await fetch(API(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: a.driver.telegramChatId,
      text: `${text}\n🗺 <a href="${mapsUrl}">Open in Maps</a>`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: '✓ Noted', callback_data: `noted:${a.id}` }, { text: '🚦 Ready', callback_data: `arrived:${a.id}` }]] },
    }),
  });
  const j = await res.json();
  console.log('5. sendMessage →', JSON.stringify(j).slice(0, 160));
  if (j.ok) await p.carAssignment.update({ where: { id: a.id }, data: { telegramMessageId: String(j.result.message_id) } });
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
