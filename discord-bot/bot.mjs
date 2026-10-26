// The forum bot: reads every channel it can see (archive.mjs), and answers only in forum threads, where a new post
// gets one look (investigate.mjs) once its author has stopped adding to it.  It says something only when it has a
// verified fix or needs information the post lacks; after it asked, the author's next post gets one more look.  It
// stays out of threads the staff answered and stops after BOT_MAX_REPLIES replies in a thread.  A report the developer
// should act on goes to the staff channel (BOT_STAFF_CHANNEL) with the thread's link, the bot's notes and its log files;
// a later report of the same problem is added to that message, not posted again.
//   node --env-file=.env bot.mjs        (settings: README.md)
import { ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.mjs';
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
  liveUrl: env.BOT_LIVE_URL || 'https://nfsu2.xyz/game.json',
};
if (!CFG.token) { console.error('DISCORD_TOKEN is not set (README.md)'); process.exit(2); }

const TEXT_EXT = /\.(log|txt|json|ini|csv|md|cfg)$/i;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_TEXT = 10 << 20, MAX_IMAGE = 3_500_000, MAX_IMAGES = 4;
const MAX_UPLOAD = 8 << 20, MAX_UPLOADS = 3;    // log files copied into a staff report (Discord takes 10 MB a message)
const MAX_WAIT_MS = 10 * 60_000;                 // a thread that keeps growing is looked at after 10 minutes anyway

fs.mkdirSync(CFG.state, { recursive: true });
const STATE_FILE = path.join(CFG.state, 'threads.json');
const VERDICTS = path.join(CFG.state, 'verdicts.jsonl');
/** per thread: { title, forum, created, status: new|none|asked|answered|staff|failed, replies, summary, category,
 *  staffMsg: the staff channel message about it (its own, or the earlier report it was added to) } */
