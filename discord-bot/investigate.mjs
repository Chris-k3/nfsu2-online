// One investigation: the thread goes to Claude with the bot's instructions (system.md), the maintainer's notes
// (knowledge.md) and the player's guide (docs/web/PLAYING.md), and Claude reads what it needs through the tools
// (tools.mjs) until it gives its verdict as JSON (VERDICT).  All three come from the bot's copy of the code, so a pushed
// change to them applies within minutes, without a new image; the bot's own system.md and knowledge.md until then.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, Tools } from './tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_TURNS = 30;

export const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['action', 'category', 'language', 'reply', 'disclaimer', 'summary', 'notes', 'escalate', 'duplicate_of', 'confidence'],
  properties: {
    action: { type: 'string', enum: ['none', 'ask', 'answer'] },
    category: { type: 'string', enum: ['crash', 'graphics', 'performance', 'controls', 'online', 'saves', 'audio', 'phone', 'suggestion', 'question', 'other'] },
    language: { type: 'string', description: 'the language of the reply, as a BCP 47 tag (en, pt-BR, ...)' },
    reply: { type: 'string', description: 'the message to post; "" for none' },
    disclaimer: { type: 'string' },
    summary: { type: 'string' },
    notes: { type: 'string', description: 'for the developer; posted in the staff channel when escalate is true' },
    escalate: { type: 'boolean', description: 'the developer should look at this' },
    duplicate_of: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

// $ per million tokens: input, output, cache write (5 minutes), cache read
const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
};

async function systemBlocks(repo) {
  const own = async f => (await repo.file(`discord-bot/${f}`)) || fs.readFileSync(path.join(HERE, f), 'utf8');
  const [rules, notes, playing] = [await own('system.md'), await own('knowledge.md'), await repo.file('docs/web/PLAYING.md')];
  return [
    { type: 'text', text: `${rules}\n\n${notes}` },
    { type: 'text', text: `# The player's guide (docs/web/PLAYING.md)\n\n${playing}`, cache_control: { type: 'ephemeral' } },
  ];
}

/** the first user message: what is going on (volatile, so after the cached system prompt), the pictures, the thread */
function opening({ now, recent, threads, thread, images }) {
  const ctx = [
    `Now: ${now}`,
    `Live version: ${recent.live}`,
    `Newest commit: ${recent.head}`,
    `Releases the bot saw (newest first):\n${recent.releases || 'none yet'}`,
    recent.notLive ? `Commits not live yet (newest first):\n${recent.notLive}` : 'Commits not live yet: none',
    `Commits of the last days up to the live version (newest first; when made, and when they went live):\n${recent.recent || 'none'}`,
    `Recent forum threads (id, category, what the bot did, title: summary):\n${threads || 'none yet'}`,
  ].join('\n\n');
  return [
    { type: 'text', text: `<context>\n${ctx}\n</context>` },
    ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })),
    {
      type: 'text', text: `<discord_thread>\n${thread}\n</discord_thread>\n\n` +
        (images.length ? `The ${images.length} picture(s) above are the thread's images, in the order listed.\n\n` : '') +
        'Investigate this thread as your instructions say, then give your verdict.',
    },
  ];
}

/** a tool call in a few words, for the log: search /iphone|ios/ in attachments/, read docs/web/PLAYING.md:520 */
function brief(name, i) {
  switch (name) {
    case 'search': return `search /${i.pattern}/${i.ignore_case ? 'i' : ''} in ${i.path || 'the code'}`;
    case 'read': return `read ${i.path}:${i.start_line || 1}`;
    case 'list': return `list ${i.path || '/'}`;
    case 'git_log': return `git log ${i.range || 'HEAD'}${i.grep ? ` grep /${i.grep}/` : ''}${i.path ? ` -- ${i.path}` : ''}`;
    case 'git_show': return `git show ${i.rev}${i.patch ? ' with diff' : ''}`;
    case 'search_threads': return `threads /${i.pattern}/`;
    case 'discord_search': return `messages /${i.pattern}/ ${i.days} d`;
    default: return name;
  }
}
/** a tool's result in a few words: how many lines or matches, or the error */
function gist(out) {
  if (out?.error) return `error: ${out.error}`;
  const text = String(out);
  if (/^(no matches|no commits|no threads|no messages|\(empty\))$/.test(text)) return text;
  const n = text.split('\n').length;
  return `${n} line${n === 1 ? '' : 's'}`;
}

/**
 * client: Anthropic; repo: Repo; archive: Archive|null; workDir: the thread's attachments;
 * thread: its text as built by the bot; images: [{type, data}]; threads: the recent-threads list as text;
 * threadIndex: () => every known thread, for search_threads; step: (text) => void, told each step as it happens
 * -> { verdict, usage, cost, turns, log }
 */
