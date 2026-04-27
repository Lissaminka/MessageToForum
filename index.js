import { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: ['MESSAGE', 'CHANNEL', 'REACTION']
});

const FORUM_USERNAME = process.env.FORUM_USERNAME;
const FORUM_PASSWORD = process.env.FORUM_PASSWORD;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const DEBUG = process.env.DEBUG === 'true';

const ENABLE_MIN_LENGTH_FILTER = process.env.ENABLE_MIN_LENGTH_FILTER === 'true';
const MIN_MESSAGE_LENGTH = parseInt(process.env.MIN_MESSAGE_LENGTH || '1500', 10);

const DEFAULT_THREAD_ID = '794';

const BOARDS = [
  "https://forum.theunity.de/board/4-news-questions/",
  "https://forum.theunity.de/board/9-le-café-unité/",
  "https://forum.theunity.de/board/11-politik-gesellschaft/",
  "https://forum.theunity.de/board/10-out-of-space/",
  "https://forum.theunity.de/board/13-entartete-kunst/",
  "https://forum.theunity.de/board/14-texte-lyrics/",
  "https://forum.theunity.de/board/15-gegenwelt/",
  "https://forum.theunity.de/board/19-my-story/",
  "https://forum.theunity.de/board/27-eigene-projekte/",
  "https://forum.theunity.de/board/22-mensa/",
  "https://forum.theunity.de/board/23-public/",
  "https://forum.theunity.de/board/26-müllhalde/"
];

let browser;
let page;
let crawlPage;

let THREAD_CACHE = [];
let THREAD_STATS = new Map();
let LAST_UPDATE = 0;

// Speichert für jeden Nutzer die Daten der Nachricht, auf die reagiert wurde
const postboxSessions = new Map(); // userId -> { messageId, content, author, channelId }

// Einfache serielle Warteschlange für Puppeteer-Aktionen
let taskQueue = Promise.resolve();
const FLOOD_COOLDOWN_MS = 11000; // 11 Sekunden (10 s Forum-Cooldown + 1 s Puffer)

function enqueue(fn) {
  const task = taskQueue.then(async () => {
    const result = await fn();
    await sleep(FLOOD_COOLDOWN_MS);
    return result;
  });
  taskQueue = task.catch(() => {});
  return task;
}

// Mapping Discord-Message-ID → { forumPostId, threadId }
const postMapping = new Map();
const MAPPING_FILE = './cache/post-mapping.json';

function loadMapping() {
  try {
    const data = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
    for (const [key, value] of Object.entries(data)) {
      postMapping.set(key, value);
    }
    console.log(`Mapping geladen: ${postMapping.size} Einträge`);
  } catch {
    console.log('Mapping geladen: 0 Einträge');
    saveMapping(); // leere Datei anlegen
  }
}

function saveMapping() {
  const obj = Object.fromEntries(postMapping);
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(obj, null, 2));
}