let threads = {};
try { threads = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first start */ }
function save() {
  const cut = Date.now() - 30 * 86400_000;
  for (const [id, t] of Object.entries(threads)) if (Date.parse(t.created) < cut) delete threads[id];
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(threads, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

const archive = CFG.archive ? new Archive(path.join(CFG.state, 'archive')) : null;
const repo = new Repo({ source: CFG.repo, branch: CFG.branch, dir: path.join(CFG.state, 'repo'), liveUrl: CFG.liveUrl });
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

// ---------------------------------------------------------------------------------------------- when to look --
const timers = new Map();                        // thread id -> { timer, first }
const queue = [];
let busy = false;
function schedule(threadId, why) {
  const now = Date.now();
  const t = timers.get(threadId);
  if (t) clearTimeout(t.timer);
  if (t?.why === 'asked by staff') why = t.why;   // a staff request outlasts the poster's next message
  const first = t?.first ?? now;
  const delay = Math.max(0, Math.min(CFG.waitS * 1000, first + MAX_WAIT_MS - now));
  timers.set(threadId, { first, why, timer: setTimeout(() => { timers.delete(threadId); enqueue(threadId, why); }, delay) });
}
function enqueue(threadId, why) {
  if (!queue.some(q => q.threadId === threadId)) queue.push({ threadId, why });
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try { await look(job.threadId, job.why); } catch (e) { console.error(`[bot] ${job.threadId}: ${e.stack || e}`); }
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
async function look(threadId, why) {
  const thread = await client.channels.fetch(threadId).catch(() => null);
  const st = threads[threadId];
  if (!thread || !st || !watched(thread) || thread.archived || thread.locked) return;
  const byStaff = why === 'asked by staff';
  if (!byStaff && (st.status === 'staff' || st.replies >= CFG.maxReplies)) return;
  if (!underCap()) { console.log(`[bot] ${threadId}: skipped, ${CFG.maxPerDay} looks today already`); return; }

  const msgs = [...(await thread.messages.fetch({ limit: 100 })).values()].reverse();
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter && !msgs.some(m => m.id === starter.id)) msgs.unshift(starter);
  if (!byStaff && msgs.some(m => m.author.id !== client.user.id && isStaff(m.member, thread))) { st.status = 'staff'; save(); return; }

  const workDir = path.join(CFG.state, 'work', threadId);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const { text, images } = await transcript(thread, msgs, workDir, why);

  day.n++;
  const started = Date.now();
  const res = await investigate({
    client: anthropic, model: CFG.model, effort: CFG.effort, repo, archive, workDir,
    thread: text, images, threads: recentThreads(threadId, thread.guildId),
  });
  const v = res.verdict;
  const { post, why: outcome } = vet(v, { minConfidence: CFG.minConfidence });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[bot] ${threadId} "${st.title}" (${why}): ${outcome}${post ? (CFG.dryRun ? ', dry run' : ', posted') : ''}; ` +
    `${res.turns} turns, ${secs} s${res.cost != null ? `, $${res.cost.toFixed(3)}` : ''}${v ? `; ${v.summary}` : ''}`);

  if (post && !CFG.dryRun) {
    const lastOp = [...msgs].reverse().find(m => m.author.id === thread.ownerId);
    await thread.send({
      content: post,
      allowedMentions: { parse: [], repliedUser: false },
      ...(st.replies && lastOp ? { reply: { messageReference: lastOp.id, failIfNotExists: false } } : {}),
    });
  }
  if (post) st.replies++;
  if (v) Object.assign(st, { summary: v.summary, category: v.category });
  st.status = !v ? 'failed' : post ? (v.action === 'ask' ? 'asked' : 'answered') : st.status === 'asked' ? 'asked-none' : 'none';
  if (v && CFG.staffChannel) await tellStaff(thread, st, v, post, workDir).catch(e => console.error(`[bot] staff channel: ${e.message}`));
  save();
  fs.appendFileSync(VERDICTS, JSON.stringify({
    at: new Date().toISOString(), thread: threadId, title: st.title, why, outcome, dryRun: CFG.dryRun, post,
    verdict: v, turns: res.turns, cost: res.cost, usage: res.usage, tools: res.log,
  }) + '\n');
  fs.rmSync(workDir, { recursive: true, force: true });
}

/** the thread as the model reads it, with its attachments saved to workDir and its images inlined */
async function transcript(thread, msgs, workDir, why) {
  const tags = (thread.appliedTags ?? []).map(id => thread.parent.availableTags?.find(t => t.id === id)?.name).filter(Boolean);
  const lines = [`Forum: #${thread.parent.name}`, `Title: ${thread.name}`, `Tags: ${tags.join(', ') || 'none'}`,
    `Why the bot looks now: ${WHY[why] ?? why}`, ''];
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
      if ((type.startsWith('text/') || TEXT_EXT.test(a.name)) && a.size <= MAX_TEXT) {
        const data = await download(a.url);
        if (data) {
          const name = `${++n}-${a.name.replace(/[^\w.-]+/g, '_')}`;
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
/** a report for the developer: a new message, or a line added to the message about the same problem */
async function tellStaff(thread, st, v, post, workDir) {
  const link = `https://discord.com/channels/${thread.guildId}/${thread.id}`;
  const earlier = v.duplicate_of && v.duplicate_of !== thread.id ? threads[v.duplicate_of]?.staffMsg : null;
  if (!v.escalate && !earlier && !(post && CFG.dryRun)) return;
  const staff = await client.channels.fetch(CFG.staffChannel);
  if (!staff?.isTextBased()) throw new Error(`${CFG.staffChannel} is not a text channel the bot can see`);
  const did = !post ? 'did not reply' : v.action === 'ask' ? 'asked the poster for more' : 'answered the poster';
  const dry = CFG.dryRun && post ? `\n-# Dry run, not posted. The reply:\n${quote(post)}` : '';

  if (earlier && !st.staffMsg) {                 // the same problem again: one more link on that message, no new ping
    const m = await staff.messages.fetch(earlier).catch(() => null);
    if (m) {
      const also = m.content.match(/^Also reported: .*$/m);
      const content = also ? m.content.replace(also[0], `${also[0]}, ${link}`) : `${m.content}\nAlso reported: ${link}`;
      if (content.length <= 2000) { await m.edit({ content, allowedMentions: { parse: [] } }); st.staffMsg = earlier; }
    }
  }
  if (!v.escalate || st.staffMsg) {              // nothing new for the developer; in a dry run, the reply for review
    if (dry) await staff.send({ content: `${link} · ${v.summary}${dry}`.slice(0, 2000), allowedMentions: { parse: [] } });
    return;
  }
  const files = fs.readdirSync(workDir).map(f => path.join(workDir, f))
    .filter(f => fs.statSync(f).size <= MAX_UPLOAD).slice(0, MAX_UPLOADS)
    .map(f => ({ attachment: f, name: path.basename(f).replace(/^\d+-/, '') }));
  const head = `**${v.summary}**\n${link} · ${st.forum} · ${v.category}`;
  const tail = `-# The bot ${did}.${dry}`;
  const body = v.notes.trim().slice(0, Math.max(0, 2000 - head.length - tail.length - 2));
  const m = await staff.send({ content: `${head}\n${body}\n${tail}`.slice(0, 2000), files, allowedMentions: { parse: [] } });
  st.staffMsg = m.id;
}

const quote = s => s.split('\n').map(l => `> ${l}`).join('\n');

const WHY = {
  'new post': 'a new post',
  'follow-up': 'the poster wrote again after the bot asked for information',
  'mentioned': 'the poster mentioned the bot or replied to it',
  'asked by staff': 'staff mentioned the bot: they want its look, so answer or ask unless there is nothing useful to say',
};

async function download(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch { return null; }
}

function recentThreads(except, guildId) {
  return Object.entries(threads)
    .filter(([id, t]) => id !== except && t.summary)
    .sort((a, b) => b[1].created.localeCompare(a[1].created))
    .slice(0, 40)
    .map(([id, t]) => `- ${id} https://discord.com/channels/${guildId}/${id} [${t.category}, ${t.status}` +
      `${t.staffMsg ? ', developer told' : ''}] ${t.title}: ${t.summary}`)
    .join('\n');
}

// ------------------------------------------------------------------------------------------------- events --
client.on(Events.ClientReady, c => {
  console.log(`[bot] ${c.user.tag} on ${c.guilds.cache.size} server(s); ${CFG.dryRun ? 'dry run (replies go to the staff channel only), ' : ''}` +
    `${CFG.forums.length ? `forums ${CFG.forums.join(', ')}` : 'every forum'}, ` +
    `${CFG.staffChannel ? `staff channel ${CFG.staffChannel}` : 'no staff channel'}, model ${CFG.model} (${CFG.effort})`);
  repo.sync(true).catch(e => console.error(`[repo] ${e.message}`));
  // posts that came in shortly before a restart still get their look
  for (const [id, t] of Object.entries(threads)) if (t.status === 'new' && Date.now() - Date.parse(t.created) < 86400_000) schedule(id, 'new post');
});

/** an event handler that logs what goes wrong instead of taking the bot down */
const guard = (name, fn) => (...a) => { try { fn(...a); } catch (e) { console.error(`[bot] ${name}: ${e.stack || e}`); } };

client.on(Events.ThreadCreate, guard('new thread', (thread, created) => {
  if (!created || !watched(thread) || threads[thread.id]) return;
  threads[thread.id] = { title: thread.name, forum: thread.parent.name, created: new Date().toISOString(), status: 'new', replies: 0 };
  save();
  schedule(thread.id, 'new post');
}));

client.on(Events.MessageCreate, guard('message', m => {
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
  // a mention by name; for the poster a reply to the bot's message counts too
  const named = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
  const replied = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  if (isStaff(m.member, thread)) {
    if (named) { schedule(thread.id, 'asked by staff'); return; }
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
