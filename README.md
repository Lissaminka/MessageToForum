```markdown
# MessageToForum

**MessageToForum** is a Node.js bot that bridges Discord and a WoltLab-based forum. It automatically posts long Discord messages to the forum and provides slash commands for manual posting and thread creation.

## Features

- **Automatic message transfer**: Messages exceeding a configurable minimum length are automatically posted to a default forum thread.
- **Reply context preservation**: For automatically posted messages (those meeting the minimum length threshold), replies include a quote of the referenced Discord message in the forum post.
- **Slash commands**: Manual control via Discord commands:
  - `/posttoforum-reply` – Post a message to an existing thread (with autocomplete thread selection).
  - `/posttoforum-new` – Create a new thread with title, category, tags, and initial message.
- **Thread cache with smart ranking**: Autocomplete suggestions are ranked by name match quality, recency of use, and usage frequency.
- **Automatic thread discovery**: The bot crawls all configured boards and maintains an up-to-date thread cache.
- **Persistent usage statistics**: Thread usage is tracked and saved between restarts.
- **Debug mode**: Set `DEBUG=true` for visible browser window and verbose console output.
- **Secure credential management**: All sensitive data stored in `.env` file.

## Requirements

- Node.js 18 or higher
- A Discord bot with appropriate permissions
- Forum account credentials

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

3. Create required directories:

```bash
mkdir -p cache
```

4. Create a `.env` file based on the example below and fill in your credentials.

5. Register the slash commands:

```bash
node registerCommands.js
```

6. Start the bot:

```bash
node index.js
```

## Configuration

Create a `.env` file with the following variables:

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
| `ENABLE_MIN_LENGTH_FILTER` | Set to `false` to disable automatic posting entirely |
| `MIN_MESSAGE_LENGTH` | Minimum character count to trigger automatic posting |

## Usage

### Automatic Posting

When `ENABLE_MIN_LENGTH_FILTER` is `true`, any Discord message (not from a bot) that meets or exceeds `MIN_MESSAGE_LENGTH` characters will be automatically posted to the default thread (ID: `794`).

Replies to other messages will include a quote of the referenced message in the forum post.

### Slash Commands

#### `/posttoforum-reply`

Post a message to an existing thread.

| Option | Description |
|--------|-------------|
| `thread` | Select a thread (autocomplete enabled, ranked by relevance and usage) |
| `message` | The message content to post |

#### `/posttoforum-new`

Create a new thread with an initial message.

| Option | Description |
|--------|-------------|
| `category` | Forum category for the new thread |
| `threadname` | Title of the new thread |
| `tags` | Comma-separated tags (minimum 1, maximum 10, max 30 characters each) |
| `message` | Initial message content |

## Project Structure

```
.
├── index.js              # Main bot application
├── registerCommands.js   # Slash command registration script
├── cache/
│   └── threads.json      # Persistent thread cache and usage statistics
├── .env                  # Environment variables (not committed)
├── .env.example          # Example environment configuration
├── package.json          # Dependencies and scripts
└── README.md             # This file
```

## Known Limitations

- Passwords containing special characters may cause login issues. Use long passwords (>64 characters) consisting of letters and numbers only.
- The bot uses a single browser instance; concurrent posting operations will be processed sequentially.
- Edited Discord messages are not synchronized to the forum (planned feature).
- Deleted Discord messages are not removed from the forum (planned feature).

## Planned Features

1. **Queue system**: Prevent race conditions when multiple messages are sent simultaneously.
2. **Edit synchronization**: Update forum posts when Discord messages are edited.
3. **Multi-thread mapping**: Assign Discord channels to specific forum threads.
4. **Confirmation dialog**: Ask users whether they want to post long messages instead of automatic posting.
5. **Web interface**: User-friendly configuration panel for `.env` settings.

## License

This project is open source under the MIT License.
```

---