function addMapping(discordMessageId, forumPostId, threadId, postUrl) {
  if (!discordMessageId || !forumPostId) return;
  postMapping.set(discordMessageId, { forumPostId, threadId, postUrl });
  saveMapping();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function convertHtmlToBBCode(html) {
  let bb = html;

  bb = bb.replace(/<strong>(.*?)<\/strong>/gi, '[b]$1[/b]');
  bb = bb.replace(/<b>(.*?)<\/b>/gi, '[b]$1[/b]');
  bb = bb.replace(/<em>(.*?)<\/em>/gi, '[i]$1[/i]');
  bb = bb.replace(/<i>(.*?)<\/i>/gi, '[i]$1[/i]');
  bb = bb.replace(/<u>(.*?)<\/u>/gi, '[u]$1[/u]');
  bb = bb.replace(/<p>(.*?)<\/p>/gi, '$1\n');
  bb = bb.replace(/<br\s*\/?>/gi, '\n');
  bb = bb.replace(/<\/?[^>]+(>|$)/g, '');

  return bb.trim();
}

function buildForumMessage({ author, message, sourceName, replyText = '' }) {
  const now = new Date();

  const timestamp = now.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const source = sourceName ? ` in #${sourceName}` : '';

  let forumMessage = `
<strong>${author} schrieb am ${timestamp}${source}:</strong>

${replyText}${message}
`;

  return convertHtmlToBBCode(forumMessage).replace(/\n/g, '\n\n');
}

function getThreadUrl(threadId) {
  return `https://forum.theunity.de/index.php?thread/${threadId}/`;
}

function extractForumPostId(url) {
  const fragmentMatch = url.match(/#post(\d+)/);
  if (fragmentMatch) return fragmentMatch[1];
  const paramMatch = url.match(/[?&]postID=(\d+)/);
  if (paramMatch) return paramMatch[1];
  return null;
}

function trackThreadUsage(threadId) {
  const now = Date.now();

  const existing = THREAD_STATS.get(threadId) || {
    id: threadId,
    useCount: 0,
    lastUsed: 0
  };

  existing.useCount += 1;
  existing.lastUsed = now;

  THREAD_STATS.set(threadId, existing);
}

function scoreThread(threadName, query, threadId) {
  const name = threadName.toLowerCase();
  const q = query.toLowerCase();

  let score = 0;

  if (name === q) score += 1000;
  else if (name.startsWith(q)) score += 500;
  else if (name.includes(q)) score += 100;

  const stats = THREAD_STATS.get(threadId);
  if (stats) {
    const recency = Math.max(
      0,
      1 - (Date.now() - stats.lastUsed) / (1000 * 60 * 60 * 24 * 7)
    );

    const freq = Math.log1p(stats.useCount);

    score += recency * 300;
    score += freq * 150;
  }

  return score;
}

function getThreadMeta(threadId) {
  return THREAD_CACHE.find(t => t.id === threadId) || null;
}

async function loginToForum() {
  browser = await puppeteer.launch({
    headless: !DEBUG,
    slowMo: DEBUG ? 30 : 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  page = await browser.newPage();
  crawlPage = await browser.newPage();

  await page.bringToFront();

  await page.goto('https://forum.theunity.de/', {
    waitUntil: 'networkidle2'
  });

  await page.bringToFront();

  await page.waitForSelector('a.loginLink', { timeout: 15000 });

  await page.evaluate(() => {
    const el = document.querySelector('a.loginLink');
    if (el) el.click();
  });

  await page.waitForSelector('input#username', {
    visible: true,
    timeout: 15000
  });

  await page.type('input#username', FORUM_USERNAME, { delay: 10 });
  await page.type('input[name="password"]', FORUM_PASSWORD, { delay: 10 });

  const submitButton = await page.waitForSelector('input[type="submit"]', {
    visible: true,
    timeout: 15000
  });

  await Promise.all([
    submitButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
  ]);

  await page.bringToFront();
}

async function fastInsert(text) {
  try {
    await page.evaluate((text) => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return;

      editor.focus();

      const data = new DataTransfer();
      data.setData('text/plain', text);

      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true
      });

      editor.dispatchEvent(event);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, text);

    return true;
  } catch {
    return false;
  }
}

async function postToForum(message, author, threadId, discordMessage, meta = null) {
  let safeThreadId = DEFAULT_THREAD_ID;

  try {
    const targetThreadId = threadId || DEFAULT_THREAD_ID;

    safeThreadId = String(targetThreadId).match(/^\d+$/)
      ? targetThreadId
      : DEFAULT_THREAD_ID;

    await page.goto(getThreadUrl(safeThreadId), {
      waitUntil: 'networkidle2'
    });

    const now = new Date();

    const timestamp = now.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    let replyText = '';

    try {
      let refMessage = null;

      try {
        const refId = discordMessage?.reference?.messageId;

        if (refId) {
          refMessage = await discordMessage.channel.messages
            .fetch(refId)
            .catch(() => null);

          if (DEBUG) {
            console.log("FETCHED REPLY:", refMessage?.content);
          }
        }
      } catch (e) {
        if (DEBUG) {
          console.log("reply fetch failed:", e);
        }
      }

      if (refMessage?.content) {
        const short = refMessage.content.slice(0, 300);
        const suffix = refMessage.content.length > 300 ? '...' : '';

        replyText =
`[b]Antwort auf ${refMessage.author?.username ?? 'Unbekannt'}:[/b]

"${convertHtmlToBBCode(short)}${suffix}"

`;
      }
    } catch (err) {
      console.error("Reply extraction failed:", err);
    }

    const forumMessage = buildForumMessage({
      author,
      message,
      sourceName: discordMessage?.channel?.name,
      replyText
    });

    const editor = await page.waitForSelector('[contenteditable="true"]', {
      visible: true
    });

    await editor.click();
    await sleep(150);

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    const success = await fastInsert(forumMessage);

    if (!success) {
      await page.keyboard.type(forumMessage, { delay: 2 });
    }

    await sleep(300);

    const submitButton = await page.waitForSelector(
      'button.buttonPrimary[data-type="save"]',
      { visible: true }
    );

    await submitButton.click();

    // Warten auf automatische Weiterleitung
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });

    let forumPostId = null;
    let postUrl = null;

    // postID aus aktueller URL extrahieren
    const currentUrl = page.url();
    const urlMatch = currentUrl.match(/[?&]postID=(\d+)/);
    if (urlMatch) {
      forumPostId = urlMatch[1];
      postUrl = currentUrl;
    } else {
      // Fallback: letzten Share-Button verwenden
      const shareLinkSelector = 'a.wsShareButton[href*="postID="]';
      await page.waitForSelector(shareLinkSelector, { visible: true, timeout: 10000 });
      const linkData = await page.evaluate((selector) => {
        const links = document.querySelectorAll(selector);
        if (links.length === 0) return null;
        const lastLink = links[links.length - 1];
        const url = new URL(lastLink.href);
        return {
          postId: url.searchParams.get('postID') || null,
          href: lastLink.href
        };
      }, shareLinkSelector);
      if (linkData) {
        forumPostId = linkData.postId;
        postUrl = linkData.href;
      }
    }

    console.log(`[ERFOLG] Nachricht von ${author} in Thread ${safeThreadId} gepostet.`);
    console.log(`         Link: ${getThreadUrl(safeThreadId)}`);
    console.log(`         Zeit : ${new Date().toLocaleString('de-DE')}`);

    return { threadUrl: getThreadUrl(safeThreadId), threadId: safeThreadId, forumPostId, postUrl };

  } catch (err) {
    console.error("Post Fehler:", err);
    console.error(`[FEHLER] Nachricht von ${author} konnte nicht in Thread ${threadId} gepostet werden.`);

    return { threadUrl: getThreadUrl(safeThreadId), threadId: safeThreadId, forumPostId: null, postUrl: null };
  }
}

