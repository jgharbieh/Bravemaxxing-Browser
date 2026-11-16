---
name: agent-browser-brave
description: How to drive the user's own Brave browser well with the agent-browser CLI: where to work (your own tab group, a tab the user hands you, or a separate hidden browser), how to act on pages reliably (snapshot, click, type, hover, drag, double-click), and when to take or leave the user's attention. Use for any browsing, form filling, scraping, testing, "walk me through" or "watch it happen" request.
allowed-tools: Bash(agent-browser:*), Bash(brave-agent-ready:*), Bash(agent-tab:*), Bash(tab-status:*)
---

# Driving Brave

You drive the user's real Brave with the `agent-browser` CLI. A small relay sits between you and Brave so
that you only ever see tabs that are yours, and so that their attention moves only when you mean it to.
The user decides where you work and how closely they follow, in plain words. Your job is to drive well.

## 1. Start

```bash
brave-agent-ready                                     # checks Brave and the relay; prints "Brave ready"
export AGENT_BROWSER_CDP_HEADERS='{"X-Agent":"<your agent name>"}'   # once per shell, if not already set
```

Use one session name for your work: `agent-browser --session <your agent name> <command>`.
If `brave-agent-ready` says Brave's debugging port is down and it will not relaunch, do not restart Brave
yourself: tell the user to run `BRAVE_RELAUNCH_OK=1 brave-agent-ready` (it closes and restores their
windows, so whether that may happen on its own is their setting, not your decision).

## 2. Where to work: follow what the user said

| The user says | Do this |
|---|---|
| Nothing about where ("look this up", "apply here", "test this flow") | Your own tabs. They appear in a tab group with your name in the user's window. |
| "In my tab", "this page", "the form I have open", "take over" | That tab, once it is yours (see below). |
| "Use a separate browser", "don't touch my Brave", or bulk scraping that needs no login | The separate hidden browser (section 7). |

Say in one line which one you are using. Do not ask unless the choice changes the result.

**Your own tabs.** Open the first page with `agent-browser --session <name> open <url>` (it uses the blank tab
the session starts with). Open more with `tab new <url>`. They open in the background and join your tab group.

**A tab of the user's.** You cannot see the user's tabs until one is handed to you. Two ways:
- They drag the tab into your tab group. It then shows up in `agent-browser --session <name> tab`.
- They tell you to take it. Run `tab-status claim --agent <name> --match "<words from the title or URL they named>"`.
  It hands you that one tab and prints its id. If it says several tabs match, use more exact words or ask
  them to drag the tab into your group. You are never shown a list of their tabs.

Bind with `agent-browser --session <name> tab <id>` and confirm with `get url` before you act.
When they drag it out of the group, or you run `tab-status release --agent <name> --tab <id>`, it is theirs
again and you can no longer see it. Give a tab back when you are done with it.

## 3. Their attention: when to take it, when to leave it

Decide this at the start of every task, from what the user asked for, and set it. It is not a default to
forget about.

| The task is | Set | What happens |
|---|---|---|
| Your own work: research, applying, scraping, testing, anything they are not watching step by step | `tab-status focus --mode quiet` (the default) | Your tabs open behind theirs. Nothing switches, nothing is raised. |
| Work you do WITH them: "walk me through", "show me", "let's go through these", fixing something together across tabs | `tab-status focus --mode together` | The tab you work on becomes the tab they see, and new tabs open in front, so they stay on track. Brave is not raised over their other apps. |

Go back to `--mode quiet` the moment the shared part is over. Together mode also lapses by itself after
30 minutes without a browser command.

**Look before you move anything.** `tab-status where` tells you whether Brave is the app they are using and
whether the tab in front is yours. Read it before a step that changes what they see:
- Brave focused and your tab in front: they are watching you. Act; say what you are about to do.
- Brave focused, their own tab in front: they are busy in the browser. In quiet mode leave it. In together
  mode switching is expected, but one line in chat first is better than a surprise.
- Brave is not the focused app: they are somewhere else. Switching tabs inside Brave disturbs nothing.
  Raising Brave over what they are doing is the bigger step (below).

**When you need them** (a sign-in, a question only they can answer, a bot check):
1. Always say it in chat first and name the tab by its title.
2. To put the tab in front of them: `tab-status surface --tab <id>`. It works in together mode. In quiet
   mode it is refused, which is the point: chat is enough.
3. To also raise Brave over their other windows add `--window true`. Use it only when they are waiting on
   you or have told you to get them. It is the loudest thing you can do.

