// The bot's own copy of the code: a clone of BOT_REPO (default: the checkout this folder is in) at BOT_BRANCH, fetched
// again before an investigation when it is more than 5 minutes old.  The model reads only this copy, never a working
// tree that someone is editing.  The live server's version comes from its game.json (`rev`, the module's commit).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FETCH_EVERY_MS = 5 * 60_000;
const LIVE_EVERY_MS = 60_000;

export class Repo {
  constructor({ source, branch, dir, liveUrl }) {
    Object.assign(this, { source, branch, dir, liveUrl });
    this.fetchedAt = 0;
    this.live = { rev: null, at: 0 };
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
      await this.git(['fetch', '--quiet', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`],
        { timeout: 120_000 });
      await this.git(['reset', '--quiet', '--hard', `origin/${this.branch}`]);
      await this.git(['clean', '-qfdx']);
      this.fetchedAt = Date.now();
    } catch (e) {
      console.error(`[repo] fetch failed, using the copy from ${new Date(this.fetchedAt).toISOString()}: ${e.message}`);
    }
  }

  /** the live server's commit (short hash), or null when the page cannot be read */
  async liveRev() {
    if (Date.now() - this.live.at < LIVE_EVERY_MS) return this.live.rev;
    try {
      const r = await fetch(this.liveUrl, { signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } });
      const j = await r.json();
      this.live = { rev: /^[0-9a-f]{4,40}$/.test(j.rev ?? '') ? j.rev : null, at: Date.now() };
    } catch (e) {
      console.error(`[repo] live version: ${e.message}`);
      this.live.at = Date.now();
    }
    return this.live.rev;
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
    const out = { head, live: live ? `${live} (not in this copy of the code)` : 'unknown (the live page did not answer)' };
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