function getBoardCategoryFromUrl(url) {
  const match = url.match(/board\/(\d+-[^/]+)\//);
  if (!match) return "?";

  const key = decodeURIComponent(match[1]);

  const map = {
    "4-news-questions": "News & Questions",
    "9-le-café-unité": "Le café unité",
    "11-politik-gesellschaft": "Politik & Gesellschaft",
    "10-out-of-space": "Out of space",
    "13-entartete-kunst": "Entartete Kunst",
    "14-texte-lyrics": "Texte & Lyrics",
    "15-gegenwelt": "Gegenwelt",
    "19-my-story": "My Story",
    "27-eigene-projekte": "Eigene Projekte",
    "22-mensa": "Mensa",
    "23-public": "Public",
    "26-müllhalde": "Müllhalde"
  };

  return map[key] || key;
}

async function extractThreadsFromPage() {
  return await crawlPage.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="thread/"]'));
    const map = new Map();

    for (const a of links) {
      const match = a.href.match(/thread\/(\d+)/);
      if (!match) continue;

      const id = match[1];
      const name = a.textContent.trim();

      if (!name || name.length < 3) continue;

      if (!map.has(id)) {
        map.set(id, { id, name });
      }
    }

    return Array.from(map.values());
  });
}

async function crawlBoard(boardUrl, maxPages = 2) {
  const threads = new Map();
  let currentUrl = boardUrl;
  let pages = 0;

  while (currentUrl && pages < maxPages) {
    pages++;

    await crawlPage.goto(currentUrl, { waitUntil: 'networkidle2' });

    const pageThreads = await extractThreadsFromPage();

    const boardName = getBoardCategoryFromUrl(boardUrl);

    for (const t of pageThreads) {
      threads.set(t.id, {
        ...t,
        board: boardName
      });
    }

    const nextUrl = await crawlPage.evaluate(() => {
      const next = document.querySelector('a.pagination__link[rel="next"]');
      return next ? next.href : null;
    });

    currentUrl = nextUrl;
  }

  return Array.from(threads.values());
}

async function incrementalRefresh() {
  const existing = new Map(THREAD_CACHE.map(t => [t.id, t]));
  let newCount = 0;

  for (const board of BOARDS) {
    try {
      const threads = await crawlBoard(board, 2);

      for (const t of threads) {
        if (!existing.has(t.id)) {
          existing.set(t.id, t);
          newCount++;
        }
      }
    } catch {
      // Fehler beim Crawlen eines Boards ignorieren, mit nächstem fortfahren
    }
  }

  THREAD_CACHE = Array.from(existing.values());
  LAST_UPDATE = Date.now();

  fs.writeFileSync(
    './cache/threads.json',
    JSON.stringify({
      threads: THREAD_CACHE,
      stats: Array.from(THREAD_STATS.values())
    }, null, 2)
  );

  console.log(`Increment fertig -> Neu: ${newCount}, Gesamt: ${THREAD_CACHE.length}`);
}

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync('./cache/threads.json', 'utf-8'));

    THREAD_CACHE = data.threads || [];
    const stats = data.stats || [];

    for (const s of stats) {
      THREAD_STATS.set(s.id, s);
    }

    console.log(`Cache geladen: ${THREAD_CACHE.length}`);
  } catch {
    // Cache existiert noch nicht, wird beim nächsten Refresh erstellt
  }
}

