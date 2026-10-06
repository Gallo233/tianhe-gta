"""The in-vehicle music (demo/src/systems/Radio.ts): the user's own audio files -> web tracks.

    python3 guangzhou/scripts/gz_music.py            # process guangzhou/music_in/ -> demo/public/assets/music/
    python3 guangzhou/scripts/gz_music.py --list     # just show which file matched which song
    python3 guangzhou/scripts/gz_music.py --in ~/Music/somewhere   # read the songs from another folder

The songs are commercial recordings: nothing here downloads them. Drop the files you own into guangzhou/music_in/
under any name and format ffmpeg reads (mp3, m4a/aac, flac, wav, ogg...; Apple Music .m4p is DRM-locked and cannot
be converted). A file is matched to a song by its file name or its title tag. Each one is

    loudness   two-pass EBU R128 to -16 LUFS, true peak -1.5 dB, so no song jumps out louder than the next
    trimmed    leading silence cut (> -50 dB)
    encoded    mp3 192 kbit/s, 44.1 kHz stereo (every browser, and the release kit's little servers, play it)
    cover      the embedded artwork, if any, as a 320 px jpg (the player draws a cover of its own otherwise)

and listed in tracks.json (id, title, artist, language, seconds, cover). The artist comes from the file's tag,
falling back to the table below. assets/music/ is left out of the release zip unless INCLUDE_MUSIC=1 (see
release_kit/make_release.sh): these recordings are not ours to hand out.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

GZ = Path(__file__).resolve().parents[1]
IN = GZ / 'music_in'
OUT = GZ / 'demo' / 'public' / 'assets' / 'music'
AUDIO = {'.mp3', '.m4a', '.aac', '.mp4', '.flac', '.wav', '.ogg', '.oga', '.opus', '.wma', '.aif', '.aiff', '.alac', '.m4p'}

# the first-round playlist: id, title, language, fallback artist, words that identify it in a file name or title tag
SONGS = [
    ('heijie', '黑街', '粤语', '', ['黑街', 'hak gaai', 'hakgaai', 'heijie', 'hei jie']),
    ('riluo_dadao', '日落大道', '普通话', '梁博', ['日落大道', 'riluo', 'ri luo', 'sunset boulevard']),
    ('midnight_city', 'Midnight City', '英语', 'M83', ['midnight city', 'midnightcity', 'midnight_city']),
    ('blinding_lights', 'Blinding Lights', '英语', 'The Weeknd', ['blinding lights', 'blindinglights', 'blinding_lights']),
]


def norm(s):
    return re.sub(r'[\s_\-.]+', ' ', s.lower()).strip()


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist',
                        '-show_streams', '-of', 'json', str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    j = json.loads(r.stdout)
    tags = {k.lower(): v for k, v in (j.get('format', {}).get('tags') or {}).items()}
    streams = j.get('streams', [])
    return {
        'title': tags.get('title', ''), 'artist': tags.get('artist', ''),
        'dur': float(j.get('format', {}).get('duration') or 0),
        'audio': any(s.get('codec_type') == 'audio' for s in streams),
        'art': any(s.get('codec_type') == 'video' and (s.get('disposition') or {}).get('attached_pic') for s in streams),
    }


def match(path, info):
    hay = norm(path.stem) + ' | ' + norm(info.get('title', '') if info else '')
    for sid, *_rest, keys in SONGS:
        if any(norm(k) in hay for k in keys):
            return sid
    return None


def loudnorm(src, dst):
    """two-pass loudnorm (the first pass measures, the second applies a linear gain where it can)"""
    pre = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05'
    target = 'I=-16:TP=-1.5:LRA=11'
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(src), '-vn', '-af', f'{pre},loudnorm={target}:print_format=json',
                        '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr)
    af = f'{pre},loudnorm={target}'
    s = json.loads(m.group(0)) if m else None
    # a clipped or broken file can measure outside what the second pass accepts: one dynamic pass then
    if s and -99 <= float(s['input_i']) <= 0 and -99 <= float(s['input_tp']) <= 99 and -99 <= float(s['input_thresh']) <= 0:
        af += (f":measured_I={s['input_i']}:measured_TP={s['input_tp']}:measured_LRA={s['input_lra']}"
               f":measured_thresh={s['input_thresh']}:offset={s['target_offset']}:linear=true")
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src), '-vn', '-af', af,
                        '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', '-map_metadata', '-1', str(dst)],
                       capture_output=True, text=True)
    return r.returncode == 0, r.stderr.strip()[-300:]


def cover(src, dst):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src), '-an', '-map', '0:v:0',
                        '-vf', 'scale=320:320:force_original_aspect_ratio=increase,crop=320:320', '-frames:v', '1', '-q:v', '3', str(dst)],
                       capture_output=True, text=True)
    return r.returncode == 0 and dst.exists()


def main():
    only_list = '--list' in sys.argv
    src_dir = Path(sys.argv[sys.argv.index('--in') + 1]).expanduser() if '--in' in sys.argv else IN
    src_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in src_dir.iterdir() if p.is_file() and p.suffix.lower() in AUDIO)
    if not files:
        print(f'no audio files in {src_dir} -- drop the songs there (any name: 黑街.mp3, Blinding Lights.m4a ...)')
    found = {}
    for f in files:
        info = probe(f)
        sid = match(f, info)
        if f.suffix.lower() == '.m4p' or (info and not info['audio']) or info is None:
            print(f'  ✗ {f.name}: cannot be decoded (DRM-protected or not audio)')
            continue
        if not sid:
            print(f'  ? {f.name}: not one of the playlist songs (title tag: {info["title"] or "-"})')
            continue
        if sid in found:
            print(f'  = {f.name}: a second file for {sid}, keeping {found[sid][0].name}')
            continue
        found[sid] = (f, info)
        print(f'  ✓ {f.name} -> {sid} ({info["artist"] or "no artist tag"}, {info["dur"]:.0f} s)')
    if only_list:
        return
    OUT.mkdir(parents=True, exist_ok=True)
    tracks = []
    for sid, title, lang, artist0, _keys in SONGS:
        if sid not in found:
            print(f'  · {title}: missing')
            continue
        src, info = found[sid]
        dst = OUT / f'{sid}.mp3'
        ok, err = loudnorm(src, dst)
        if not ok:
            print(f'  ✗ {title}: ffmpeg failed: {err}')
            continue
        art = OUT / f'{sid}.jpg'
        has_art = info['art'] and cover(src, art)
        if not has_art and art.exists():
            art.unlink()
        out = probe(dst)
        tracks.append({'id': sid, 'title': title, 'artist': info['artist'] or artist0, 'lang': lang,
                       'file': f'{sid}.mp3', 'dur': round(out['dur'] if out else info['dur'], 2),
                       'cover': f'{sid}.jpg' if has_art else ''})
        print(f'  ♪ {title} — {tracks[-1]["artist"] or "?"}: {dst.stat().st_size / 1e6:.1f} MB{" + cover" if has_art else ""}')
    # tracks that are gone from the playlist leave no stale files behind
    keep = {t['file'] for t in tracks} | {t['cover'] for t in tracks if t['cover']}
    for p in OUT.iterdir():
        if p.suffix in ('.mp3', '.jpg') and p.name not in keep:
            p.unlink()
    (OUT / 'tracks.json').write_text(json.dumps(tracks, ensure_ascii=False, indent=1))
    print(f'{len(tracks)} / {len(SONGS)} songs -> {OUT / "tracks.json"}')


main()
