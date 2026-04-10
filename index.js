import { Client, GatewayIntentBits } from 'discord.js';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

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
const MIN_MESSAGE_LENGTH = parseInt(process.env.MIN_MESSAGE_LENGTH || '1500', 10);

let browser;
let page;

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

async function loginToForum() {
  browser = await puppeteer.launch({
    headless: !DEBUG,
    slowMo: DEBUG ? 30 : 0
  });

  page = await browser.newPage();

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
      editor.focus();

      const data = new DataTransfer();
      data.setData('text/plain', text);

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true
      });

      editor.dispatchEvent(pasteEvent);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, text);

    return true;
  } catch {
    return false;
  }
}

async function postToForum(message, author, channel) {
  const now = new Date();
  const timestamp = now.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const forumMessage = convertHtmlToBBCode(`
<strong>${author} schrieb am ${timestamp} in #${channel}:</strong>

${message}
`);

  try {
    await page.goto('https://forum.theunity.de/index.php?thread/794/', {
      waitUntil: 'networkidle2'
    });

    const lastPageUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="pageNo="]'));
      if (!links.length) return null;

      let max = 1;
      let url = null;

      for (const link of links) {
        const match = link.href.match(/pageNo=(\d+)/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > max) {
            max = n;
            url = link.href;
          }
        }
      }

      return url;
    });

    if (lastPageUrl) {
      await page.goto(lastPageUrl, { waitUntil: 'networkidle2' });
    }

    const initialCount = await page.$$eval('.message, article', els => els.length);

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

    await page.waitForFunction(
      (initialCount) =>
        document.querySelectorAll('.message, article').length > initialCount,
      { timeout: 20000 },
      initialCount
    );

    console.log("Post erfolgreich übertragen");

  } catch (err) {
    console.log("Fehler:", err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await loginToForum();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.length >= MIN_MESSAGE_LENGTH) {
    let replyText = '';

    if (message.reference) {
      try {
        const ref = await message.fetchReference();

        if (ref.content.length < MIN_MESSAGE_LENGTH) {
          const short = ref.content.slice(0, 300);
          const suffix = ref.content.length > 300 ? '...' : '';

          replyText =
`[b]Antwort auf ${ref.author.username}:[/b]
"${convertHtmlToBBCode(short)}${suffix}"

`;
        }
      } catch {
        console.log("Referenz konnte nicht geladen werden");
      }
    }

    await postToForum(
      replyText + message.content,
      message.author.username,
      message.channel.name
    );
  }
});

client.login(DISCORD_TOKEN);