**Bot checks.** Never solve or work around one. Whether you may bring the stuck tab forward is the user's
preference: `tab-status surface --tab <id> --reason captcha` works when they have allowed it for good
(`"focus": {"captcha": "allow"}` in their config) or for this task. If it is refused with "ask the user",
ask once: "May I bring the tab forward when a site needs you to pass a bot check?" On yes, run
`tab-status focus --captcha allow` and surface it. On no, list the tab in chat and move on to other work.

## 4. The loop that works

```bash
agent-browser --session <name> snapshot -i        # interactive elements, each with a ref like @e3
agent-browser --session <name> click @e3          # act by ref
agent-browser --session <name> snapshot -i        # look again before the next step
```

- Refs belong to the snapshot they came from. After anything that changes the page, snapshot again.
- Check that an action landed (new URL, new text, field value) before you build on it. If you are unsure
  whether a click or submit went through, read the page; do not repeat it.
- Wait for the page, not for a timer: `wait --text "..."`, `wait <selector>`, `wait --load networkidle`.
- Read with `get text <sel>`, `get value <sel>`, `get url`, `get title`. Screenshot only when layout matters.

| Need | Command |
|---|---|
| Type into a field | `fill @e2 "text"` (replaces), `type @e2 "text"` (appends) |
| Keys | `press Enter`, `press Control+a` |
| Hover (menus, tooltips) | `hover @e4` |
| Double-click | `dblclick @e4` |
| Drag and drop | `drag @e5 @e9` |
| Dropdown, checkbox | `select @e6 "Option"`, `check @e7`, `uncheck @e7` |
| Scroll | `scroll down 600`, `scrollintoview @e8` |
| Upload a file | `upload <sel> /absolute/path` (never click a button that opens the system file picker) |

A ref or a CSS selector (`"#id"`, `".class"`) both work. The CLI's own reference is always current:
`agent-browser skills get core`.

## 5. Being a good guest in someone's browser

- **Attention is theirs.** Take it only the ways section 3 describes. The status emoji in your tab titles
  (🤖 acting, ✅ action done, ⏸️ turn over) and in your tab group's name already tell them what you are doing.
- **Keep your group small.** Reuse a tab with `open <url>` instead of opening another. Close each tab when you
  are done with it (`tab` lists them, `tab close <tN>`). `agent-browser` cannot close a session's last tab, so
  finish with `tab-status close --agent <name>`: it closes every tab you opened and leaves handed-over tabs alone.
  End a task with only the tabs the user needs to see.
- **Only your tabs.** After every `tab <id>` and after anything that opens a tab, run `get url` and check it
  is the page you expect. If it is not, stop and rebind; do not act.
- **Leave their things alone.** Never set tab titles by hand, never move or rename tab groups, never open
  the password manager or click its pop-ups. The user signs in by hand; you reuse the session.
- **Stop at bot checks.** CAPTCHA or "verify you are human": stop on that site. Never solve or work around
  one. Section 3 says how to get the user to it.

## 6. When something is in the way

| What you see | What to do |
|---|---|
| `Session with given id not found`, `Page.enable` errors | `agent-browser --session <name> close`, then run the command again. |
| `agent wall: not an agent tab` | The tab is not yours (or was taken back). Open your own or ask for it. |
| `blocked by agent wall` | That site or extension is on the user's wall list. Do not look for another way in. |
| A browser dialog (alert, print, file picker, permission prompt) | The relay cannot answer it. Tell the user which tab; do not retry. |
| The page went blank or reloaded after a pause | Brave put the background tab to sleep. Check `get url` and the page state, then continue. |
| `brave-agent-ready` fails | Read its message. It names the fix. |

Never connect to Brave's own debugging port (9222). The relay (9333, the default) is the only way in.

## 7. The separate hidden browser

For work that should not touch the user's Brave at all:

```bash
agent-browser --config ~/.bravemaxxing/agent-browser-headless.json --session <name>-sep open <url>
```

It is a clean browser with no logins, invisible unless you add `--headed`. Everything in section 4 works the
same. If the config file does not exist yet, create it once with the content `{}` (an empty config makes
`agent-browser` start its own browser instead of using the relay). Close it when done: `agent-browser --config ~/.bravemaxxing/agent-browser-headless.json --session <name>-sep close`.

## The wall

The user lists walled extensions and sites in `~/.bravemaxxing/config.json` (default: their password manager).
A hook refuses commands that name them, the relay refuses to navigate to or script them, and any tab of
yours that lands on one is closed. It is a tripwire for cooperating agents, not a security boundary.
