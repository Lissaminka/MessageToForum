# MessageToForum

**MessageToForum** is a Node.js bot that automatically posts long Discord messages to a forum, keeping your community content synchronized between Discord and the forum.

## Features

* Automatically transfers longer messages (configurable minimum length) to the forum.
* Reply functionality: preserves message references to maintain context.
* Optional debug mode (`DEBUG=true` in `.env`).
* Secure forum login via environment variables.

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

3. Create a `.env` file (see `.env.example`) and fill in your Discord token and forum credentials.

4. Start the bot:

```bash
node index.js
```

5. (Optional) Start the Express server:

```bash
node server.js
```

## Configuration

The main settings are stored in the `.env` file. You can adjust the minimum message length (`MIN_MESSAGE_LENGTH`) here if desired:

```env
# Discord
DISCORD_TOKEN=your_discord_token

# Forum
FORUM_USERNAME=your_forum_username
FORUM_PASSWORD=your_forum_password

# Optional
DEBUG=false
PORT=3000
MIN_MESSAGE_LENGTH=1500
```

**Note:** `MIN_MESSAGE_LENGTH` is the threshold (number of characters) a Discord message must reach before it gets posted to the forum. Adjust this value to suit your needs.

## License

This project is open source under the MIT License.
