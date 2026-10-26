// The bot's own copy of the code: a clone of BOT_REPO (default: the checkout this folder is in) at BOT_BRANCH, fetched
// again before an investigation when it is more than 5 minutes old.  The model reads only this copy, never a working
// tree that someone is editing.  The live server's version (`rev`, the module's commit) comes from the module's
// nfsu2.json when the bot runs next to the server (BOT_LIVE_FILE, mounted read-only), else from the page's game.json
// (BOT_LIVE_URL), which Cloudflare may refuse to a server's address.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FETCH_EVERY_MS = 5 * 60_000;
const LIVE_EVERY_MS = 60_000;

/** where the code comes from without BOT_REPO: the checkout the bot's folder is in */
export function defaultSource(here) {
  try {
    return execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('set BOT_REPO: this folder is not in a git checkout (README.md)');
  }
}

export class Repo {
  constructor({ source, branch, dir, liveUrl, liveFile }) {
    Object.assign(this, { source, branch, dir, liveUrl, liveFile });
    this.fetchedAt = 0;
    this.live = { rev: null, at: 0, via: null };
  }

  async git(args, { maxBuffer = 32 << 20, timeout = 30_000 } = {}) {
    const { stdout } = await run('git', ['-C', this.dir, ...args], { maxBuffer, timeout });
    return stdout;
  }

  /** clone on first use, then fetch + reset when stale (the model never sees a half-updated tree: one job at a time) */
  async sync(force = false) {
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      await run('git', ['clone', '--quiet', '--single-branch', '--branch', this.branch, this.source, this.dir],
        { timeout: 600_000 });
      this.fetchedAt = Date.now();
      return;
    }
    if (!force && Date.now() - this.fetchedAt < FETCH_EVERY_MS) return;
    try {
      await this.git(['remote', 'set-url', 'origin', this.source]);   // BOT_REPO may have changed since the clone
      await this.git(['fetch', '--quiet', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`],
        { timeout: 120_000 });
      await this.git(['reset', '--quiet', '--hard', `origin/${this.branch}`]);
      await this.git(['clean', '-qfdx']);
      this.fetchedAt = Date.now();
    } catch (e) {
      console.error(`[repo] fetch failed, using the copy from ${new Date(this.fetchedAt).toISOString()}: ${e.message}`);
    }
  }

  /** the live server's commit (short hash), or null when neither the module file nor the page gives it */
  async liveRev() {
    if (Date.now() - this.live.at < LIVE_EVERY_MS) return this.live.rev;
    const rev = j => /^[0-9a-f]{4,40}$/.test(j?.rev ?? '') ? j.rev : null;
    let found = null, via = null;
    if (this.liveFile && fs.existsSync(this.liveFile)) {
      try { found = rev(JSON.parse(fs.readFileSync(this.liveFile, 'utf8'))); via = 'file'; }
      catch (e) { console.error(`[repo] live version from ${this.liveFile}: ${e.message}`); }
    }
    if (!found && this.liveUrl) {
      try {
        const r = await fetch(this.liveUrl, { signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache', accept: 'application/json' } });
        const text = await r.text();
        if (!text.trimStart().startsWith('{')) throw new Error(`HTTP ${r.status}, not JSON (a Cloudflare check?)`);
        found = rev(JSON.parse(text)); via = 'page';
      } catch (e) { console.error(`[repo] live version from ${this.liveUrl}: ${e.message}`); }
    }
    this.live = { rev: found, at: Date.now(), via: found ? via : null };
    return found;
  }

  async has(rev) {
    try { await this.git(['cat-file', '-e', `${rev}^{commit}`]); return true; } catch { return false; }
  }

  async file(rel) {
    try { return fs.readFileSync(path.join(this.dir, rel), 'utf8'); } catch { return ''; }
  }

  /** what changed lately, as the model's starting point: the live commit, what is not live yet, the last days */
  async recent(days = 4) {
    const fmt = ['--no-merges', '--date=format:%Y-%m-%d %H:%M', '--format=%h %cd %s'];
    const head = (await this.git(['log', '-1', ...fmt])).trim();
    const live = await this.liveRev();
    const known = live && await this.has(live);
    const out = { head, live: live ? `${live} (not in this copy of the code)` : 'unknown (the bot could not read it just now)' };
    if (known) {
      out.live = (await this.git(['log', '-1', ...fmt, live])).trim();
      out.notLive = (await this.git(['log', ...fmt, '-n', '40', `${live}..HEAD`])).trim();
      out.recent = (await this.git(['log', ...fmt, '-n', '80', `--since=${days} days ago`, live])).trim();
    } else {
      out.recent = (await this.git(['log', ...fmt, '-n', '80', `--since=${days} days ago`])).trim();
    }
    return out;
  }
}
