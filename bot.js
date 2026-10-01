const { Telegraf } = require('telegraf');

const token = process.env.BOT_TOKEN;
const bot = new Telegraf(token);

global.usersDB = global.usersDB || {};
global.participationsDB = global.participationsDB || [];

bot.start(async (ctx) => {
  const user = ctx.from || {};
  const firstName = user.first_name || 'Explorer';
  
  global.usersDB[user.id] = {
    id: user.id,
    firstName: firstName,
    username: user.username || 'anonymous',
    joinedAt: new Date().toISOString()
  };

  return ctx.reply(
    `🇪🇹 Welcome to Addis Active, ${firstName}!\n\nMovement connects Addis Ababa. Discover routes, join communities, and track your progress.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚡ OPEN ADDIS ACTIVE APP", web_app: { url: "https://addis-active.vercel.app" } }]
        ]
      }
    }
  );
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle REAL JOIN API requests
  if (req.url && req.url.includes('/api/join') && req.method === 'POST') {
    try {
      const { userId, firstName, activityId, activityName } = req.body || {};
      if (!userId || !activityId) {
        return res.status(400).json({ success: false, error: 'Missing data.' });
      }

      const existing = global.participationsDB.find(
        p => p.userId === userId && p.activityId === activityId
      );

      if (existing) {
        return res.status(200).json({ success: true, alreadyRegistered: true, message: 'Already registered!' });
      }

      global.participationsDB.push({
        userId,
        firstName: firstName || 'Explorer',
        activityId,
        activityName,
        registeredAt: new Date().toISOString()
      });

      return res.status(200).json({ success: true, alreadyRegistered: false, message: `✅ Joined ${activityName}!` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Handle Telegram Webhook
  if (req.method === 'POST' && req.body) {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('Update handling error:', err);
    }
    return res.status(200).send('OK');
  }

  return res.status(200).json({ status: 'Addis Active Engine Active', tokenConfigured: !!token });
};
