// The music folder: a directory the player picks with the browser's directory picker (Chrome, Edge) or with a file input that takes
// a folder (Firefox, Safari), and the audio files in it, by name only (a file is opened when it is played).
const AUDIO = /\.(mp3|ogg|oga|opus|wav|flac|m4a)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export type Folder = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
};
type Files = FileSystemFileHandle[];
/** handle: the folder itself, when the browser gives one to keep. */
export type Picked = { files: Files; name: string; handle?: Folder };

/** The files in the order of the playlist: by name. */
export const sortedTracks = (files: readonly FileSystemFileHandle[]): Files => [...files].sort((a, b) => collator.compare(a.name, b.name));

/** The audio files of the folder itself. */
async function filesIn(root: FileSystemDirectoryHandle): Promise<Files> {
  const out: Files = [];
  for await (const e of (root as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) if (e.kind === 'file' && AUDIO.test(e.name)) out.push(e as FileSystemFileHandle);
  return out;
}

/** A folder can be picked here: by the directory picker, or by an input with webkitdirectory, which Safari on an iPhone or iPad lists no folders for. */
export const canPickMusic = () => 'showDirectoryPicker' in globalThis || !(/iPhone|iPad|iPod/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** The folder the player picks, or null when the player cancels or the browser cannot pick a folder.  Any other failure is thrown. */
export async function pickMusic(): Promise<Picked | null> {
  const pick = (globalThis as { showDirectoryPicker?: (o: { mode: 'read' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!pick) return pickFromInput();
  try {
    const dir = await pick.call(globalThis, { mode: 'read' });
    return { files: await filesIn(dir), name: dir.name, handle: dir as Folder };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** For a browser without a directory picker: a file input that takes a folder (webkitRelativePath "Folder/a.mp3").
 *  It cannot be asked again after a reload, so the folder is not kept. */
function pickFromInput(): Promise<Picked | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', webkitdirectory: true, multiple: true });
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const list = Array.from(input.files ?? []), picked: Picked = { files: [], name: '' };
      for (const f of list) {
        const parts = (f.webkitRelativePath || f.name).split('/');
        picked.name ||= parts.length > 1 ? parts[0] : '';
        if (parts.length <= 2 && AUDIO.test(f.name)) picked.files.push({ kind: 'file', name: f.name, getFile: async () => f } as unknown as FileSystemFileHandle);
      }
      resolve(list.length ? picked : null);
    });
    input.click();
  });
}

/** One request to the folder store (IndexedDB "nfsu2.radio"); any failure, or a store that is not there: undefined.  The connection is closed after it. */
function inStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    let db: IDBDatabase | undefined;
    const done = (v?: T) => { try { db?.close(); } catch { /* already closed */ } resolve(v); };
    try {
      const open = indexedDB.open('nfsu2.radio', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('folder');
      open.onerror = open.onblocked = () => done();
      open.onsuccess = () => {
        try {
          db = open.result;
          const tx = db.transaction('folder', mode), r = run(tx.objectStore('folder'));
          tx.oncomplete = () => done(r.result);
          tx.onerror = tx.onabort = () => done();
        } catch { done(); }
      };
    } catch { done(); }
  });
}

/** The folder handle kept from the last visit: the only way to open the folder again after a reload. */
export const keptFolder = () => inStore<Folder>('readonly', s => s.get('folder'));
export const keepFolder = (handle: Folder) => inStore('readwrite', s => s.put(handle, 'folder'));

/** The folder's files when the browser allows it (ask: it may show its question, which needs a click), else null. */
export async function reopenFolder(handle: Folder, ask: boolean): Promise<Files | null> {
  const state = await handle[ask ? 'requestPermission' : 'queryPermission']({ mode: 'read' });
  return state === 'granted' ? filesIn(handle) : null;
}
