// Check how Prisma surfaces the telegram settings values
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.systemSetting
  .findMany({ where: { key: { in: ['telegram.bot_token', 'telegram.enabled', 'telegram.web_url'] } } })
  .then((rows) => {
    for (const r of rows) console.log(r.key, '| js type:', typeof r.value, '| String():', String(r.value).slice(0, 60));
    return p.$disconnect();
  })
  .catch((e) => { console.log('ERR', e.message); process.exit(1); });
