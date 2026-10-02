// Bot onboarding: /start -> pick activities (multi) -> level -> optional phone -> Open app.
module.exports = function register(bot, { supabase, upsertUser, appUrl }) {
  const PREF = [
    ['🏃 Run', 'RUNNING'], ['🚶 Walk', 'WALKING'],
    ['🚴 Bike', 'CYCLING'], ['🥾 Hike', 'HIKING'],
    ['🏊 Swim', 'SWIMMING'], ['⚽ Football', 'FOOTBALL'],
    ['🏋️ Outdoor strength', 'STRENGTH'], ['💪 Gym', 'GYM']
  ];
  const PREF_OK = PREF.map((p) => p[1]);
  const LVL = [[['Beginner', 'BEGINNER'], ['Regular', 'REGULAR'], ['Experienced', 'EXPERIENCED']]];
  const LVL_OK = ['BEGINNER', 'REGULAR', 'EXPERIENCED'];

  const openApp = {
    reply_markup: { inline_keyboard: [[{ text: '⚡ OPEN ADDIS ACTIVE APP', web_app: { url: appUrl } }]] }
  };
  const setUser = (tgId, patch) => supabase.from('users').update(patch).eq('telegram_id', tgId);
  const getSel = async (tgId) => {
    const { data } = await supabase.from('users').select('preferred_activity').eq('telegram_id', tgId).maybeSingle();
    return ((data && data.preferred_activity) || '').split(',').filter((x) => PREF_OK.includes(x));
  };
  const prefKb = (sel) => {
    const btn = ([t, v]) => ({ text: (sel.includes(v) ? '✅ ' : '') + t, callback_data: `pref:${v}` });
    const rows = [];
    for (let i = 0; i < PREF.length; i += 2) rows.push(PREF.slice(i, i + 2).map(btn));
    rows.push([{ text: sel.length ? `Done (${sel.length} selected) ➜` : 'Pick at least one', callback_data: 'pref:DONE' }]);
    return { inline_keyboard: rows };
  };
  const askPref = async (ctx) =>
    ctx.reply('1/3 · What activities do you enjoy? Tap all that apply, then Done.', {
      reply_markup: prefKb(await getSel(ctx.from.id))
    });

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
    if (u && u.onboarded_at) return ctx.reply(`Welcome back, ${name}! (Send /setup to change your answers.)`, openApp);
    await ctx.reply(`🇪🇹 Welcome to Addis Active, ${name}!\nDiscover Addis. Move Addis. Connect Addis.\n\nThree quick questions to get you started.`);
    return askPref(ctx);
  });

  bot.command('setup', async (ctx) => {
    try { await upsertUser(ctx.from); } catch (e) { console.error(e); }
    return askPref(ctx);
  });

  bot.action(/^pref:(\w+)$/, async (ctx) => {
    const v = ctx.match[1];
    const sel = await getSel(ctx.from.id);
    if (v === 'DONE') {
      if (!sel.length) return ctx.answerCbQuery('Pick at least one activity');
      await ctx.answerCbQuery();
      return ctx.reply('2/3 · What is your current activity level?', {
        reply_markup: { inline_keyboard: LVL.map((r) => r.map(([t, k]) => ({ text: t, callback_data: `lvl:${k}` }))) }
      });
    }
    if (!PREF_OK.includes(v)) return ctx.answerCbQuery();
    const next = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
    await setUser(ctx.from.id, { preferred_activity: next.join(',') });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(prefKb(next)); } catch (e) { /* unchanged */ }
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
