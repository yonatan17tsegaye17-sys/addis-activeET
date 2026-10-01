const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Global memory stores for Phase 1
global.usersDB = global.usersDB || {};
global.participationsDB = global.participationsDB || [];

// Robust /start handler that ensures a text reply is always sent
bot.start(async (ctx) => {
  try {
    const user = ctx.from || {};
    const firstName = user.first_name || 'Explorer';
    
    global.usersDB[user.id] = {
      id: user.id,
      firstName: firstName,
      username: user.username || 'anonymous',
      joinedAt: new Date().toISOString()
    };

    await ctx.reply(
      `🇪🇹 Welcome to Addis Active, ${firstName}!\n\nMovement connects Addis Ababa. Discover routes, join communities, and track your progress.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ OPEN ADDIS ACTIVE APP", web_app: { url: "https://addis-active.vercel.app" } }]
          ]
        }
      }
    );
  } catch (err) {
    console.error('Error in /start handler:', err);
  }
});

// Vercel Serverless Function export
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle REAL JOIN API requests from Mini App
  if (req.url && req.url.includes('/api/join') && req.method === 'POST') {
    try {
      const { userId, firstName, activityId, activityName } = req.body || {};

      if (!userId || !activityId) {
        return res.status(400).json({ success: false, error: 'Missing user or activity data.' });
      }

      const existing = global.participationsDB.find(
        p => p.userId === userId && p.activityId === activityId
      );

      if (existing) {
        return res.status(200).json({ 
          success: true, 
          alreadyRegistered: true, 
          message: 'You are already registered for this activity!' 
        });
      }

      global.participationsDB.push({
        userId,
        firstName: firstName || 'Explorer',
        activityId,
        activityName,
        registeredAt: new Date().toISOString()
      });

      return res.status(200).json({ 
        success: true, 
        alreadyRegistered: false, 
        message: `✅ Registered successfully for ${activityName}!` 
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Handle incoming Telegram Webhook updates
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return res.status(200).send('OK');
  } 
  
  return res.status(200).json({ 
    status: 'Addis Active Engine Running', 
    registeredCount: global.participationsDB.length 
  });
};
