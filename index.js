import { Client, GatewayIntentBits } from 'discord.js';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const FORUM_USERNAME = process.env.FORUM_USERNAME;
const FORUM_PASSWORD = process.env.FORUM_PASSWORD;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const DEBUG = process.env.DEBUG === 'true';

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
let LAST_UPDATE = 0;
let IS_REFRESHING = false;

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

function getThreadUrl(threadId) {
  return `https://forum.theunity.de/index.php?thread/${threadId}/`;
}

async function loginToForum() {
  browser = await puppeteer.launch({
    headless: !DEBUG,
    slowMo: DEBUG ? 30 : 0
  });

  page = await browser.newPage();
  crawlPage = await browser.newPage();

  await page.goto('https://forum.theunity.de/', { waitUntil: 'networkidle2' });

  const loginLink = await page.$('a.loginLink');

  if (!loginLink) {
    console.log("Session vorhanden");
    return;
  }

  await page.evaluate(el => el.click(), loginLink);

  await page.waitForSelector('input#username', { visible: true });

  await page.type('input#username', FORUM_USERNAME);
  await page.type('input[name="password"]', FORUM_PASSWORD);

  const submitButton = await page.waitForSelector('input[type="submit"]', { visible: true });

  await Promise.all([
    submitButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ]);

  console.log("Login abgeschlossen");
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

async function postToForum(message, author, threadId) {
  const now = new Date();

  const timestamp = now.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const forumMessage = convertHtmlToBBCode(`
<strong>${author} schrieb am ${timestamp}:</strong>

${message}
`);

  try {
    await page.goto(getThreadUrl(threadId), {
      waitUntil: 'networkidle2'
    });

    const editor = await page.waitForSelector('[contenteditable="true"]', { visible: true });

    await editor.click();
    await sleep(100);

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    const success = await fastInsert(forumMessage);

    if (!success) {
      await page.keyboard.type(forumMessage, { delay: 1 });
    }

    await sleep(200);

    const submitButton = await page.waitForSelector(
      'button.buttonPrimary[data-type="save"]',
      { visible: true }
    );

    await submitButton.click();

    console.log("Post erfolgreich übertragen");

  } catch (err) {
    console.log("Fehler:", err.message);
  }
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

async function crawlBoard(boardUrl, maxPages = 3) {
  const threads = new Map();

  let currentUrl = boardUrl;
  let pages = 0;

  while (currentUrl && pages < maxPages) {
    pages++;

    await crawlPage.goto(currentUrl, { waitUntil: 'networkidle2' });

    const pageThreads = await extractThreadsFromPage();

    for (const t of pageThreads) {
      threads.set(t.id, t);
    }

    const nextUrl = await crawlPage.evaluate(() => {
      const next = document.querySelector('a.pagination__link[rel="next"]');
      return next ? next.href : null;
    });

    currentUrl = nextUrl;
  }

  return Array.from(threads.values());
}

async function refreshThreadsIncremental() {
  console.log("Incremental refresh gestartet");

  const existing = new Map(THREAD_CACHE.map(t => [t.id, t]));

  let added = 0;

  for (const board of BOARDS) {
    try {
      const threads = await crawlBoard(board, 2);

      for (const t of threads) {
        if (!existing.has(t.id)) {
          THREAD_CACHE.push(t);
          existing.set(t.id, t);
          added++;
        }
      }
    } catch (e) {
      console.log("Board error:", board, e.message);
    }
  }

  LAST_UPDATE = Date.now();

  console.log(`Increment fertig → Neu: ${added}, Gesamt: ${THREAD_CACHE.length}`);
}

async function refreshThreadsIfNeeded() {
  const now = Date.now();

  if (IS_REFRESHING) return;
  if (now - LAST_UPDATE < 10 * 60 * 1000) return;

  IS_REFRESHING = true;

  try {
    await refreshThreadsIncremental();
  } finally {
    IS_REFRESHING = false;
  }
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await loginToForum();
  await refreshThreadsIfNeeded();
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused();

      const filtered = THREAD_CACHE
        .filter(t => t.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      await interaction.respond(
        filtered.map(t => ({
          name: t.name.slice(0, 100),
          value: t.id
        }))
      );

      refreshThreadsIfNeeded().catch(() => {});
    } catch {}

    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'posttoforum') return;

  const threadId = interaction.options.getString('thread');
  const message = interaction.options.getString('message');

  await interaction.deferReply({ ephemeral: true });

  try {
    await postToForum(message, interaction.user.username, threadId);

    await interaction.channel.send(
      `Post erfolgreich ins Forum gesendet (Thread ${threadId})`
    );

    await interaction.editReply('OK');
  } catch (err) {
    console.log(err);
    await interaction.editReply('Fehler beim Posten');
  }
});

client.login(DISCORD_TOKEN);
