/**
 * Songs the player adds in the game (the radio panel's 「添加音乐」, or audio files dropped on the window). They live in
 * this browser's IndexedDB, so they are back on every visit with no server and no rebuild: the release zip carries no
 * songs of its own (commercial recordings are not ours to hand out) -- each player brings theirs.
 *
 * Adding decodes the file once (at 22.05 kHz, enough for these measurements) to
 *   check it plays    whatever this browser decodes (mp3, m4a / aac, wav, flac, ogg); anything else is refused
 *   level it          ITU-R BS.1770 integrated loudness (K-weighting, 400 ms blocks, -70 LUFS and -10 LU gates); the
 *                     gain that brings it to -16 LUFS like gz_music.py does for the bundled songs, held so the sample
 *                     peak stays under -1.5 dBFS
 *   find the start    leading silence (below -50 dB, at most 15 s) is skipped on playback
 * Title / artist / cover come from an ID3v2 tag when the file has one, else from the file name ("歌手 - 歌名").
 * The file itself is stored as it came (no re-encoding in the browser).
 */
export interface UserSong {
  id: string; title: string; artist: string; dur: number; gain: number; skip: number; added: number;
  name: string; blob: Blob; cover: Blob | null;
}

const DB = 'gz-music', STORE = 'songs';
const TARGET_LUFS = -16, PEAK_MAX = Math.pow(10, -1.5 / 20), SILENCE = Math.pow(10, -50 / 20);
const EXT = /\.(mp3|m4a|aac|mp4|flac|wav|ogg|oga|opus|webm|aif|aiff)$/i;

export function isAudio(f: File): boolean { return f.type.startsWith('audio/') || EXT.test(f.name); }

// ------------------------------------------------------------------------------------------ IndexedDB
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error ?? new Error('IndexedDB 打不开')); };
  });
  return dbp;
}
function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(STORE, mode), q = f(t.objectStore(STORE));
    t.oncomplete = () => res(q.result);
    t.onerror = t.onabort = () => rej(t.error ?? q.error ?? new Error('IndexedDB 出错'));
  }));
}
export async function listSongs(): Promise<UserSong[]> {
  try { return ((await tx('readonly', (s) => s.getAll())) as UserSong[]).sort((a, b) => a.added - b.added); } catch { return []; }
}
export function putSong(s: UserSong): Promise<IDBValidKey> { return tx('readwrite', (st) => st.put(s)); }
export function deleteSong(id: string): Promise<undefined> { return tx('readwrite', (st) => st.delete(id)); }

