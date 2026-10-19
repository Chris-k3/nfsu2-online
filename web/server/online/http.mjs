// The online host's web pages (port 80 of 10.77.0.1): the two addresses the
// server config hands the game (lobby.mjs configFields), NEWSURL and TOSURL.
// The game fetches them with its own HTTP/1.0 client (ProtoHTTP) and runs the
// answer through EA's "web offer" script engine: a %{ CMD=... %} header line
// with the command and its fields, then the text.  Only the "news" command is
// ever served (a title, the text, one button that closes the page); never
// "card" (a credit-card form) or "prom", nor anything that collects input.
//
// One GET per connection, at most 4 KB of request, answered and closed.  The
// pages hold nothing about any player.

const PAGES = {
  '/news': {
    title: 'NFSU2 Online',
    // the welcome, then only the important changes from the original game; CRLF breaks a line (the box scrolls),
    // latin1: plain quotes and hyphens only
    text: [
      'Welcome to Online play on this server: open the Lobby, create a game or join one, ready up and race.',
      '',
      'Changes from the original game:',
      '- Online works again, on this server instead of EA\'s. You play under your own name, with no EA account.',
      '- Up to 6 players in every race type (the original had 4, and 6 only in Street X). Drag keeps one car per lane.',
      '- Every track is open, whatever your career has unlocked, and a new game starts at 2 laps.',
      '- Free roam with other players: their cars drive in your city, with their names over them.',
      '- Widescreen, and up to 120 fps on a 120 Hz screen.',
    ].join('\r\n'),
  },
  '/tos': {
    title: 'Terms of Service',
    text: 'This server is a stand-in for the online service of the original game, run by whoever runs this server. ' +
      'Play fair and be kind in the chat.',
  },
};

/** a web-offer page: the script header, then the text (CRLF line ends, as the game's own pages had) */
export function offerPage(p) {
  const q = s => String(s).replace(/["%{}\r\n]/g, ' ');
  return `%{ CMD=news TITLE="${q(p.title)}" BTN1="OK" BTN1-GOTO="$quit" %}\r\n${p.text}\r\n`;
}

export function httpService(conn) {
  let buf = Buffer.alloc(0), done = false;
  const t = setTimeout(() => conn.destroy('http: no request'), 15_000);
  conn.onclose = () => clearTimeout(t);
  conn.onend = () => { if (!done) conn.end(); };
  conn.ondata = chunk => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 4096) { done = true; return conn.destroy('http: request too large'); }
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    done = true; clearTimeout(t);
    const m = /^(GET|HEAD) (\/[^ ?#]*)[^ ]* HTTP\/1\.[01]$/.exec(buf.toString('latin1', 0, buf.indexOf('\r\n')));
    const page = m ? PAGES[m[2].toLowerCase()] : null;
    const body = Buffer.from(page ? offerPage(page) : 'Not found\r\n', 'latin1');
    const head = `HTTP/1.0 ${page ? '200 OK' : m ? '404 Not Found' : '400 Bad Request'}\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    conn.write(Buffer.concat([Buffer.from(head, 'latin1'), m?.[1] === 'HEAD' ? Buffer.alloc(0) : body]));
    conn.end();
  };
}