async function refreshThreadsIfNeeded() {
  if (Date.now() - LAST_UPDATE < 5 * 60 * 1000) return;
  await incrementalRefresh();
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await loginToForum();
  loadCache();
  loadMapping();
  // Sofortige erste Aktualisierung (falls Cache veraltet oder leer)
  await refreshThreadsIfNeeded();
  // Periodische Aktualisierung alle 5 Minuten
  setInterval(() => {
    refreshThreadsIfNeeded();
  }, 5 * 60 * 1000);
  console.log(`Thread-Cache wird alle 5 Minuten aktualisiert.`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (DEBUG) {
    console.log("CONTENT:", message.content);
    console.log("REFERENCE:", message.reference);
    console.log("REFERENCED MESSAGE:", message.referencedMessage);
  }

  const enabled = ENABLE_MIN_LENGTH_FILTER;
  const minLen = message.content.length >= MIN_MESSAGE_LENGTH;

  // Reagieren, wenn der Filter aktiviert ist und Nachricht lang genug ist
  if (!enabled || !minLen) return;

  // Button zum Übertragen der Nachricht ins Forum
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`post_long:${message.id}`)
        .setLabel('📬 Beitrag posten')
        .setStyle(ButtonStyle.Primary)
    );

  await message.reply({
    content: `Lange Nachricht erkannt! Möchtest du diesen Beitrag ins Forum übertragen?`,
    components: [row],
  });
});

