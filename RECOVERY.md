# Nanoclaw Recovery Runbook

If a bad change causes nanoclaw to crash or fail to start, follow these steps.

## Quick Recovery

```bash
cd ~/nanoclaw

# 1. See recent commits
git log --oneline -10

# 2. Revert the last commit (safe — creates a new revert commit)
git revert HEAD --no-edit

# OR: hard reset to a specific known-good commit
git reset --hard <commit-hash>

# 3. Rebuild the Docker image
./container/build.sh

# 4. Restart nanoclaw
systemctl restart nanoclaw

# 5. Verify it's running
systemctl status nanoclaw
```

## If nanoclaw won't start after restart

Check the logs:
```bash
journalctl -u nanoclaw -n 50 --no-pager
```

Common causes:
- TypeScript compile error → fix the source or revert
- Missing dependency → `npm install` in `~/nanoclaw`
- Bad config → check `.env` file

## Rebuild from scratch

```bash
cd ~/nanoclaw
npm install
npm run build
./container/build.sh
systemctl restart nanoclaw
```

## Pull latest from Bilbo's fork

```bash
cd ~/nanoclaw
git pull origin main
npm run build
./container/build.sh
systemctl restart nanoclaw
```

Origin is set to `https://github.com/bilbomonaghan-cell/nanoclaw.git`.

## Architecture reminder

- **nanoclaw** = Node.js process on the host (`~/nanoclaw/dist/`) — handles messages, schedules tasks, spins up containers
- **nanoclaw-agent** = Docker image — Bilbo runs inside this container for each conversation
- Changes to `src/` affect the host process → require `npm run build` + `systemctl restart nanoclaw`
- Changes to `container/Dockerfile` affect the Docker image → require `./container/build.sh` only
