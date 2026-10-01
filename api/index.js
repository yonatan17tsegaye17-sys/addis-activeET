const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Handle the /start command and present the first Bertusew Run
bot.start((ctx) => {
  ctx.reply(
    "🇪🇹 Welcome to Addis Active!\n\nUse movement to discover and connect with Addis Ababa.\n\nNext Event: Entoto Bertusew Run\n📍 Location: Entoto Park\n",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏃‍♂️ JOIN BERTUSEW RUN", callback_data: "join_run" }]
        ]
      }
    }
  );
});

// Handle the JOIN button tap
bot.action('join_run', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("🎉 You're in! Your participation for the Bertusew Run has been saved. See you at the starting line!");
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