// ========== Postbox‑Workflow über :postbox:‑Reaktion starten ==========
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '📮') return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const message = reaction.message;

    // Session anlegen
    postboxSessions.set(user.id, {
      messageId: message.id,
      content: message.content,
      author: message.author.username,
      channelId: message.channel.id,
      channelName: message.channel.name
    });

    // Ephemeral-Button im Kanal senden
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`postbox_start:${message.id}`)
          .setLabel('📬 Beitrag posten')
          .setStyle(ButtonStyle.Primary)
      );

    await message.reply({
      content: `<@${user.id}>, möchtest du diesen Beitrag ins Forum übertragen?`,
      components: [row],
      allowedMentions: { users: [user.id] }
    });

    await reaction.users.remove(user.id);
  } catch (error) {
    console.error('Fehler beim Starten des Postbox-Workflows:', error);
    try {
      await message.channel.send({
        content: `<@${user.id}> ❌ Etwas ist schiefgelaufen.`
      });
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {

  // ========== Bestehender Autocomplete‑Code ==========
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused();
    const choices = THREAD_CACHE;

    const scored = choices
      .map(t => ({
        name: `[${t.board}] ${t.name}`,
        value: t.id,
        score: scoreThread(t.name, focused, t.id)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    await interaction.respond(
      scored.map(c => ({
        name: c.name.slice(0, 100),
        value: c.value
      }))
    );

    return;
  }

  // ========== Bestehende Slash‑Commands ==========
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply();

    const message = interaction.options.getString('message');
    const author = interaction.user.username;

    if (interaction.commandName === 'posttoforum-reply') {

      const thread = interaction.options.getString('thread');
      const meta = THREAD_CACHE.find(t => t.id === thread);

      const result = await enqueue(() => postToForum(
        message,
        author,
        thread,
        interaction,
        meta
      ));

      await interaction.editReply(
        `<@${interaction.user.id}> Nachricht erfolgreich ins Forum übertragen!\n\n` +
        `[**Thread:** ${meta?.name || thread}, **Kategorie:** ${meta?.board || "unbekannt"}, **Link:** ${result.threadUrl}]`
      );

      if (thread) trackThreadUsage(thread);
    }

    if (interaction.commandName === 'posttoforum-new') {

      const category = interaction.options.getString('category');
      const title = interaction.options.getString('threadname');
      const tagsRaw = interaction.options.getString('tags');

      const categoryIdMap = {
        "News & Questions": "4",
        "Le café unité": "9",
        "Politik & Gesellschaft": "11",
        "Out of space": "10",
        "Entartete Kunst": "13",
        "Texte & Lyrics": "14",
        "Gegenwelt": "15",
        "My Story": "19",
        "Eigene Projekte": "27",
        "Mensa": "22",
        "Public": "23",
        "Müllhalde": "26"
      };

      let tags = [];

      if (tagsRaw) {
        tags = tagsRaw
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
          .map(t => t.slice(0, 29));

        if (tags.length < 1) {
          await interaction.editReply("Mindestens 1 Tag erforderlich.");
          return;
        }

        if (tags.length > 10) tags = tags.slice(0, 10);
      } else {
        await interaction.editReply("Mindestens 1 Tag erforderlich.");
        return;
      }

      const categoryId = categoryIdMap[category];
      if (!categoryId) {
        await interaction.editReply("Ungueltige Kategorie.");
        return;
      }

      const finalUrl = await enqueue(async () => {
        await page.goto(`https://forum.theunity.de/thread-add/${categoryId}/`, {
          waitUntil: 'networkidle2'
        });

        const titleInput = await page.waitForSelector('#subject', { visible: true });
        await titleInput.type(title, { delay: 10 });

        const tagInput = await page.waitForSelector('#tagSearchInput', { visible: true });

        for (const tag of tags) {
          await tagInput.click();
          await page.keyboard.type(tag, { delay: 10 });
          await page.keyboard.press('Comma');
          await sleep(120);
        }

        const editor = await page.waitForSelector('[contenteditable="true"]', {
          visible: true
        });

        await editor.click();
        await sleep(150);

        const fullMessage = buildForumMessage({
          author,
          message,
          sourceName: interaction.channel?.name
        });

        const success = await fastInsert(fullMessage);

        if (!success) {
          await page.keyboard.type(fullMessage, { delay: 2 });
        }

        await sleep(300);

        const submitButton = await page.waitForSelector('input[value="Absenden"]', {
          visible: true
        });

        await Promise.all([
          submitButton.click(),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
        ]);

        return page.url();
      });

      console.log(`[ERFOLG] Neuer Thread von ${author} erstellt.`);
      console.log(`         Titel    : ${title}`);
      console.log(`         Kategorie: ${category}`);
      console.log(`         Zeit     : ${new Date().toLocaleString('de-DE')}`);

      await interaction.editReply(
        `<@${interaction.user.id}> Thread erfolgreich erstellt!\n\n[**Titel:** ${title}, **Kategorie:** ${category}, **Link:** ${finalUrl}]`
      );
    }

    return;
  }

  // ========== Button für Postbox‑Start ==========
  if (interaction.isButton()) {
    // Button von langen Nachrichten
    if (interaction.customId.startsWith('post_long:')) {
      const messageId = interaction.customId.split(':')[1];
      const originalMessage = await interaction.channel.messages.fetch(messageId).catch(() => null);
      if (!originalMessage) {
        await interaction.reply({ content: '❌ Die ursprüngliche Nachricht wurde nicht gefunden.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Session anlegen (gleiches Format wie bei 📮)
      postboxSessions.set(interaction.user.id, {
        messageId: originalMessage.id,
        content: originalMessage.content,
        author: originalMessage.author.username,
        channelId: originalMessage.channel.id,
        channelName: originalMessage.channel.name
      });

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`postbox_action:${originalMessage.id}`)
            .setPlaceholder('Was möchtest du tun?')
            .addOptions([
              { label: 'Neuen Thread erstellen', value: 'new' },
              { label: 'Thread antworten', value: 'reply' }
            ])
        );

      await interaction.reply({
        content: '📬 Wähle eine Aktion:',
        components: [row],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.customId.startsWith('postbox_start:')) {
      const messageId = interaction.customId.split(':')[1];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen.', flags: MessageFlags.Ephemeral });
        return;
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`postbox_action:${messageId}`)
            .setPlaceholder('Was möchtest du tun?')
            .addOptions([
              { label: 'Neuen Thread erstellen', value: 'new' },
              { label: 'Thread antworten', value: 'reply' }
            ])
        );

      await interaction.reply({
        content: '📬 Wähle eine Aktion:',
        components: [row],
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  // ========== Select‑Menü für Postbox‑Workflow ==========
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;

    // Erstes Menü: Aktion wählen (new / reply)
    if (customId.startsWith('postbox_action:')) {
      const messageId = customId.split(':')[1];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen oder ungültig.', flags: MessageFlags.Ephemeral });
        return;
      }

      const action = interaction.values[0];

      if (action === 'new') {
        // Menü für Kategorieauswahl
        const categoryIdMap = {
          "News & Questions": "4",
          "Le café unité": "9",
          "Politik & Gesellschaft": "11",
          "Out of space": "10",
          "Entartete Kunst": "13",
          "Texte & Lyrics": "14",
          "Gegenwelt": "15",
          "My Story": "19",
          "Eigene Projekte": "27",
          "Mensa": "22",
          "Public": "23",
          "Müllhalde": "26"
        };

        const categoryOptions = Object.keys(categoryIdMap).map(name => ({
          label: name,
          value: name
        }));

        const row = new ActionRowBuilder()
          .addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`postbox_new_category:${messageId}`)
              .setPlaceholder('Wähle eine Kategorie')
              .addOptions(categoryOptions)
          );

        await interaction.reply({
          content: '📂 **Neuen Thread erstellen**\nWähle die Kategorie:',
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      } else if (action === 'reply') {
        // Modal für Suchbegriff öffnen
        const modal = new ModalBuilder()
          .setCustomId(`postbox_reply_search:${messageId}`)
          .setTitle('Thread suchen');

        const input = new TextInputBuilder()
          .setCustomId('searchQuery')
          .setLabel('Thread‑Name oder Stichwort')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('z. B. "Unity News"')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        await interaction.showModal(modal);
      }
    }

    // Kategorie für neuen Thread gewählt
    else if (customId.startsWith('postbox_new_category:')) {
      const messageId = customId.split(':')[1];
      const category = interaction.values[0];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Modal für Titel und Tags
      const modal = new ModalBuilder()
        .setCustomId(`postbox_new_details:${messageId}:${category}`)
        .setTitle('Neuer Thread – Details');

      const titleInput = new TextInputBuilder()
        .setCustomId('threadTitle')
        .setLabel('Titel des Threads')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const tagsInput = new TextInputBuilder()
        .setCustomId('threadTags')
        .setLabel('Tags (kommagetrennt)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('z. B. Unity, Diskussion, News')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(tagsInput)
      );

      await interaction.showModal(modal);
    }

    // Auswahl eines Threads nach Suche (reply)
    else if (customId.startsWith('postbox_reply_select:')) {
      const messageId = customId.split(':')[1];
      const threadId = interaction.values[0];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const meta = THREAD_CACHE.find(t => t.id === threadId);
      const result = await enqueue(() => postToForum(
        session.content,
        session.author,
        threadId,
        { channel: { name: session.channelName } },
        meta
      ));
      addMapping(session.messageId, result.forumPostId, threadId, result.postUrl);
      trackThreadUsage(threadId);

      // Öffentliche Bestätigung im ursprünglichen Kanal
      try {
        const sourceChannel = await client.channels.fetch(session.channelId);
        if (sourceChannel) {
          await sourceChannel.send(
            `<@${interaction.user.id}> Nachricht erfolgreich ins Forum übertragen!\n\n` +
            `[**Thread:** ${meta?.name || threadId}, **Kategorie:** ${meta?.board || "unbekannt"}, **Link:** ${result.threadUrl}]`
          );
        }
      } catch (err) {
        console.error('Fehler beim Senden der öffentlichen Bestätigung:', err);
      }

      postboxSessions.delete(interaction.user.id);

      await interaction.editReply({
        content: '✅ Erledigt! Die Bestätigung wurde im Kanal gepostet.',
      });
    }
  }

  // ========== Modal‑Submit für Postbox‑Workflow ==========
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    // Modal für Thread‑Suche (reply)
    if (customId.startsWith('postbox_reply_search:')) {
      const messageId = customId.split(':')[1];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen.', flags: MessageFlags.Ephemeral });
        return;
      }

      const query = interaction.fields.getTextInputValue('searchQuery').trim();
      if (!query) {
        await interaction.reply({ content: '❌ Bitte gib einen Suchbegriff ein.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Threads durchsuchen und scoren (wie Autocomplete)
      const scored = THREAD_CACHE
        .map(t => ({
          ...t,
          score: scoreThread(t.name, query, t.id)
        }))
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 25);

      if (scored.length === 0) {
        await interaction.reply({ content: '🔍 Keine passenden Threads gefunden.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (scored.length === 1) {
        // Genau ein Treffer – direkt posten
        const thread = scored[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const result = await enqueue(() => postToForum(
          session.content,
          session.author,
          thread.id,
          { channel: { name: session.channelName } },
          thread
        ));
        addMapping(session.messageId, result.forumPostId, thread.id, result.postUrl);
        trackThreadUsage(thread.id);

        // Öffentliche Bestätigung im ursprünglichen Kanal
        try {
          const sourceChannel = await client.channels.fetch(session.channelId);
          if (sourceChannel) {
            await sourceChannel.send(
              `<@${interaction.user.id}> Nachricht erfolgreich ins Forum übertragen!\n\n` +
              `[**Thread:** ${thread.name}, **Kategorie:** ${thread.board || "unbekannt"}, **Link:** ${result.threadUrl}]`
            );
          }
        } catch (err) {
          console.error('Fehler beim Senden der öffentlichen Bestätigung:', err);
        }

        postboxSessions.delete(interaction.user.id);

        await interaction.editReply({
          content: '✅ Erledigt! Die Bestätigung wurde im Kanal gepostet.',
        });
      } else {
        // Mehrere Treffer – Auswahlmenü anzeigen
        const options = scored.map(t => ({
          label: `[${t.board}] ${t.name}`.slice(0, 100),
          value: t.id
        }));

        const row = new ActionRowBuilder()
          .addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`postbox_reply_select:${messageId}`)
              .setPlaceholder('Wähle den gewünschten Thread')
              .addOptions(options)
          );

        await interaction.reply({
          content: `🔍 **${scored.length} Threads gefunden** – bitte wähle einen aus:`,
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // Modal für neuen Thread (Titel & Tags)
    else if (customId.startsWith('postbox_new_details:')) {
      const parts = customId.split(':');
      const messageId = parts[1];
      const category = parts[2];
      const session = postboxSessions.get(interaction.user.id);

      if (!session || session.messageId !== messageId) {
        await interaction.reply({ content: '❌ Sitzung abgelaufen.', flags: MessageFlags.Ephemeral });
        return;
      }

      const title = interaction.fields.getTextInputValue('threadTitle').trim();
      const tagsRaw = interaction.fields.getTextInputValue('threadTags').trim();

      if (!title || !tagsRaw) {
        await interaction.reply({ content: '❌ Titel und Tags sind erforderlich.', flags: MessageFlags.Ephemeral });
        return;
      }

      const tags = tagsRaw
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => t.slice(0, 29));

      if (tags.length < 1) {
        await interaction.reply({ content: '❌ Mindestens ein Tag erforderlich.', flags: MessageFlags.Ephemeral });
        return;
      }

      const categoryIdMap = {
        "News & Questions": "4",
        "Le café unité": "9",
        "Politik & Gesellschaft": "11",
        "Out of space": "10",
        "Entartete Kunst": "13",
        "Texte & Lyrics": "14",
        "Gegenwelt": "15",
        "My Story": "19",
        "Eigene Projekte": "27",
        "Mensa": "22",
        "Public": "23",
        "Müllhalde": "26"
      };

      const categoryId = categoryIdMap[category];
      if (!categoryId) {
        await interaction.reply({ content: '❌ Ungültige Kategorie.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        // Neuen Thread im Forum erstellen
        let newThreadId = null;
        const finalUrl = await enqueue(async () => {
          await page.goto(`https://forum.theunity.de/thread-add/${categoryId}/`, {
            waitUntil: 'networkidle2'
          });

          const titleInput = await page.waitForSelector('#subject', { visible: true });
          await titleInput.type(title, { delay: 10 });

          const tagInput = await page.waitForSelector('#tagSearchInput', { visible: true });
          for (const tag of tags) {
            await tagInput.click();
            await page.keyboard.type(tag, { delay: 10 });
            await page.keyboard.press('Comma');
            await sleep(120);
          }

          const editor = await page.waitForSelector('[contenteditable="true"]', { visible: true });
          await editor.click();
          await sleep(150);

          const fullMessage = buildForumMessage({
            author: session.author,
            message: session.content,
            sourceName: session.channelName
          });

          const success = await fastInsert(fullMessage);
          if (!success) {
            await page.keyboard.type(fullMessage, { delay: 2 });
          }

          await sleep(300);
          const submitButton = await page.waitForSelector('input[value="Absenden"]', { visible: true });
          await Promise.all([
            submitButton.click(),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
          ]);

          return page.url();
        });

        // Thread‑ID aus der URL extrahieren
        newThreadId = finalUrl.match(/thread\/(\d+)/)?.[1] || null;

        // Post‑ID und vollständige Share‑URL des ersten Beitrags auslesen
        const linkData = await page.evaluate(() => {
          const link = document.querySelector('a.wsShareButton[href*="postID="]');
          if (!link) return null;
          const url = new URL(link.href);
          return {
            postId: url.searchParams.get('postID') || null,
            href: link.href
          };
        });
        const forumPostId = linkData?.postId || null;
        const postUrl = linkData?.href || null;
        addMapping(session.messageId, forumPostId, newThreadId, postUrl);

        // Öffentliche Bestätigung im ursprünglichen Kanal
        try {
          const sourceChannel = await client.channels.fetch(session.channelId);
          if (sourceChannel) {
            await sourceChannel.send(
              `<@${interaction.user.id}> Thread erfolgreich erstellt!\n\n` +
              `[**Titel:** ${title}, **Kategorie:** ${category}, **Link:** ${finalUrl}]`
            );
          }
        } catch (err) {
          console.error('Fehler beim Senden der öffentlichen Bestätigung:', err);
        }

        postboxSessions.delete(interaction.user.id);

        await interaction.editReply({
          content: '✅ Erledigt! Der neue Thread wurde erstellt und die Bestätigung im Kanal gepostet.',
        });
      } catch (error) {
        // dieser catch bleibt unverändert!
        console.error('Fehler beim Erstellen des Threads:', error);

        // Fehler öffentlich posten
        try {
          const sourceChannel = await client.channels.fetch(session.channelId);
          if (sourceChannel) {
            await sourceChannel.send(
              `<@${interaction.user.id}> ❌ Fehler beim Erstellen des Threads. Bitte später erneut versuchen.`
            );
          }
        } catch (err) {
          console.error('Fehler beim Senden der Fehlermeldung:', err);
        }

        await interaction.editReply({
          content: '❌ Fehler beim Erstellen des Threads. Bitte später erneut versuchen.',
        });
      }
    }
  }
});

// ========== Lösch‑ und Edit‑Synchronisation ==========
client.on('messageDelete', async (message) => {
  if (message.partial) return;
  const mapped = postMapping.get(message.id);
  if (!mapped) return;

  try {
    await enqueue(async () => {
      const { forumPostId, postUrl } = mapped;
      console.log(`[DELETE] Versuche Beitrag ${forumPostId} zu löschen: ${postUrl}`);

      await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForSelector(`#post${forumPostId}`, { visible: true, timeout: 10000 });

      const actualPostId = await page.evaluate((expectedId) => {
        const container = document.querySelector(`#post${expectedId}`);
        if (!container) return null;
        return container.id.replace('post', '');
      }, forumPostId);

      if (actualPostId !== forumPostId) {
        console.error(`[SICHERHEIT] Abbruch: ID ${actualPostId} != ${forumPostId}`);
        const channel = await client.channels.fetch(message.channel.id).catch(() => null);
        if (channel) {
          await channel.send(`⚠️ **Sicherheitsabbruch**: Beitrag ${forumPostId} nicht eindeutig. Bitte manuell prüfen.`);
        }
        return;
      }

      console.log(`[SICHERHEIT] ID-Check bestanden: ${actualPostId}`);

      const postContainer = await page.$(`#post${forumPostId}`);
      const editButton = await postContainer.$('.jsMessageEditButton');
      if (!editButton) throw new Error('Edit-Button nicht gefunden');
      await editButton.click();

      const deleteItem = await page.waitForSelector('[data-item="trash"]', { visible: true });
      await deleteItem.click();
      const confirmButton = await page.waitForSelector('button[data-type="submit"]', { visible: true });
      await confirmButton.click();

      postMapping.delete(message.id);
      saveMapping();
      console.log(`[DELETE] Forumbeitrag ${forumPostId} gelöscht.`);
    });
  } catch (err) {
    console.error(`Fehler beim Löschen von Beitrag ${mapped.forumPostId}:`, err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.partial) await newMessage.fetch();
  if (!newMessage.content || oldMessage.content === newMessage.content) return;

  const mapped = postMapping.get(newMessage.id);
  if (!mapped) return;

  try {
    await enqueue(async () => {
      const { forumPostId, postUrl } = mapped;

      await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForSelector(`#post${forumPostId}`, { visible: true, timeout: 10000 });

      const postContainer = await page.$(`#post${forumPostId}`);
      if (!postContainer) throw new Error('Beitrags-Container nicht gefunden');

      const editButton = await postContainer.$('.jsMessageEditButton');
      if (!editButton) throw new Error('Edit-Button nicht gefunden');
      await editButton.click();

      const editItem = await page.waitForSelector('[data-item="editItem"]', { visible: true });
      await editItem.click();

      const editor = await page.waitForSelector('[contenteditable="true"]', { visible: true });
      await editor.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      const newForumMessage = buildForumMessage({
        author: newMessage.author.username,
        message: newMessage.content,
        sourceName: newMessage.channel.name,
        replyText: ''
      });

      const success = await fastInsert(newForumMessage);
      if (!success) {
        await page.keyboard.type(newForumMessage, { delay: 2 });
      }

      await sleep(300);
      const saveButton = await page.waitForSelector('button.buttonPrimary[data-type="save"]', { visible: true });
      await saveButton.click();

      console.log(`[EDIT] Forumbeitrag ${forumPostId} erfolgreich aktualisiert.`);
    });
  } catch (err) {
    console.error(`Fehler beim Bearbeiten von Beitrag ${mapped.forumPostId}:`, err);
  }
});

client.login(DISCORD_TOKEN);
