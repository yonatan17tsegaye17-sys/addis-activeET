const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory / temporary store simulation for Phase 1 
// (Will map directly to Vercel Postgres / Supabase in the next micro-step)
global.usersDB = global.usersDB || {};
global.participationsDB = global.participationsDB || [];

// Handle /start command with user recognition
bot.start((ctx) => {
  const user = ctx.from;
  
  // Save or update user in our database layer
  global.usersDB[user.id] = {
    id: user.id,
    firstName: user.first_name || 'Explorer',
    username: user.username || 'anonymous',
    joinedAt: new Date().toISOString()
  };

  ctx.reply(
    `🇪🇹 Welcome to Addis Active, ${user.first_name}!\n\nMovement connects Addis Ababa. Discover routes, join communities, and track your progress.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚡ OPEN ADDIS ACTIVE APP", web_app: { url: "https://addis-active.vercel.app" } }]
        ]
      }
    }
  );
});

// Vercel serverless export handling bot webhook & API routes
module.exports = async (req, res) => {
  // Enable CORS for frontend API calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // API endpoint to handle REAL JOIN registrations from the Mini App
  if (req.url.startsWith('/api/join') && req.method === 'POST') {
    try {
      const { userId, firstName, activityId, activityName } = req.body;

      if (!userId || !activityId) {
        return res.status(400).json({ success: false, error: 'Missing user or activity data.' });
      }

      // Check for duplicate registration
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

      // Save real participation record
      const record = {
        userId,
        firstName: firstName || 'Explorer',
        activityId,
        activityName,
        registeredAt: new Date().toISOString()
      };

      global.participationsDB.push(record);

      return res.status(200).json({ 
        success: true, 
        alreadyRegistered: false, 
        message: `✅ Registered successfully for ${activityName}!` 
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Standard Telegram Webhook handler
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  } 
  
  return res.status(200).json({ status: 'Addis Active Engine Running', registeredCount: global.participationsDB.length });
};
