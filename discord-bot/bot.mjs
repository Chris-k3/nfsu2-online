// The forum bot: reads every channel it can see (archive.mjs), and answers only in forum threads, where a new post
// gets one look (investigate.mjs) once its author has stopped adding to it.  It says something only when it has a
// verified fix or needs information the post lacks; after it asked, the author's next post gets one more look.  It
// stays out of threads the staff answered and stops after BOT_MAX_REPLIES replies in a thread.  A report the developer
// should act on goes to the staff channel (BOT_STAFF_CHANNEL) with the thread's link, the bot's notes and its log files,
// and gets a thread: later threads about the same problem and new logs in them go there.  When a release goes live,
// threads whose problem one of its commits fixes get a look ('fix live'), and a careful "may be fixed, reload" when the
// look is sure.
//   node --env-file=.env bot.mjs        (settings: README.md)
import { ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.mjs';
import { matchFixes } from './fixes.mjs';
import { General } from './general.mjs';
import { investigate, newClient, vet } from './investigate.mjs';
import { Repo, defaultSource } from './repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = s => (s ?? '').split(/[\s,]+/).filter(Boolean);
const CFG = {
  token: env.DISCORD_TOKEN,
  forums: list(env.BOT_FORUMS),                  // forum channel ids; empty: every forum
  staff: list(env.BOT_STAFF),                    // user or role ids, besides the owner and whoever can manage threads
  staffChannel: env.BOT_STAFF_CHANNEL || '',     // where reports for the developer go; empty: nowhere (verdicts.jsonl only)
  model: env.BOT_MODEL || 'claude-sonnet-5-5',
  effort: env.BOT_EFFORT || 'high',
  dryRun: env.BOT_DRY_RUN === '1',
  waitS: Number(env.BOT_WAIT_S || 120),
  maxReplies: Number(env.BOT_MAX_REPLIES || 2),
  maxPerDay: Number(env.BOT_MAX_PER_DAY || 80),
  minConfidence: env.BOT_MIN_CONFIDENCE || 'medium',
  archive: env.BOT_ARCHIVE !== '0',
  state: path.resolve(HERE, env.BOT_STATE || 'state'),
  repo: env.BOT_REPO || defaultSource(HERE),
  branch: env.BOT_BRANCH || 'main',
  liveUrl: env.BOT_LIVE_URL || 'https://nfsu2.xyz/game.json', liveFile: env.BOT_LIVE_FILE || '/live/nfsu2.json',
};
if (!CFG.token) { console.error('DISCORD_TOKEN is not set (README.md)'); process.exit(2); }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_TEXT = 10 << 20, MAX_IMAGE = 3_500_000, MAX_IMAGES = 4;
const MAX_UPLOAD = 8 << 20, MAX_UPLOADS = 3;    // files copied into a staff report (Discord takes 10 MB a message)
const SAVES_ZIP = /^nfsu2-saves-.*\.zip$/i;      // Saves, Download backup: for the developer, not for the model
const MAX_WAIT_MS = 10 * 60_000;                 // a thread that keeps growing is looked at after 10 minutes anyway
const STARTUP_MS = 48 * 3600_000;                // at start, the forums' posts of the last 48 hours, nothing older
const RELEASE_CHECK_MS = 5 * 60_000;             // how often the bot checks whether a new version went live
const FIX_DAYS = 14, FIX_MAX = 10;               // a release is checked against threads of the last 14 days, 10 messages at most

fs.mkdirSync(CFG.state, { recursive: true });
const STATE_FILE = path.join(CFG.state, 'threads.json');
const VERDICTS = path.join(CFG.state, 'verdicts.jsonl');
const LIVE_FILE = path.join(CFG.state, 'live.json');      // the live version the bot saw last
/** per thread: { title, forum, guild, created, active, status: new|seen|none|asked|answered|staff|failed, replies,
 *  summary, category, snippet (its first post, for threads the bot only indexed); for a problem reported to the staff:
 *  staffMsg, staffThread (the report and its thread), reports (how many threads, on the first one), reportOf (on the
 *  later ones: the first thread's id) } */
let threads = {};
try { threads = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first start */ }
function save() {
  const cut = Date.now() - 30 * 86400_000;
  for (const [id, t] of Object.entries(threads)) if (Date.parse(t.created) < cut) delete threads[id];
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(threads, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

const archive = CFG.archive ? new Archive(path.join(CFG.state, 'archive')) : null;
const repo = new Repo({ source: CFG.repo, branch: CFG.branch, dir: path.join(CFG.state, 'repo'), liveUrl: CFG.liveUrl, liveFile: CFG.liveFile });
const anthropic = newClient();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const isForum = ch => ch?.type === ChannelType.GuildForum || ch?.type === ChannelType.GuildMedia;
function watched(thread) {
  return thread?.isThread() && isForum(thread.parent) && (!CFG.forums.length || CFG.forums.includes(thread.parentId));
}
function isStaff(member, channel) {
  if (!member) return false;
  if (member.id === member.guild.ownerId || CFG.staff.includes(member.id)) return true;
  if (member.roles?.cache?.some(r => CFG.staff.includes(r.id))) return true;
  return !!channel && member.permissionsIn(channel).has(PermissionFlagsBits.ManageThreads);
}

// the general channels (general.mjs): nudges to the forums, spikes and a daily digest for the staff
let releasedAt = 0;
const general = new General({
  client, anthropic, model: CFG.model, isStaff, staffChannel: CFG.staffChannel, dryRun: CFG.dryRun, state: CFG.state,
  releasedAt: () => releasedAt,
  bugForum: guild => guild?.channels.cache.find(ch => isForum(ch) && /bug/i.test(ch.name)) ?? null,
  forumThreads: () => Object.entries(threads)
    .filter(([, t]) => !t.archived && t.category !== 'suggestion' && !/suggest/i.test(t.forum ?? ''))
    .sort(byActivity).slice(0, 40)
    .map(([id, t]) => ({ id, line: `${id} | ${t.title} | ${(t.summary || t.snippet || '').slice(0, 120)}` })),
});

// ---------------------------------------------------------------------------------------------- when to look --
const timers = new Map();                        // thread id -> { timer, first }
const queue = [];
let busy = false;
function schedule(threadId, why) {
  const now = Date.now();
  const t = timers.get(threadId);
  if (t) clearTimeout(t.timer);
  if (why === 'asked by staff') {                // staff asked: no wait, and ahead of the other looks
    timers.delete(threadId);
    console.log(`[bot] ${threadId} "${threads[threadId]?.title}": asked by staff, looking now`);
    return enqueue(threadId, why, undefined, true);
  }
  const first = t?.first ?? now;
  const delay = Math.max(0, Math.min(CFG.waitS * 1000, first + MAX_WAIT_MS - now));
  if (!t) console.log(`[bot] ${threadId} "${threads[threadId]?.title}": ${why}, a look in ${Math.round(delay / 1000)} s unless more comes`);
  timers.set(threadId, { first, why, timer: setTimeout(() => { timers.delete(threadId); enqueue(threadId, why); }, delay) });
}
function enqueue(threadId, why, extra, first = false) {
  const queued = queue.findIndex(q => q.threadId === threadId);
  if (queued >= 0 && first) queue.splice(queued, 1);
  if (queued < 0 || first) queue[first ? 'unshift' : 'push']({ threadId, why, extra });
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try { await look(job.threadId, job.why, job.extra); } catch (e) { console.error(`[bot] ${job.threadId}: ${e.stack || e}`); }
  }
  busy = false;
}

const day = { date: '', n: 0 };
function underCap() {
  const d = new Date().toISOString().slice(0, 10);
  if (day.date !== d) Object.assign(day, { date: d, n: 0 });
  return day.n < CFG.maxPerDay;
}

// ---------------------------------------------------------------------------------------------------- a look --
async function look(threadId, why, extra) {
  const thread = await client.channels.fetch(threadId).catch(() => null);
  const st = threads[threadId];
  const say = s => console.log(`[look] ${threadId} ${s}`);
  if (!thread || !st || !watched(thread)) return say('skipped: the thread is gone or not in a watched forum');
  const fix = why === 'fix live';
  if (thread.locked || (thread.archived && !fix)) return say('skipped: closed or locked');
  st.guild ??= thread.guildId;
  const byStaff = why === 'asked by staff';
  if (fix && st.fixed) return say('skipped: already told that a fix went live');
  if (!byStaff && !fix && st.status === 'staff') return say('skipped: staff are in the thread');
  if (!byStaff && !fix && st.replies >= CFG.maxReplies) return say(`skipped: ${st.replies} replies already`);
  if (!underCap()) return say(`skipped: ${CFG.maxPerDay} looks today already`);

  const msgs = [...(await thread.messages.fetch({ limit: 100 })).values()].reverse();
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter && !msgs.some(m => m.id === starter.id)) msgs.unshift(starter);
  if (!byStaff && !fix && msgs.some(m => m.author.id !== client.user.id && isStaff(m.member, thread))) {
    st.status = 'staff'; save();
    return say('skipped: staff are in the thread');
  }

  const workDir = path.join(CFG.state, 'work', threadId), staffDir = `${workDir}-staff`;
  for (const d of [workDir, staffDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const { text, images } = await transcript(thread, msgs.filter(m => !m.system), workDir, staffDir, why, extra);
  say(`"${st.title}" (${why}): ${msgs.length} message(s), ${fs.readdirSync(workDir).length} file(s), ` +
    `${fs.readdirSync(staffDir).length} save backup(s), ${images.length} picture(s)`);

  day.n++;
  const started = Date.now();
  const res = await investigate({
    client: anthropic, model: CFG.model, effort: CFG.effort, repo, archive, workDir,
    thread: text, images, threads: recentThreads(threadId), threadIndex: () => threadIndex(threadId), step: say,
  });
  const v = res.verdict;
  const { post, why: outcome } = fix && v?.action !== 'answer' ? { post: null, why: v?.action ?? 'no verdict' }
    : vet(v, { minConfidence: fix ? 'high' : CFG.minConfidence });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  say(`done: ${outcome}${post ? (CFG.dryRun ? ', dry run (to the staff channel)' : ', posted in the thread') : ', nothing posted'}; ` +
    `${res.turns} turns, ${secs} s${res.cost != null ? `, $${res.cost.toFixed(3)}` : ''}`);
  if (post) say(`reply: ${post.split('\n')[0].slice(0, 160)}`);

  if (post && !CFG.dryRun) {
    const lastOp = [...msgs].reverse().find(m => m.author.id === thread.ownerId);
    await thread.send({
      content: post,
      allowedMentions: { parse: [], repliedUser: false },
      ...(st.replies && lastOp ? { reply: { messageReference: lastOp.id, failIfNotExists: false } } : {}),
    });
  }
  if (fix) {                                     // a fix notice changes nothing else about the thread
    st.fixChecked = extra.rev;
    if (post) st.fixed = extra.rev;
    if (post && CFG.staffChannel && st.staffMsg) {
      const staff = await client.channels.fetch(CFG.staffChannel).catch(() => null);
      const th = staff && await reportThread(staff, threads[st.reportOf] ?? st);
      await th?.send({ content: `**Fix live** (${extra.commit}): ${CFG.dryRun ? 'the bot would have told' : 'the bot told'} ` +
        `${linkOf(thread.guildId, thread.id)} that it may be fixed.`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    if (CFG.dryRun && post && CFG.staffChannel) await tellStaff(thread, st, { ...v, escalate: false, duplicate_of: '' }, post, [workDir, staffDir]).catch(() => {});
    save();
    fs.appendFileSync(VERDICTS, JSON.stringify({ at: new Date().toISOString(), thread: threadId, title: st.title, why, extra, outcome,
      dryRun: CFG.dryRun, post, verdict: v, turns: res.turns, cost: res.cost, usage: res.usage, tools: res.log }) + '\n');
    for (const d of [workDir, staffDir]) fs.rmSync(d, { recursive: true, force: true });
    return;
  }
  if (post) st.replies++;
  if (v) Object.assign(st, { summary: v.summary, category: v.category });
  st.status = !v ? 'failed' : post ? (v.action === 'ask' ? 'asked' : 'answered') : st.status === 'asked' ? 'asked-none' : 'none';
  if (v && CFG.staffChannel) await tellStaff(thread, st, v, post, [workDir, staffDir]).catch(e => console.error(`[bot] staff channel: ${e.message}`));
  save();
  fs.appendFileSync(VERDICTS, JSON.stringify({
    at: new Date().toISOString(), thread: threadId, title: st.title, why, outcome, dryRun: CFG.dryRun, post,
    verdict: v, turns: res.turns, cost: res.cost, usage: res.usage, tools: res.log,
  }) + '\n');
  for (const d of [workDir, staffDir]) fs.rmSync(d, { recursive: true, force: true });
}

/** the thread as the model reads it: text attachments saved to workDir (whatever their name: a chrome://gpu report
 *  comes as .txt.phps, a long paste as message.txt), save backups to staffDir for the staff report, images inlined */
async function transcript(thread, msgs, workDir, staffDir, why, extra) {
  const tags = (thread.appliedTags ?? []).map(id => thread.parent.availableTags?.find(t => t.id === id)?.name).filter(Boolean);
  const lines = [`Forum: #${thread.parent.name}`, `Title: ${thread.name}`, `Tags: ${tags.join(', ') || 'none'}`,
    `Why the bot looks now: ${WHY[why] ?? why}`, ...(extra?.text ? [extra.text] : []), ''];
  const images = [];
  let n = 0;
  for (const m of msgs) {
    const who = m.author.id === client.user.id ? 'this bot' : m.author.id === thread.ownerId ? 'the poster'
      : isStaff(m.member, thread) ? 'staff' : 'another member';
    lines.push(`[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC] ${m.member?.displayName ?? m.author.username} (${who}):`);
    if (m.content) lines.push(m.content);
    for (const a of m.attachments.values()) {
      const kb = `${Math.round(a.size / 1024)} KB`;
      const type = (a.contentType ?? '').split(';')[0];
      if (IMAGE_TYPES.includes(type) && a.size <= MAX_IMAGE && images.length < MAX_IMAGES) {
        const data = await download(a.url);
        if (data) { images.push({ type, data: data.toString('base64') }); lines.push(`  [picture ${images.length}: ${a.name}]`); continue; }
      }
      const name = `${++n}-${a.name.replace(/[^\w.-]+/g, '_')}`;
      if (SAVES_ZIP.test(a.name) && a.size <= MAX_UPLOAD) {
        const data = await download(a.url);
        if (data) { fs.writeFileSync(path.join(staffDir, name), data); lines.push(`  [saves backup: ${a.name}, ${kb} (a zip, not readable here)]`); continue; }
      }
      if (!/^(image|video|audio)\//.test(type) && !/\.(zip|7z|rar|mp4|mov|webm)$/i.test(a.name) && a.size <= MAX_TEXT) {
        const data = await download(a.url);
        if (data && !data.subarray(0, 8192).includes(0)) {
          fs.writeFileSync(path.join(workDir, name), data);
          lines.push(`  [attachment: attachments/${name}, ${kb}]`);
          continue;
        }
      }
      lines.push(`  [attachment not opened: ${a.name}, ${type || 'unknown type'}, ${kb}]`);
    }
    lines.push('');
  }
  return { text: lines.join('\n'), images };
}

// ------------------------------------------------------------------------------------------- the staff channel --
// A report is a message in the staff channel with a thread on it (in a forum channel: a post), and every thread about
// that problem points to it: the first one has staffMsg/staffThread/reports, the later ones reportOf and the same ids.
// Later threads about the problem, and new logs or pictures in any of them, go into the report's thread; the report
// message counts the threads.  Only the thread's followers are notified.

/** the report's first message (in a forum channel: its post's starter) */
async function reportMessage(staff, root) {
  if (staff.type === ChannelType.GuildForum) {
    const th = await client.channels.fetch(root.staffThread).catch(() => null);
    return th?.fetchStarterMessage().catch(() => null) ?? null;
  }
  return staff.messages.fetch(root.staffMsg).catch(() => null);
}

/** the report's thread, opened on a report from before there were threads */
async function reportThread(staff, root) {
  if (root.staffThread) return client.channels.fetch(root.staffThread).catch(() => null);
  const m = await reportMessage(staff, root);
  const th = await m?.startThread({ name: (root.summary || root.title).slice(0, 100), autoArchiveDuration: 10080 }).catch(() => null);
  if (th) root.staffThread = th.id;
  return th;
}

/** "Reports: N threads" on the report message */
async function countReports(staff, root) {
  const m = await reportMessage(staff, root);
  if (!m) return;
  const line = `-# Reports: ${root.reports} threads, the later ones in this report's thread.`;
  const content = /^-# Reports: .*$/m.test(m.content) ? m.content.replace(/^-# Reports: .*$/m, line) : `${m.content}\n${line}`;
  if (content.length <= 2000) await m.edit({ content, allowedMentions: { parse: [] } });
}

const linkOf = (guild, id) => `https://discord.com/channels/${guild}/${id}`;

/** files of this look for the staff: logs, other text and save backups, at most MAX_UPLOADS */
const staffFiles = dirs => dirs.flatMap(d => fs.readdirSync(d).map(f => path.join(d, f)))
  .filter(f => fs.statSync(f).size <= MAX_UPLOAD).slice(0, MAX_UPLOADS)
  .map(f => ({ attachment: f, name: path.basename(f).replace(/^\d+-/, '') }));

/** a look's verdict for the staff: a new report, an update in the report about the same problem, or nothing */
async function tellStaff(thread, st, v, post, dirs) {
  const link = linkOf(thread.guildId, thread.id);
  const dup = v.duplicate_of && v.duplicate_of !== thread.id && threads[v.duplicate_of] ? v.duplicate_of : null;
  const rootId = dup ? (threads[dup].reportOf ?? dup) : null;
  const root = rootId ? threads[rootId] : null;
  const reported = root?.staffMsg ? root : null;     // the problem already has a report
  if (!v.escalate && !reported && !(post && CFG.dryRun)) return;
  const staff = await client.channels.fetch(CFG.staffChannel);
  if (!staff?.isTextBased() && staff?.type !== ChannelType.GuildForum) throw new Error(`${CFG.staffChannel} is not a channel the bot can post in`);
  const did = !post ? 'did not reply' : v.action === 'ask' ? 'asked the poster for more' : 'answered the poster';
  const dry = CFG.dryRun && post ? `\n-# Dry run, not posted. The reply:\n${quote(post)}` : '';

  if (reported && !st.staffMsg) {                 // the same problem again: an update in its report's thread
    const th = await reportThread(staff, reported);
    if (th) {
      await th.send({ content: `**Also reported:** ${link} · ${v.summary}\n${v.notes.trim()}\n-# The bot ${did}.${dry}`.slice(0, 2000),
        files: staffFiles(dirs), allowedMentions: { parse: [] } });
      Object.assign(st, { staffMsg: reported.staffMsg, staffThread: reported.staffThread, reportOf: rootId });
      reported.reports = (reported.reports ?? 1) + 1;
      await countReports(staff, reported);
      console.log(`[staff] ${thread.id} added to the report on ${rootId} (${reported.reports} threads)`);
      return;
    }
    const m = await reportMessage(staff, reported);   // no thread (no right to open one): a link on the report
    const content = `${m?.content}\nAlso reported: ${link}`;
    if (m && content.length <= 2000) {
      await m.edit({ content, allowedMentions: { parse: [] } });
      Object.assign(st, { staffMsg: reported.staffMsg, reportOf: rootId });
      reported.reports = (reported.reports ?? 1) + 1;
      return;
    }
  }
  if (!v.escalate || st.staffMsg) {              // nothing new for the developer; in a dry run, the reply for review
    if (dry) await staff.send({ content: `${link} · ${v.summary}${dry}`.slice(0, 2000), allowedMentions: { parse: [] } });
    return;
  }
  // a new report; an earlier thread about the problem that nobody reported joins it
  const earlier = root && !root.staffMsg ? `\nEarlier: ${linkOf(thread.guildId, rootId)} · ${root.title}` : '';
  const head = `**${v.summary}**\n${link} · ${st.forum} · ${v.category}${earlier}`;
  const tail = `-# The bot ${did}.${dry}`;
  const body = v.notes.trim().slice(0, Math.max(0, 1900 - head.length - tail.length));
  const content = `${head}\n${body}\n${tail}`.slice(0, 1900);
  const name = (v.summary || st.title).slice(0, 100);
  let m, th;
  if (staff.type === ChannelType.GuildForum) {
    th = await staff.threads.create({ name, message: { content, files: staffFiles(dirs), allowedMentions: { parse: [] } } });
    m = { id: th.id };
  } else {
    m = await staff.send({ content, files: staffFiles(dirs), allowedMentions: { parse: [] } });
    th = await m.startThread({ name, autoArchiveDuration: 10080 }).catch(e => { console.error(`[bot] report thread: ${e.message}`); return null; });
  }
  Object.assign(st, { staffMsg: m.id, staffThread: th?.id, reports: 1 });
  console.log(`[staff] ${thread.id} reported to the staff${th ? ', with a thread for updates' : ' (no thread: no right to open one?)'}`);
  if (earlier) {
    Object.assign(root, { staffMsg: m.id, staffThread: th?.id, reportOf: thread.id });
    st.reports = 2;
    await countReports(staff, st);
  }
}

/** a new log or picture in a thread that has a report: into the report's thread, with the files */
async function relay(m, st) {
  const staff = await client.channels.fetch(CFG.staffChannel).catch(() => null);
  const root = threads[st.reportOf] ?? st;
  const th = staff && await reportThread(staff, root);
  if (!th) return;
  const files = [];
  for (const a of m.attachments.values()) {
    if (a.size > MAX_UPLOAD || files.length >= MAX_UPLOADS) continue;
    const data = await download(a.url);
    if (data) files.push({ attachment: data, name: a.name });
  }
  const who = m.author.id === m.channel.ownerId ? 'the poster' : 'a member';
  const text = m.content.replace(/\s+/g, ' ').slice(0, 400);
  await th.send({ content: `**New in** ${linkOf(m.guildId, m.channelId)} (${who})${text ? `: ${text}` : ''}`.slice(0, 2000),
    files, allowedMentions: { parse: [] } });
  console.log(`[staff] ${m.channelId}: ${files.length} file(s) from ${who} passed on to its report`);
}

const quote = s => s.split('\n').map(l => `> ${l}`).join('\n');

const WHY = {
  'new post': 'a new post',
  'follow-up': 'the poster wrote again after the bot asked for information',
  'mentioned': 'the poster mentioned the bot or replied to it',
  'asked by staff': 'staff mentioned the bot: they want its look, so answer or ask unless there is nothing useful to say',
  'fix live': 'a release just went live, and a commit in it may fix this thread\'s problem (see "When a fix goes live")',
};

// ---------------------------------------------------------------------------------------------- a release --
/** a new live version: the threads its commits may fix get a 'fix live' look; at most FIX_MAX of them */
async function checkRelease() {
  const rev = await repo.liveRev();
  if (!rev) return;
  let last = null;
  try { last = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')).rev; } catch { /* first start */ }
  if (last === rev) return;
  // the new version is kept once this release is dealt with, so a check that fails is tried again next time
  const seen = () => fs.writeFileSync(LIVE_FILE, JSON.stringify({ rev, at: new Date().toISOString() }));
  if (!last) { seen(); return console.log(`[release] live is ${rev}`); }
  await repo.sync(true);
  if (!(await repo.has(last)) || !(await repo.has(rev))) { seen(); return console.log(`[release] live ${last} -> ${rev}: not both in the code copy, skipped`); }
  const commits = (await repo.git(['log', '--no-merges', '-n', '60', '--format=commit %h %s%n%b', `${last}..${rev}`])).trim();
  if (!commits) { seen(); return console.log(`[release] live ${last} -> ${rev}: no new commits (a rollback?)`); }
  const since = new Date(Date.now() - FIX_DAYS * 86400_000).toISOString();
  const candidates = Object.entries(threads)
    .filter(([, t]) => t.created >= since && !t.fixed && t.fixChecked !== rev && !['suggestion', 'question'].includes(t.category))
    .sort(byActivity).slice(0, 200)
    .map(([id, t]) => ({ id, line: `${id} | #${t.forum} | ${t.created.slice(0, 10)} | ${t.category ?? '?'} | ${t.title} | ${t.summary || t.snippet || ''}` }));
  const n = commits.split('\ncommit ').length;
  console.log(`[release] live ${last} -> ${rev}: ${n} commit(s), checking ${candidates.length} thread(s)`);
  const { matches, error } = await matchFixes({ client: anthropic, model: CFG.model, effort: CFG.effort, commits: commits.slice(0, 60_000), candidates });
  if (error) return console.log(`[release] matching failed, again at the next check: ${error}`);
  seen();
  releasedAt = Date.now();
  console.log(`[release] ${matches.length} thread(s) may be fixed${matches.length ? `: ${matches.map(m => `${m.thread} (${m.commit})`).join(', ')}` : ''}`);
  for (const m of matches.slice(0, FIX_MAX)) {
    const body = (await repo.git(['show', '--no-patch', '--format=%h %s%n%n%b', m.commit]).catch(() => '')).trim().slice(0, 1500);
    console.log(`[release] ${m.thread}: ${m.why}`);
    enqueue(m.thread, 'fix live', { rev, commit: m.commit, text: `The commit that went live:\n${body || m.commit}\nWhy it may be this thread's problem: ${m.why}` });
  }
}

async function download(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch { return null; }
}

/** one known thread as the model sees it */
function threadLine([id, t]) {
  const what = t.summary || (t.snippet ? `first post: ${t.snippet}` : '');
  return `- ${id} https://discord.com/channels/${t.guild}/${id} #${t.forum}, ${(t.active ?? t.created).slice(0, 10)} ` +
    `[${[t.category, t.status, t.staffMsg && 'developer told'].filter(Boolean).join(', ')}] ${t.title}${what ? `: ${what}` : ''}`;
}
const byActivity = (a, b) => (b[1].active ?? b[1].created).localeCompare(a[1].active ?? a[1].created);
/** the threads active last, for the context */
function recentThreads(except) {
  return Object.entries(threads).filter(([id]) => id !== except).sort(byActivity).slice(0, 30).map(threadLine).join('\n');
}
/** every known thread, for the search_threads tool: [{ line, text }] */
function threadIndex(except) {
  return Object.entries(threads).filter(([id]) => id !== except).sort(byActivity)
    .map(e => ({ line: threadLine(e), text: `${e[1].title}\n${e[1].summary ?? ''}\n${e[1].snippet ?? ''}` }));
}

/** the forums' threads with posts in the last STARTUP_MS (titles, first posts), so the bot can point to them; the
 *  ones opened in that time that it never looked at get their look now, so a restart misses no post.  Nothing older */
async function indexForums() {
  const since = Date.now() - STARTUP_MS;
  const snowflakeTime = id => Number((BigInt(id) >> 22n) + 1420070400000n);
  const found = [];
  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    for (const t of active?.threads.values() ?? []) {
      if (!watched(t) || Math.max(t.createdTimestamp, t.lastMessageId ? snowflakeTime(t.lastMessageId) : 0) < since) continue;
      const fresh = !threads[t.id] && t.createdTimestamp >= since;
      const st = threads[t.id] ??= { title: t.name, forum: t.parent.name, guild: guild.id, created: t.createdAt.toISOString(),
        status: fresh ? 'new' : 'seen', replies: 0 };
      st.title = t.name;
      if (fresh) schedule(t.id, 'new post');
      if (!st.snippet && !st.summary) found.push(t);
    }
  }
  save();
  console.log(`[bot] forums: ${found.length} threads with posts in the last ${STARTUP_MS / 3600_000} h read, ` +
    `${Object.values(threads).filter(t => t.status === 'new').length} waiting for a look`);
  for (const t of found) {                         // one at a time: discord.js waits out the rate limits
    const m = await t.fetchStarterMessage().catch(() => null);
    if (m) threads[t.id].snippet = m.content.replace(/\s+/g, ' ').slice(0, 200);
  }
  save();
}

// ------------------------------------------------------------------------------------------------- events --
client.on(Events.ClientReady, c => {
  console.log(`[bot] ${c.user.tag} on ${c.guilds.cache.size} server(s); ${CFG.dryRun ? 'dry run (replies go to the staff channel only), ' : ''}` +
    `${CFG.forums.length ? `forums ${CFG.forums.join(', ')}` : 'every forum'}, ` +
    `${CFG.staffChannel ? `staff channel ${CFG.staffChannel}` : 'no staff channel'}, model ${CFG.model} (${CFG.effort})`);
  repo.sync(true).catch(e => console.error(`[repo] ${e.message}`));
  const release = () => checkRelease().catch(e => console.error(`[release] ${e.message}`));
  indexForums().catch(e => console.error(`[bot] forum index: ${e.message}`)).finally(release);
  setInterval(release, RELEASE_CHECK_MS);
  setInterval(() => general.tick().catch(e => console.error(`[general] ${e.message}`)), 60_000);
  // posts that came in shortly before a restart still get their look
  for (const [id, t] of Object.entries(threads)) if (t.status === 'new' && Date.now() - Date.parse(t.created) < STARTUP_MS) schedule(id, 'new post');
});

/** an event handler that logs what goes wrong instead of taking the bot down */
const guard = (name, fn) => (...a) => { try { fn(...a); } catch (e) { console.error(`[bot] ${name}: ${e.stack || e}`); } };

client.on(Events.ThreadCreate, guard('new thread', (thread, created) => {
  if (!created || !watched(thread) || threads[thread.id]) return;
  const now = new Date().toISOString();
  threads[thread.id] = { title: thread.name, forum: thread.parent.name, guild: thread.guildId, created: now, active: now, status: 'new', replies: 0 };
  save();
  schedule(thread.id, 'new post');
}));

client.on(Events.MessageCreate, guard('message', m => {
  if (m.system) return;                          // "changed the post title", pins, joins
  general.onMessage(m);
  if (archive && m.guild) {
    archive.add({
      id: m.id, at: m.createdAt.toISOString(),
      channel: m.channel.isThread() ? m.channel.parent?.name : m.channel.name, thread: m.channel.isThread() ? m.channel.name : '',
      author: m.member?.displayName ?? m.author.username, text: m.content.slice(0, 4000), files: [...m.attachments.values()].map(a => a.name),
    });
  }
  const thread = m.channel;
  if (m.author.bot || !watched(thread)) return;
  const st = threads[thread.id];
  if (!st) return;
  st.active = m.createdAt.toISOString();
  if (st.staffMsg && CFG.staffChannel && m.attachments.size && !isStaff(m.member, thread)) {
    relay(m, st).catch(e => console.error(`[bot] relay to the report: ${e.message}`));
  }
  // a mention by name; for the poster a reply to the bot's message counts too
  const named = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
  const replied = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  if (isStaff(m.member, thread)) {
    if (named) { schedule(thread.id, 'asked by staff'); return; }
    if (st.status !== 'staff') console.log(`[bot] ${thread.id} "${st.title}": staff wrote, the bot stays out`);
    st.status = 'staff'; save();
    const t = timers.get(thread.id); if (t) { clearTimeout(t.timer); timers.delete(thread.id); }
    return;
  }
  if (st.status === 'staff') return;
  if (st.status === 'new') { if (m.author.id === thread.ownerId) schedule(thread.id, 'new post'); return; }
  if (st.status === 'asked' && m.author.id === thread.ownerId) { schedule(thread.id, 'follow-up'); return; }
  if (replied && m.author.id === thread.ownerId) schedule(thread.id, 'mentioned');
}));
client.on(Events.Error, e => console.error(`[bot] discord: ${e.message}`));
process.on('unhandledRejection', e => console.error(`[bot] ${e?.stack || e}`));

client.login(CFG.token).catch(e => { console.error(`[bot] login: ${e.message}`); process.exit(1); });