export async function investigate({ client, model, effort, repo, archive, workDir, thread, images = [], threads = '', threadIndex, step = () => {} }) {
  await repo.sync();
  const tools = new Tools({ repo, workDir, archive, threadIndex });
  const system = await systemBlocks(repo);
  const recent = await repo.recent();
  step(`code at ${recent.head.split(' ')[0]}, live ${recent.live.split(' ')[0]}${recent.notLive ? `, ${recent.notLive.split('\n').length} commit(s) not live yet` : ''}; asking ${model}`);
  const messages = [{ role: 'user', content: opening({ now: new Date().toISOString().slice(0, 16) + 'Z', recent, threads, thread, images }) }];
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const log = [];
  let verdict = null;

  for (let turn = 1; turn <= MAX_TURNS && !verdict; turn++) {
    const last = turn === MAX_TURNS;
    const res = await client.beta.messages.create({
      model, max_tokens: 16000, system, messages,
      tools: TOOL_DEFS,
      ...(last ? { tool_choice: { type: 'none' } } : {}),
      thinking: { type: 'adaptive' },
      output_config: { effort, format: { type: 'json_schema', schema: VERDICT } },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const u = res.usage;
    usage.input += u.input_tokens; usage.output += u.output_tokens;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0; usage.cacheRead += u.cache_read_input_tokens ?? 0;

    if (res.stop_reason === 'refusal') { log.push(`refused (${res.stop_details?.category ?? 'no category'})`); step(log.at(-1)); break; }
    if (res.stop_reason === 'max_tokens') { log.push('ran out of output tokens'); step(log.at(-1)); break; }
    messages.push({ role: 'assistant', content: res.content });

    const calls = res.content.filter(b => b.type === 'tool_use');
    if (res.stop_reason === 'tool_use' && calls.length) {
      const results = await Promise.all(calls.map(async c => {
        const out = await tools.run(c.name, c.input);
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        log.push(`${c.name} ${JSON.stringify(c.input)} -> ${text.length} chars${out?.error ? ` (error: ${out.error})` : ''}`);
        step(`${brief(c.name, c.input)} -> ${gist(out)}`);
        return { type: 'tool_result', tool_use_id: c.id, content: text, ...(out?.error ? { is_error: true } : {}) };
      }));
      const content = [...results];
      if (turn + 1 === MAX_TURNS) content.push({ type: 'text', text: 'That was the last tool call: give your verdict now.' });
      messages.push({ role: 'user', content });
      continue;
    }

    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try { verdict = JSON.parse(text); } catch { log.push(`no JSON verdict: ${text.slice(0, 200)}`); step(log.at(-1)); break; }
    step(`verdict after ${turn} turn${turn === 1 ? '' : 's'}: ${verdict.action}${verdict.escalate ? ' + tell the staff' : ''}` +
      `${verdict.duplicate_of ? `, same as ${verdict.duplicate_of}` : ''} (${verdict.confidence}): ${verdict.summary}`);
  }

  const p = PRICES[model];
  const cost = p ? (usage.input * p[0] + usage.output * p[1] + usage.cacheWrite * p[2] + usage.cacheRead * p[3]) / 1e6 : null;
  return { verdict, usage, cost, turns: messages.filter(m => m.role === 'assistant').length, log };
}

/**
 * what may be posted, or why not: a verdict that says nothing, a weak answer, or a reply that pastes code is dropped
 * -> { post: string|null, why }
 */
export function vet(v, { minConfidence = 'medium' } = {}) {
  if (!v) return { post: null, why: 'no verdict' };
  if (v.action === 'none') return { post: null, why: 'none' };
  const reply = (v.reply ?? '').trim();
  if (!reply) return { post: null, why: `${v.action} without a reply` };
  const rank = { low: 0, medium: 1, high: 2 };
  if (v.action === 'answer' && rank[v.confidence] < rank[minConfidence]) return { post: null, why: `answer at ${v.confidence} confidence` };
  for (const block of reply.match(/```[\s\S]*?```/g) ?? []) {
    if (block.split('\n').length > 8) return { post: null, why: 'a long code block' };
  }
  const disclaimer = (v.disclaimer ?? '').trim().replace(/\n+/g, ' ').slice(0, 150) || 'Automated AI reply, it may be wrong.';
  const room = 1990 - disclaimer.length - 6;
  let body = reply;
  if (body.length > room) {
    const nl = body.lastIndexOf('\n', room);
    body = body.slice(0, nl > room / 2 ? nl : room).trimEnd() + ' …';
  }
  return { post: `${body}\n\n-# ${disclaimer}`, why: v.action };
}

export const newClient = () => new Anthropic();
