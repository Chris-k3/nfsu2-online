// What this browser and this page need before the game can start, each with
// a message that says what to do when it is missing.  The start page shows
// only the ones that fail or warn.

export type CheckState = 'pending' | 'ok' | 'warn' | 'fail';
export interface Check { id: string; label: string; state: CheckState; detail: string }

export const MIN_CHROME = 140;

/** "Google Chrome" major version, or null (another browser), from User-Agent Client Hints. */
export function chromeVersion(): { brand: string; major: number } | null {
  const uad = (navigator as any).userAgentData as { brands?: { brand: string; version: string }[] } | undefined;
  const b = uad?.brands?.find(x => x.brand === 'Google Chrome') ?? uad?.brands?.find(x => x.brand === 'Chromium');
  if (b) return { brand: b.brand, major: parseInt(b.version, 10) };
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m ? { brand: 'Chromium', major: +m[1] } : null;
}

/**
 * Which browser this is: a warning at most, never a reason to stop.  What the
 * game needs is checked by what it is (WebGPU, isolation, storage below), so
 * another browser that has all of it may play.
 */
export function checkBrowser(): Check {
  const c = chromeVersion();
  const label = 'Browser';
  if (!c) return { id: 'browser', label, state: 'warn', detail: 'Only Google Chrome is tested. This browser may work if every other check passes.' };
  if (c.major < MIN_CHROME) return { id: 'browser', label: `Chrome ${c.major}`, state: 'warn', detail: `Only the latest Chrome is tested (${MIN_CHROME} or newer). Update Chrome (Help, About Google Chrome) if something does not work.` };
  if (c.brand !== 'Google Chrome') return { id: 'browser', label: `${c.brand} ${c.major}`, state: 'warn', detail: 'Only Google Chrome is tested. This browser may work if every other check passes.' };
  return { id: 'browser', label: `Chrome ${c.major}`, state: 'ok', detail: 'The tested browser.' };
}

export function checkIsolation(): Check {
  const label = 'Secure, isolated page';
  if (!isSecureContext) {
    return { id: 'isolation', label, state: 'fail',
      detail: 'This address is not secure, so Chrome turns off what the game needs. Open the server\'s https:// address instead.' };
  }
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    return { id: 'isolation', label, state: 'fail', detail: 'The page is not cross-origin isolated (no SharedArrayBuffer). Open it from the NFSU2 web server, not another server.' };
  }
  try { new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }); }
  catch (e) { return { id: 'isolation', label, state: 'fail', detail: `Shared 4 GB WebAssembly memory is not available: ${e}` }; }
  return { id: 'isolation', label, state: 'ok', detail: 'HTTPS or localhost, cross-origin isolated, threads and 4 GB memory available.' };
}

export async function checkGpu(): Promise<Check & { adapter?: string }> {
  const label = 'WebGPU';
  const gpu = (navigator as any).gpu as GPU | undefined;
  if (!gpu) return { id: 'gpu', label, state: 'fail', detail: 'WebGPU is off in this browser. Update Chrome; on Linux enable it in chrome://flags (#enable-unsafe-webgpu).' };
  let ad: GPUAdapter | null = null;
  try { ad = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* reported below */ }
  if (!ad) return { id: 'gpu', label, state: 'fail', detail: 'Chrome found no usable graphics adapter (blocklisted driver or GPU process crash). Check chrome://gpu.' };
  const info = ad.info ? [ad.info.vendor, ad.info.architecture, ad.info.description].filter(Boolean).join(' ') : '';
  // no BC (PowerVR, Mali): the renderer unpacks the textures (web/src/gpu/dxt.ts), so it plays
  if (!ad.features.has('texture-compression-bc')) {
    return { id: 'gpu', label: `WebGPU${info ? ', ' + info : ''}`, state: 'warn', adapter: info,
      detail: 'This GPU cannot read the game\'s compressed textures, so they are unpacked as the game loads. That needs about 200 MB more memory, and loading screens may pause for a moment.' };
  }
  return { id: 'gpu', label: `WebGPU${info ? ', ' + info : ''}`, state: 'ok', adapter: info, detail: 'Adapter with BC texture compression.' };
}

export async function checkStorage(): Promise<Check> {
  const label = 'Browser storage';
  try { await navigator.storage.getDirectory(); }
  catch { return { id: 'storage', label, state: 'fail', detail: 'This browser window cannot store files (a guest or private window?). Saves need the origin private file system.' }; }
  let persisted = false;
  try { persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch { /* not decisive */ }
  let free = '';
  try {
    const e = await navigator.storage.estimate();
    if (e.quota !== undefined && e.usage !== undefined) free = `, ${fmtBytes(e.quota - e.usage)} free`;
  } catch { /* fine */ }
  return { id: 'storage', label, state: persisted ? 'ok' : 'warn',
    detail: persisted ? `Saves and cached game data are kept${free}.`
      : `Chrome may clear this site's storage when the disk runs low${free}. Download a backup of your saves now and then.` };
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} bytes`;
}
