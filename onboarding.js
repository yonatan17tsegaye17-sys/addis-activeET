// Bot onboarding: /start -> 3 quick questions -> Open app button.
module.exports = function register(bot, { supabase, upsertUser, appUrl }) {
  const PREF = [
    [['🏃 Running', 'RUNNING'], ['🚶 Walking', 'WALKING']],
    [['🚴 Cycling', 'CYCLING'], ['🥾 Hiking', 'HIKING']],
    [['⚽ Football', 'FOOTBALL'], ['🏋️ Gym', 'GYM']]
  ];
  const LVL = [[['Beginner', 'BEGINNER'], ['Regular', 'REGULAR'], ['Experienced', 'EXPERIENCED']]];
  const PREF_OK = ['RUNNING', 'WALKING', 'CYCLING', 'HIKING', 'FOOTBALL', 'GYM'];
  const LVL_OK = ['BEGINNER', 'REGULAR', 'EXPERIENCED'];

  const kb = (rows, key) => ({
    reply_markup: {
      inline_keyboard: rows.map((r) => r.map(([t, v]) => ({ text: t, callback_data: `${key}:${v}` })))
    }
  });
  const openApp = {
    reply_markup: { inline_keyboard: [[{ text: '⚡ OPEN ADDIS ACTIVE APP', web_app: { url: appUrl } }]] }
  };
  const setUser = (tgId, patch) => supabase.from('users').update(patch).eq('telegram_id', tgId);

  async function finish(ctx) {
    await setUser(ctx.from.id, { onboarded_at: new Date().toISOString() });
    return ctx.reply("You're all set! Tap below to open Addis Active.", openApp);
  }

  bot.start(async (ctx) => {
    const name = ctx.from.first_name || 'Explorer';
    let u = null;
    try {
      u = await upsertUser(ctx.from);
    } catch (e) {
      console.error('upsert on /start failed', e);
    }
    if (u && u.onboarded_at) return ctx.reply(`Welcome back, ${name}!`, openApp);
    await ctx.reply(`🇪🇹 Welcome to Addis Active, ${name}!\nDiscover Addis. Move Addis. Connect Addis.\n\nThree quick questions to get you started.`);
    return ctx.reply('1/3 · What activity do you prefer?', kb(PREF, 'pref'));
  });

  bot.action(/^pref:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!PREF_OK.includes(ctx.match[1])) return;
    await setUser(ctx.from.id, { preferred_activity: ctx.match[1] });
    return ctx.reply('2/3 · What is your current activity level?', kb(LVL, 'lvl'));
  });

  bot.action(/^lvl:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!LVL_OK.includes(ctx.match[1])) return;
    await setUser(ctx.from.id, { activity_level: ctx.match[1] });
    return ctx.reply(
      '3/3 · Optional: share your phone number so organizers can reach you about activities. It is never shown to other users.',
      {
        reply_markup: {
          keyboard: [[{ text: '📱 Share my number', request_contact: true }], [{ text: 'Skip for now' }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  });

  bot.on('contact', async (ctx) => {
    const c = ctx.message.contact;
    if (c && c.user_id === ctx.from.id) await setUser(ctx.from.id, { phone: c.phone_number });
    await ctx.reply('Thanks!', { reply_markup: { remove_keyboard: true } });
    return finish(ctx);
  });

  bot.hears('Skip for now', async (ctx) => {
    await ctx.reply('No problem.', { reply_markup: { remove_keyboard: true } });
    return finish(ctx);
  });
};
