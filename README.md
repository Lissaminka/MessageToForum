```markdown
# MessageToForum

**MessageToForum** is a Node.js bot that bridges Discord and a WoltLab-based forum. It offers three methods for transferring messages to the forum and synchronizes edits and deletions when the original Discord message is still available.

## Features

- **Interactive confirmation for long messages**
  When a message exceeds the configured minimum length, the bot replies with a button. The author can then decide whether and in which thread the message should be posted (no automatic posting).

- **📮 reaction for any message (Postbox workflow)**
  Any user can add a 📮 reaction to any Discord message (including short ones). The bot starts the same interactive workflow – including thread selection or creation of a new thread.

- **Slash commands for manual input**
  - `/posttoforum-reply` – post any text to an existing thread (autocomplete for threads).
  - `/posttoforum-new` – create a new thread with title, category, tags and initial message.
  *Note: Slash commands do **not** create a mapping for later editing or deletion (see Limitations).*

- **Reply quoting**
  When a Discord message references another message, the quoted content is automatically included in the forum post (works for all three methods).

- **Thread cache with smart ranking**
  The bot crawls all configured boards every 5 minutes and stores threads with their category. Autocomplete suggestions are ranked by name similarity, recency of use, and usage frequency.

- **Persistent usage statistics**
  Every thread’s usage count and last-used timestamp are saved and survive bot restarts.

- **Reliable mapping for edit and delete synchronisation**
  When a message is posted via the interactive workflow (button or 📮 reaction), the bot stores the exact forum URL (`?postID=...`).
  - Deleting the Discord message → the forum post is automatically deleted (with a safety ID check).
  - Editing the Discord message → the forum post is updated.

- **Queue system for Puppeteer actions**
  Concurrent post, delete or edit requests are processed sequentially to avoid conflicts. A default cooldown of 11 seconds prevents forum flooding.

- **Debug mode**
  Set `DEBUG=true` to show the Puppeteer browser window and get verbose console output.

## Comparison of the three transfer methods

| Method                                    | Automatic mapping (edit/delete) | Requires existing Discord message | Reply quote | Thread selection | Create new thread |
|-------------------------------------------|:-------------------------------:|:--------------------------------:|:-----------:|:----------------:|:------------------:|
| Long message → button                     | Yes                             | Yes (the long message itself)    | Yes         | Yes (workflow)    | Yes                |
| 📮 reaction under a message               | Yes                             | Yes (the reacted message)        | Yes         | Yes (workflow)    | Yes                |
| Slash commands                            | No (only one‑time post)         | No (free text)                   | Only manually | Yes (`/reply`)    | Yes (`/new`)       |

### Advantages and disadvantages

#### Long message → button
- **Advantages:**
  - The bot proactively notifies the user; no extra reaction required.
  - Full mapping (later editing/deletion possible).
  - Reply quotes are automatically included.
- **Disadvantages:**
  - Only works for messages above the minimum length threshold.
  - The bot’s reply may be considered slightly intrusive.

#### 📮 reaction
- **Advantages:**
  - Can be used for any message (even very short ones).
  - Full mapping.
  - Low distraction (reaction is discreet).
- **Disadvantages:**
  - Requires an explicit user action (adding the reaction).
  - The workflow only starts after clicking the button that appears.

#### Slash commands
- **Advantages:**
  - Direct input of any text – independent of an existing Discord message.
  - Ideal for administrators or automated scripts.
- **Disadvantages:**
  - No mapping → edited or deleted slash command messages are not updated or removed in the forum.
  - The bot cannot automatically include reply quotes (the user must add them manually).
  - Slightly more cumbersome to use than a reaction.

## Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:Lissaminka/MessageToForum.git
   cd MessageToForum
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create the cache directory:
   ```bash
   mkdir -p cache
   ```

4. Create a `.env` file (see below) with your credentials.

5. Register the slash commands (once):
   ```bash
   node registerCommands.js
   ```

6. Start the bot:
   ```bash
   node index.js
   ```

## Configuration (`.env`)

```env
# Discord
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_discord_application_client_id

# Forum
FORUM_USERNAME=your_forum_username
FORUM_PASSWORD=your_forum_password

# Optional
DEBUG=false
ENABLE_MIN_LENGTH_FILTER=true
MIN_MESSAGE_LENGTH=1500
```

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token |
| `CLIENT_ID` | Your Discord application client ID (required for slash command registration) |
| `FORUM_USERNAME` | Forum login username |
| `FORUM_PASSWORD` | Forum login password |
| `DEBUG` | Set to `true` to show browser window and verbose logs |
| `ENABLE_MIN_LENGTH_FILTER` | Set to `false` to completely disable the long‑message button |
| `MIN_MESSAGE_LENGTH` | Minimum character count to trigger the button (e.g., `1500`) |

## Project Structure

```
.
├── index.js              # Main bot application
├── registerCommands.js   # Slash command registration script
├── cache/
│   ├── threads.json      # Thread cache + usage statistics
│   └── post-mapping.json # Mapping Discord ID → forum post URL
├── .env                  # Not versioned
├── .env.example          # Example configuration
├── package.json
└── README.md
```

## Known Limitations

- **Passwords with special characters** may cause login issues in some forum versions. Use long passwords consisting only of letters and numbers if possible.
- **No back‑sync after bot downtime**: If the bot is offline, later edits or deletions of Discord messages are not retroactively applied to the forum.
- **Mapping is only created for messages that come from an interactive workflow** (long‑message button or 📮 reaction). Slash‑command posts have no mapping and therefore cannot be automatically updated or deleted.
- **Single browser instance, sequential queue** – this is intentional to avoid server load and flood protection.

## Planned Features

- **Web interface** for easy configuration of `.env` settings (planned, not yet implemented).

*All other originally planned features (queue, edit/delete sync, confirmation dialog) are already implemented.*

## License

MIT – free to use, modify, and distribute.

---

*Last updated: April 2026 – reflects the stable bot with interactive workflow and full edit/delete synchronisation.*

---
```
