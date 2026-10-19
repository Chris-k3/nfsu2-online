// Loads the game module from the local server: /game.json (what was built)
// and /game.wasm, compiled while it streams in.  The progress comes from a
// clone of the response, so the original response still goes to
// compileStreaming and Chrome can reuse its compiled-code cache for it.
// The server sends the module brotli-compressed and with an ETag, so a
// reload revalidates and reads it from Chrome's HTTP cache.

export interface GameInfo { pages: number; maxPages: number; guestEnd: number; rev: string; size: number; opt: string }
export interface Loaded {
  module: WebAssembly.Module; info: GameInfo;
  ms: number;              // fetch + compile, wall time
  transferred: number;     // bytes over the network (0 = from the HTTP cache), -1 unknown
}

export async function loadGame(onProgress: (got: number, total: number) => void, signal?: AbortSignal): Promise<Loaded> {
  const t0 = performance.now();
  const ir = await fetch('/game.json', { cache: 'no-store', signal });
  if (!ir.ok) throw new Error(`/game.json: HTTP ${ir.status} (build the game module on the Mac: web/build.sh)`);
  const info = await ir.json() as GameInfo;
  const url = new URL('/game.wasm', location.href).href;
  const r = await fetch(url, { cache: 'no-cache', signal });
  if (!r.ok) throw new Error(`/game.wasm: HTTP ${r.status}`);
  const total = info.size || +(r.headers.get('content-length') ?? 0);
  const counting = (async () => {
    const rd = r.clone().body!.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      got += value.length;
      onProgress(got, total);
    }
  })();
  const [module] = await Promise.all([WebAssembly.compileStreaming(r), counting]);
  const ms = performance.now() - t0;
  const pe = performance.getEntriesByName(url).pop() as PerformanceResourceTiming | undefined;
  return { module, info, ms, transferred: pe ? pe.transferSize : -1 };
}