// ------------------------------------------------------------------------------------------ ID3v2
const dec = (label: string, b: Uint8Array, fatal = false) => new TextDecoder(label, { fatal }).decode(b);
function text(enc: number, b: Uint8Array): string {
  let s: string;
  if (enc === 1) s = dec('utf-16', b);                       // BOM picks the byte order
  else if (enc === 2) s = dec('utf-16be', b);
  else if (enc === 3) s = dec('utf-8', b);
  else {
    // "ISO-8859-1": in practice also UTF-8 written by careless taggers, and GBK in Chinese rips
    s = b.every((x) => x < 0x80) ? dec('latin1', b) : (() => { try { return dec('utf-8', b, true); } catch { return dec('gbk', b); } })();
  }
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}
/** index just past a string terminator in the given encoding (two zero bytes on a 2-byte boundary for UTF-16) */
function skipString(b: Uint8Array, at: number, enc: number): number {
  if (enc === 1 || enc === 2) { for (let i = at; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2; return b.length; }
  const i = b.indexOf(0, at);
  return i < 0 ? b.length : i + 1;
}
const synchsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

/** title / artist / front cover from an ID3v2.2-2.4 tag at the start of the file (null: no tag) */
export function parseId3(b: Uint8Array): { title: string; artist: string; cover: Blob | null } | null {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3], flags = b[5], end = Math.min(b.length, 10 + synchsafe(b, 6));
  let p = 10;
  if (flags & 0x40) p += ver === 4 ? synchsafe(b, 10) : 4 + ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]);
  const out = { title: '', artist: '', cover: null as Blob | null };
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (p + hdr <= end) {
    const id = String.fromCharCode(...b.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;                      // padding
    const size = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
      : ver === 4 ? synchsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    const f = b.subarray(p + hdr, Math.min(end, p + hdr + size));
    p += hdr + size;
    if (!f.length) continue;
    if (id === 'TIT2' || id === 'TT2') out.title ||= text(f[0], f.subarray(1));
    else if (id === 'TPE1' || id === 'TP1') out.artist ||= text(f[0], f.subarray(1));
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) {
      const enc = f[0];
      let q: number, mime: string;
      if (id === 'PIC') { mime = /png/i.test(String.fromCharCode(...f.subarray(1, 4))) ? 'image/png' : 'image/jpeg'; q = 4; }
      else { const e = f.indexOf(0, 1); mime = dec('latin1', f.subarray(1, e)) || 'image/jpeg'; q = e + 1; }
      q = skipString(f, q + 1, enc);                          // picture type, then the description
      if (q < f.length) out.cover = new Blob([f.slice(q)], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` });
    }
  }
  return out;
}

/** "歌手 - 歌名.mp3" -> both; anything else -> the name as the title */
function fromName(name: string): { title: string; artist: string } {
  const stem = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = stem.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: stem };
}

// ------------------------------------------------------------------------------------------ loudness
const SR = 22050;
/** integrated loudness (LUFS), peak, where the sound starts, duration */
async function measure(file: Blob): Promise<{ lufs: number; peak: number; skip: number; dur: number }> {
  const raw = await file.arrayBuffer();
  let audio: AudioBuffer;
  try { audio = await new OfflineAudioContext(1, 1, SR).decodeAudioData(raw); } catch { throw new Error('无法解码（这个浏览器不支持这种格式，或文件已损坏）'); }
  if (audio.duration < 1) throw new Error('太短了，不像一首歌');
  const ch = Math.min(2, audio.numberOfChannels), n = audio.length;
  // K-weighting: BS.1770's +4 dB high shelf (f0 1682 Hz, Q 0.707 = the shelf's S 1) and its 38 Hz high-pass (Q 0.5)
  // as Web Audio biquads. A high-pass's Q is in dB there: linear 0.5 is -6.02 (0.5 as written reads bass ~1.5 dB hot)
  const oc = new OfflineAudioContext(ch, n, SR);
  const src = oc.createBufferSource(); src.buffer = audio;
  const shelf = oc.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681.97; shelf.gain.value = 4;
  const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38.135; hp.Q.value = 20 * Math.log10(0.5003);
  src.connect(shelf).connect(hp).connect(oc.destination);
  src.start();
  const k = await oc.startRendering();
  // mean square per 100 ms step, summed over the channels; a block is four steps (400 ms, 75 % overlap)
  const step = Math.round(SR * 0.1), steps = Math.floor(n / step), ms = new Float64Array(steps);
  let peak = 0, first = n;
  for (let c = 0; c < ch; c++) {
    const x = k.getChannelData(c), y = audio.getChannelData(c);
    for (let s = 0; s < steps; s++) {
      let acc = 0;
      for (let i = s * step, e = i + step; i < e; i++) acc += x[i] * x[i];
      ms[s] += acc / step;
    }
    let f = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(y[i]);
      if (a > peak) peak = a;
      if (f < 0 && a > SILENCE) f = i;
    }
    if (f >= 0 && f < first) first = f;
  }
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= steps; s++) blocks.push((ms[s] + ms[s + 1] + ms[s + 2] + ms[s + 3]) / 4);
  const L = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) throw new Error('听起来是一段静音');
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  const lufs = L(gated.reduce((a, b) => a + b, 0) / gated.length);
  return { lufs, peak, skip: first < n ? Math.min(15, Math.max(0, first / SR - 0.05)) : 0, dur: audio.duration };
}

/** a cover at most 320 px, as a jpg (the embedded ones can be several MB of PNG) */
async function shrink(img: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(img);
    const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  } catch { return null; }
}

/** everything the radio needs to know about a file, ready to store; throws with a reason a player can read */
export async function analyse(file: File): Promise<UserSong> {
  if (!isAudio(file)) throw new Error('不是音频文件');
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const tagLen = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 ? 10 + synchsafe(head, 6) : 0;
  const tag = tagLen ? parseId3(new Uint8Array(await file.slice(0, tagLen).arrayBuffer())) : null;
  const named = fromName(file.name);
  const m = await measure(file);
  const gain = Math.max(0.1, Math.min(Math.pow(10, (TARGET_LUFS - m.lufs) / 20), m.peak > 0 ? PEAK_MAX / m.peak : 4, 4));
  return {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: tag?.title || named.title || '未命名', artist: tag?.artist || named.artist,
    dur: Math.round(m.dur * 100) / 100, gain: Math.round(gain * 1000) / 1000, skip: Math.round(m.skip * 100) / 100,
    added: Date.now(), name: file.name, blob: file, cover: tag?.cover ? await shrink(tag.cover) : null,
  };
}
