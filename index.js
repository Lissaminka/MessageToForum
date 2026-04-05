import { Client, GatewayIntentBits } from 'discord.js';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config(); // .env laden

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Zugangsdaten aus .env
const FORUM_USERNAME = process.env.FORUM_USERNAME;
const FORUM_PASSWORD = process.env.FORUM_PASSWORD;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Debug-Flag aus .env
const DEBUG = process.env.DEBUG === 'true';

// Minimale Nachrichtenlänge aus .env, Standard 1500
const MIN_MESSAGE_LENGTH = parseInt(process.env.MIN_MESSAGE_LENGTH || '1500', 10);

let browser;
let page;

// Login-Funktion
async function loginToForum() {
  browser = await puppeteer.launch({
    headless: !DEBUG,
    slowMo: DEBUG ? 50 : 0
  });

  page = await browser.newPage();

  await page.goto('https://forum.theunity.de/', { waitUntil: 'networkidle2' });

  const loginLink = await page.$('a.loginLink');

  if (!loginLink) {
    console.log("Forum session initialized.");
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

// Post ins Forum
async function postToForum(message, author, channel) {
  const now = new Date();
  const timestamp = now.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const forumMessage = `
<strong>${author} schrieb am ${timestamp} in #${channel}:</strong>

${message}
`;

  try {
    // Thread aufrufen
    await page.goto('https://forum.theunity.de/index.php?thread/794/', { waitUntil: 'networkidle2' });

    // Letzte Seite automatisch ermitteln (robust)
    const lastPageUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="pageNo="]'));
      if (links.length === 0) return null;

      let max = 1;
      let url = null;

      for (const link of links) {
        const match = link.href.match(/pageNo=(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) {
            max = num;
            url = link.href;
          }
        }
      }

      return url;
    });

    if (lastPageUrl) {
      await page.goto(lastPageUrl, { waitUntil: 'networkidle2' });
    }

    const initialPostCount = await page.$$eval('.message, article', els => els.length);

    // CKEditor finden
    const editor = await page.waitForSelector(
      'div.ck-editor__editable[contenteditable="true"]',
      { visible: true, timeout: 30000 }
    );

    await editor.click();

    // Inhalt löschen
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    // Schnelles Einfügen via Clipboard (mit Fallback)
    try {
      await page.evaluate((text) => {
        navigator.clipboard.writeText(text);
      }, forumMessage);

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyV');
      await page.keyboard.up('Control');
    } catch {
      // Fallback: schnelles Tippen
      await page.keyboard.type(forumMessage, { delay: 0 });
    }

    const submitButton = await page.waitForSelector(
      'button.buttonPrimary[data-type="save"]',
      { visible: true }
    );

    await submitButton.click();

    // Auf neuen Post warten
    await page.waitForFunction(
      (initialCount) => document.querySelectorAll('.message, article').length > initialCount,
      { timeout: 20000 },
      initialPostCount
    );

    console.log("INFO: Post erfolgreich übertragen");

  } catch (err) {
    console.log("ERROR: Posting fehlgeschlagen (wird ignoriert, falls Post trotzdem erstellt):", err.message);
    if (DEBUG) {
      await page.screenshot({ path: 'error_debug.png', fullPage: true });
    }
  }
}

// Discord Client
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
        const referenced = await message.fetchReference();
        if (referenced.content.length < MIN_MESSAGE_LENGTH) {
          const shortened = referenced.content.slice(0, 300);
          const suffix = referenced.content.length > 300 ? '...' : '';
          replyText =
`<strong>Antwort auf ${referenced.author.username}:</strong>
"${shortened}${suffix}"

`;
        }
      } catch (err) {
        console.log("WARN: Referenz konnte nicht geladen werden");
      }
    }

    await postToForum(replyText + message.content, message.author.username, message.channel.name);
  }
});

client.login(DISCORD_TOKEN);
