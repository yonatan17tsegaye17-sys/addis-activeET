const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Handle /start command with a button that launches the Mini App
bot.start((ctx) => {
  ctx.reply(
    "🇪🇹 Welcome to Addis Active!\n\nUse movement to discover, participate in, and connect with Addis Ababa.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏃‍♂️ OPEN ADDIS ACTIVE MINI APP", web_app: { url: "https://addis-active.vercel.app" } }]
        ]
      }
    }
  );
});

// Vercel serverless export
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } else {
    res.status(200).send('Addis Active Bot is running!');
  }
};
