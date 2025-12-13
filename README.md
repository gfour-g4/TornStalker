# TornStalker
[![Ask DeepWiki](https://devin.ai/assets/askdeepwiki.png)](https://deepwiki.com/gfour-g4/TornStalker)

TornStalker is a sophisticated Discord bot for monitoring users and factions in the online game Torn. It provides real-time, configurable notifications via Direct Messages for a wide range of in-game events, managed through an interactive Discord UI.

## Key Features

*   **User & Faction Tracking**: Monitor the status of multiple Torn users and factions simultaneously.
*   **Real-time Status Alerts**: Receive instant DM notifications when a tracked user's status changes (e.g., Traveling, Jail, Hospital, Okay).
*   **Personal Account Monitoring**:
    *   **Bars**: Get alerts when your Energy, Nerve, Happy, or Life bars are full.
    *   **Cooldowns**: Be notified when Drug, Medical, or Booster cooldowns are ready.
    *   **Chain Timer**: Receive alerts at configurable thresholds before a faction chain times out.
*   **Advanced Faction Intelligence**:
    *   Track member joins and leaves.
    *   Receive alerts for member status changes.
    *   Get notified when a member has been inactive for a configurable duration (e.g., offline for >24h).
    *   Receive daily reports on faction respect changes.
    *   Celebrate respect milestones (e.g., hitting 1,000,000 respect).
*   **Early Warnings**: Set up "pre-alerts" to be notified a certain amount of time *before* a user's jail/hospital/travel time ends (e.g., 5 minutes before landing).
*   **Interactive UI**: Manage all tracking and settings through an intuitive system of slash commands, buttons, selection menus, and modals directly within Discord.
*   **Travel ETA Adjustments**: Manually add or subtract time from a user's travel ETA to account for delays or perks.
*   **Persistent Configuration**: All settings are saved locally in a `store.json` file, so the bot remembers your configuration across restarts.

## Setup & Installation

Follow these steps to get your own instance of TornStalker running.

**Prerequisites:**
*   Node.js (version 18 or higher)
*   Git

**Installation Steps:**

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/gfour-g4/TornStalker.git
    cd TornStalker
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure environment variables:**
    *   Create a file named `.env` in the root directory by copying the example file:
        ```bash
        cp .env.example .env
        ```
    *   Open the `.env` file and fill in the required values:

        | Variable              | Description                                                                                             | Required |
        | --------------------- | ------------------------------------------------------------------------------------------------------- | :------: |
        | `DISCORD_TOKEN`       | Your Discord bot's token.                                                                               |   Yes    |
        | `OWNER_DISCORD_ID`    | Your personal Discord user ID. Only this user can interact with the bot.                                |   Yes    |
        | `TORN_API_KEY`        | Your Torn API key with `Limited Access`.                                                                |   Yes    |
        | `GUILD_ID`            | (Optional) The ID of a Discord server to instantly register slash commands for testing.                 |    No    |
        | `REQUEST_INTERVAL_MS` | (Optional) The polling interval in milliseconds. Defaults to `5000`.                                    |    No    |
        | `FACTION_INTERVAL_MS` | (Optional) The polling interval in milliseconds for factions. Defaults to `30000`.                        |    No    |
        | `PERSIST_PATH`        | (Optional) The local path to store the JSON configuration file. Defaults to `./store.json`.             |    No    |
        | `USER_IDS`/`FACTION_IDS` | (Optional) Comma-separated lists of user/faction IDs to seed the bot on first run.                    |    No    |

4.  **Run the bot:**
    ```bash
    npm start
    ```

## Usage (Slash Commands)

The bot is controlled primarily through slash commands in your DMs or a server where the bot is present.

*   `/dashboard`: Opens the main control panel, providing an overview of all tracking activities and access to configuration menus.
*   `/track user <id> [alerts] [warn]`: Starts tracking a new user. You can specify which states to alert on and set up early warnings.
*   `/track faction <id> [alerts] [warn] [offline]`: Starts tracking a new faction, with options for member status alerts, early warnings, and offline member notifications.
*   `/alerts`: Opens the configuration menu for your personal bar, cooldown, and chain alerts.
*   `/status <id>`: Performs a one-time status check on any Torn user.
*   `/remove <id>`: Stops tracking a user or faction.
*   `/delay <id> <time>`: Adds a time delay to a traveling user's estimated time of arrival (e.g., `/delay id:12345 time:5m`).
*   `/help`: Displays a list of all available commands and their usage.

## Auto-Update (for Windows)

The repository includes a `check_update.bat` script to automate the update process on a Windows machine. It checks for new commits to the `main` branch, and if found, it will:
1. Pull the latest code.
2. Terminate the running bot process.
3. Restart the bot.

To use it, you must edit the first line of `check_update.bat` to point to your bot's directory:

```batch
@echo off
cd /d C:\path\to\your\bot
...
```

You can then run this script manually or set it up as a scheduled task to keep your bot up-to-date automatically. The update check is based on the `version.txt` file, which is automatically incremented with every push to the `main` branch via a GitHub Actions workflow.