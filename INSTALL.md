# Installation Guide

## Prerequisites

- **Node.js** 20+ with npm
- **Pi** (the coding agent harness) — [github.com/earendil-works/pi](https://github.com/earendil-works/pi)
- **Obsidian** (optional but recommended) — [obsidian.md](https://obsidian.md)
- **Git** (for sync)
- An **LLM API key** (OpenAI, Anthropic, Ollama, OpenCode, etc.)

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/dizthewize/pi-memory-compiler.git ~/.pi-memory
cd ~/.pi-memory
npm install
```

---

## Step 2: Configure Your Vault Path

Edit `~/.pi-memory/config/config.json`:

```json
{
  "vaultPath": "/path/to/your/Obsidian/Vault"
}
```

**Recommended:** Create a dedicated vault for Pi-Memory:

```bash
mkdir -p ~/Documents/Pi-Memory
git init ~/Documents/Pi-Memory
```

Then set `vaultPath` to that directory.

---

## Step 3: Set API Keys via Environment Variables

```bash
# Add to your ~/.bashrc or ~/.zshrc
export OPENAI_API_KEY="sk-..."
```

Supported providers and their env vars:

| Provider | Env Var | Endpoint |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| OpenCode Go | `OPENCODE_API_KEY` | `https://opencode.ai/zen/go/v1` |
| Ollama Cloud | `OLLAMA_API_KEY` | `https://ollama.com/v1` |
| Local Ollama | (none) | `http://localhost:11434/v1` |

---

## Step 4: Register the Pi Hook

Edit `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/YOUR_USERNAME/.pi-memory/hooks/memory.ts"]
}
```

Replace `/home/YOUR_USERNAME/` with your actual home directory path.

---

## Step 5: Initialize the Database

```bash
cd ~/.pi-memory
npx tsx db/init-db.ts
```

This creates `~/.pi-memory/db/memory.db` with the full schema.

---

## Step 6: Configure Obsidian (Optional)

1. Open Obsidian
2. **Open folder as vault** → select your `vaultPath`
3. **Settings → Community plugins → Safe mode OFF**
4. **Browse →** search "Git" → install **Obsidian Git** by Vinzent
5. **Enable** it

**Obsidian Git settings:**
- Vault backup interval: `10`
- Auto backup after file change: ON
- Auto pull on startup: ON

---

## Step 7: Set Up Git Sync (Optional)

Initialize your vault as a git repo and push to GitHub:

```bash
cd /path/to/your/Obsidian/Vault
git init
git remote add origin https://github.com/YOUR_USERNAME/pi-memory-vault.git
echo "raw-sessions/" >> .gitignore
echo ".obsidian/workspace.json" >> .gitignore
git add -A
git commit -m "Initial Pi-Memory vault"
git push -u origin main
```

Enable auto-sync in config:

```json
{
  "git": {
    "enabled": true,
    "remote": "origin",
    "branch": "main"
  }
}
```

---

## Step 8: Verify Installation

Start a new Pi session. You should see:

```
💡 memories loaded
```

Run `/memory-status` to check stats:

```
Pi-Memory Status:
• Sessions: 0 (0 pending compilation)
• Memories: 0
• Events: 0
• Current session: sess-...
```

Type `exit` or Ctrl+C to end the session. You should see:

```
💾 Session saved: N events captured
```

After 5 sessions, auto-compile triggers:

```
📚 Auto-compiling 5 sessions in background...
```

---

## Troubleshooting

### "No git repository found"

The git sync feature requires your vault to be a git repo. Either:
- Initialize it: `git init` in your vault directory
- Or disable git sync: `"git": { "enabled": false }`

### "Transformers.js not available"

The embedding model downloads on first use (~90MB). If it fails, the system falls back to deterministic embeddings. To force real embeddings:

```bash
cd ~/.pi-memory
node -e "const { pipeline } = require('@xenova/transformers'); pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')"
```

### Hook not loading

Check Pi's extension loading. The path in `settings.json` must be absolute and use `.ts` extension (Pi uses jiti).

```bash
# Test if the hook loads
node --import tsx ~/.pi-memory/hooks/memory.ts
```

### Database locked

If you see "database is locked", another process is using the DB. Close Obsidian and any running Pi sessions, then retry.

---

## Next Steps

- Read [AGENTS.md](AGENTS.md) for technical details
- Read [MEMORY_SCHEMA.md](MEMORY_SCHEMA.md) for wiki conventions
- Use Pi normally — the system captures and compiles automatically
- Say "remember this" when you solve something worth keeping
