// Direct probe: send a test message with the SAME code path (sendRaw → call sendMessage)
// to the bound chat, then report. This isolates whether Telegram delivery works at all.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const token = process.env.TG_TOKEN;
(async () => {
  const admins = await p.userRole.findMany({
    where: { role: { name: 'ADMINISTRATION' }, user: { status: 'ACTIVE', telegramChatId: { not: null } } },
    select: { user: { select: { username: true, telegramChatId: true } } },
  });
  console.log('bound admins:', JSON.stringify(admins.map(a => a.user.username)));
  for (const a of admins) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: a.user.telegramChatId,
        text: '🔧 <b>Probe</b> — Telegram approve flow delivery test',
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'wfa:approve:probe' }]] },
      }),
    });
    const j = await res.json();
    console.log(`probe → ${a.user.username}: ok=${j.ok} msg=${j.result?.message_id ?? j.description}`);
  }
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
