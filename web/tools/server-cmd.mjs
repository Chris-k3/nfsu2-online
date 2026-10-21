// Which server the tests and tools start: web/server/server.mjs under Node (the default), or a port of it, so the
// same tests and load tools run against either, side by side.  The port takes the same options and prints the same
// lines:
//   NFSU2_SERVER=rust     out/web/server-rs/nfsu2-server, built by web/server-rs/build.sh ($NFSU2_SERVER_BIN: another)
//   spawn(...serverCommand(script, args), opts)
// script: the Node server the caller would start.  Another script than web/server/server.mjs (a test's
// NFSU2_TEST_SERVER, a negative control) always runs under Node.  Node's own flags (execArgv) go to Node only: the
// port starts without them.  Unset (or empty), NFSU2_SERVER is node, and the command is the one the callers ran before.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE_SERVER = path.join(REPO, 'web/server/server.mjs');
export const SERVER_IMPL = String(process.env.NFSU2_SERVER || 'node').toLowerCase();

/** [command, argv] that starts the server with args (impl: 'node' or 'rust', NFSU2_SERVER's by default) */
export function serverCommand(script, args, execArgv = [], impl = SERVER_IMPL) {
  if (impl === 'node' || path.resolve(script) !== NODE_SERVER) return [process.execPath, [...execArgv, script, ...args]];
  if (impl !== 'rust') throw new Error(`NFSU2_SERVER: node or rust, not "${impl}"`);
  const bin = process.env.NFSU2_SERVER_BIN || path.join(REPO, 'out/web/server-rs/nfsu2-server');
  if (!fs.existsSync(bin)) throw new Error(`NFSU2_SERVER=rust: no ${bin} (web/server-rs/build.sh)`);
  return [bin, args];
}
