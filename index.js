require('dotenv').config();
const { Client, AttachmentBuilder } = require('discord.js-selfbot-v13');
const random = require('@sefinek/random-animals');

const CONFIG = {
  allowedGuildId: process.env.ALLOWED_GUILD_ID,
  allowedChannelId: process.env.ALLOWED_CHANNEL_ID,
  cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS) || 45,
  replyChance: {
    mention: parseFloat(process.env.REPLY_CHANCE_MENTION) || 0.7,
    reply: parseFloat(process.env.REPLY_CHANCE_REPLY) || 0.6,
    normal: parseFloat(process.env.REPLY_CHANCE_NORMAL) || 0.15
  },
  selfTalkInterval: parseInt(process.env.SELF_TALK_INTERVAL) || 3600000,
  selfTalkChance: parseFloat(process.env.SELF_TALK_CHANCE) || 0.25,
  systemPrompt: process.env.SYSTEM_PROMPT || 'You are a 20-something human hanging out on Discord. No honorifics, casual speech only. Replies should be 2-3 lines max. Use endings like "~dashi", "~jan", "~ssho" moderately. Dont answer everything seriously. Brush things off sometimes. Lightly disagree or state your own opinion. Use "w" or "www" occasionally.'
};

const client = new Client({
  checkUpdate: false,
  syncStatus: true,
  ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
});

let lastReplyTime = 0;

async function getAIResponse(userMsg, history = []) {
  const ctx = history.slice(-5).map(m => `${m.author.username}: ${m.content}`).join('\n');
  const full = `${CONFIG.systemPrompt}\n[Conversation History]\n${ctx || 'none'}\n[User]\n${userMsg}\n[Reply]`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [{ role: 'system', content: full }, { role: 'user', content: userMsg }],
        temperature: 0.85,
        max_tokens: 120
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

async function generateSelfTalk() {
  const prompt = `You're a person casually chatting on Discord. Write one very casual, random thought or feeling you have right now. Rules: dont overthink it, use casual endings like "~dashi" or "~jan", it doesnt have to mean anything, 10-40 characters, punctuation can be sloppy, no emojis.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [
          { role: 'system', content: 'You are a casual person. Chat without overthinking.' },
          { role: 'user', content: prompt }
        ],
        temperature: 1.3,
        max_tokens: 50
      })
    });
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content?.trim() || null;
    if (text) {
      text = text.replace(/\n/g, ' ').replace(/^["「]|["」]$/g, '');
    }
    return text;
  } catch { return null; }
}

async function getAnimalImage(query) {
  try {
    let data;
    switch (query) {
      case 'cat': data = await random.cat(); break;
      case 'dog': data = await random.dog(); break;
      case 'fox': data = await random.fox(); break;
      case 'bird': data = await random.bird(); break;
      default: data = await random.cat(); break;
    }
    return data.message;
  } catch { return null; }
}

async function selfPost(channel) {
  if (!channel) return;
  if (Math.random() > CONFIG.selfTalkChance) return;

  const withImage = Math.random() < 0.3;

  try {
    if (withImage) {
      const animals = ['cat', 'dog', 'fox', 'bird'];
      const query = animals[Math.floor(Math.random() * animals.length)];
      const img = await getAnimalImage(query);
      if (img) {
        const caption = await generateSelfTalk();
        await channel.send({
          content: caption || '(image)',
          files: [new AttachmentBuilder(img)]
        });
        console.log(`[SELF] ${caption || 'image only'} (with image)`);
        return;
      }
    }

    const text = await generateSelfTalk();
    if (text) {
      await channel.send(text);
      console.log(`[SELF] ${text}`);
    }
  } catch (e) {
    console.error('[SELF ERR]', e.message);
  }
}

client.on('messageCreate', async (msg) => {
  if (msg.author.id === client.user.id) return;
  if (msg.guild?.id !== CONFIG.allowedGuildId) return;
  if (msg.channel.id !== CONFIG.allowedChannelId) return;
  if (msg.author.bot) return;

  const now = Date.now();
  if (now - lastReplyTime < CONFIG.cooldownSeconds * 1000) return;

  try {
    const recent = await msg.channel.messages.fetch({ limit: 3 });
    const sorted = recent.filter(m => !m.author.bot).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (sorted.size >= 2) {
      if (sorted.at(0).createdTimestamp - sorted.at(1).createdTimestamp < 2000) return;
      if (sorted.at(0).author.id === client.user.id) return;
    }
  } catch {}

  const isMention = msg.mentions.has(client.user.id);
  const isReply = msg.type === 'REPLY' && msg.reference?.messageId;
  let chance = CONFIG.replyChance.normal;
  if (isMention) chance = CONFIG.replyChance.mention;
  if (isReply) chance = CONFIG.replyChance.reply;
  if (new Date().getHours() >= 1 && new Date().getHours() <= 5) chance *= 0.2;
  if (Math.random() > chance) return;

  console.log(`[TRIG] ${msg.author.username}: ${msg.content.slice(0, 30)}`);
  await msg.channel.sendTyping();
  await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));

  const history = await msg.channel.messages.fetch({ limit: 10 });
  const ctxMsgs = history.filter(m => !m.author.bot).reverse();
  const reply = await getAIResponse(msg.content, ctxMsgs);
  if (!reply) return;

  await new Promise(r => setTimeout(r, Math.min(reply.length * 20, 3000) + Math.random() * 1000));
  await msg.reply(reply);
  lastReplyTime = Date.now();
  console.log(`[REPLY] ${reply.slice(0, 50)}`);
});

async function updatePresence() {
  try {
    const songs = [
      { details: 'めうめうぺったんたん！！', state: '芽兎めう', img: 'ab67706c0000da84abeeaae7c11c3455bc45d603' },
      { details: '地方創生☆チクワクティクス', state: '芽兎めう', img: 'ab67706c0000da84c0052dc7fb523a68affdb8f7' }
    ];
    const song = songs[Math.floor(Math.random() * songs.length)];
    const now = Date.now();

    await client.user.setPresence({
      activities: [
        {
          name: 'Spotify',
          type: 2,
          flags: 48,
          details: song.details,
          state: song.state,
          sync_id: '3btKs4ln57kQ46ALWdsvYi',
          assets: { large_image: `spotify:${song.img}` }
        },
        {
          name: 'U-NEXT',
          type: 3,
          application_id: '1447891267336802400',
          details: 'ひきこまり吸血鬼の悶々 第1話',
          state: '烈核解放',
          assets: { large_image: '1457346793753804925' },
          timestamps: { start: now - 300000, end: now + 1200000 }
        }
      ],
      status: 'online'
    });
  } catch (e) { console.error('[RPC ERR]', e.message); }
}

setInterval(async () => {
  const ch = client.channels.cache.get(CONFIG.allowedChannelId);
  await selfPost(ch);
}, CONFIG.selfTalkInterval);

client.once('ready', () => {
  console.log(`[READY] ${client.user.tag}`);
  updatePresence();
  setInterval(updatePresence, 30000);
});

client.login(process.env.DISCORD_TOKEN);
