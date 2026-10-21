// Which server the tests and tools start: web/server/server.mjs under Node (the default), or a port of it, so the
// same tests and load tools run against either, side by side.  The ports take the same options and print the same
// lines:
//   NFSU2_SERVER=rust     out/web/server-rs/nfsu2-server, built by web/server-rs/build.sh ($NFSU2_SERVER_BIN: another)
//   NFSU2_SERVER=dotnet   out/web/server-dotnet/nfsu2-server.dll, built by web/server-dotnet/build.sh (its branch)
//   spawn(...serverCommand(script, args), opts)
// script: the Node server the caller would start.  Another script than web/server/server.mjs (a test's
// NFSU2_TEST_SERVER, a negative control) always runs under Node.  Node's own flags (execArgv) go to Node only: a port
// starts without them.  Unset (or empty), NFSU2_SERVER is node, and the command is the one the callers ran before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE_SERVER = path.join(REPO, 'web/server/server.mjs');
export const SERVER_IMPL = String(process.env.NFSU2_SERVER || 'node').toLowerCase();

/** [command, argv] that starts the server with args (impl: 'node', 'rust' or 'dotnet', NFSU2_SERVER's by default) */
export function serverCommand(script, args, execArgv = [], impl = SERVER_IMPL) {
  if (impl === 'node' || path.resolve(script) !== NODE_SERVER) return [process.execPath, [...execArgv, script, ...args]];
  if (impl === 'rust') {
    const bin = process.env.NFSU2_SERVER_BIN || path.join(REPO, 'out/web/server-rs/nfsu2-server');
    if (!fs.existsSync(bin)) throw new Error(`NFSU2_SERVER=rust: no ${bin} (web/server-rs/build.sh)`);
    return [bin, args];
  }
  if (impl !== 'dotnet') throw new Error(`NFSU2_SERVER: node, rust or dotnet, not "${impl}"`);
  const dll = process.env.NFSU2_SERVER_DLL || path.join(REPO, 'out/web/server-dotnet/nfsu2-server.dll');
  if (!fs.existsSync(dll)) throw new Error(`NFSU2_SERVER=dotnet: no ${dll} (web/server-dotnet/build.sh)`);
  const dotnet = process.env.DOTNET || [path.join(os.homedir(), '.dotnet/dotnet'), '/usr/share/dotnet/dotnet', '/usr/local/share/dotnet/dotnet',
    '/usr/lib/dotnet/dotnet'].find(f => fs.existsSync(f)) || 'dotnet';
  return [dotnet, [dll, ...args]];
}
