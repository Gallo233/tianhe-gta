"""Voice acting for the Tianhe demo, generated with Alibaba Cloud Model Studio (DashScope) TTS -- no browser speech.

    python3 guangzhou/scripts/gz_voice.py audition [--joi CONFIG]
        One line for each role in every candidate voice (the Cantonese ones above all) -> an audition page at
        guangzhou/demo/public/voice/audition/index.html (dev server: /voice/audition/).
    python3 guangzhou/scripts/gz_voice.py build [--joi CONFIG] [--only who,who] [--force]
        Every line in demo/src/delivery/voice/lines.json, in the voice cast for its speaker there ->
        demo/public/assets/voice/<id>.mp3 + index.json (subtitle text -> clip). Incremental: a clip is made again only
        when its spoken text, model or voice changed.

The key comes from DASHSCOPE_API_KEY, or with --joi from the `realtime_voice.api_key` of that config.yaml (the
user's Joi project). The key is never written anywhere.

Models (Beijing region):
  qwen3-tts-flash          multimodal-generation endpoint; voices Cherry, Ethan, ..., Cantonese Rocky / Kiki
  cosyvoice-v3-flash/plus  audio/tts/SpeechSynthesizer; Cantonese longjiaxin_v3, longjiayi_v3, longanyue_v3
  qwen-audio-3.1-tts-flash audio/tts/SpeechSynthesizer; multi-dialect voices, Cantonese by instruction
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))           # guangzhou/
DEMO = os.path.join(ROOT, 'demo')
LINES = os.path.join(DEMO, 'src', 'delivery', 'voice', 'lines.json')
OUT = os.path.join(DEMO, 'public', 'assets', 'voice')
AUDITION = os.path.join(DEMO, 'public', 'voice', 'audition')

HOSTS = ['https://dashscope.aliyuncs.com']
QWEN3 = '/api/v1/services/aigc/multimodal-generation/generation'
SYNTH = '/api/v1/services/audio/tts/SpeechSynthesizer'
YUE = '请用广东话表达。'


def api_key(joi):
    """DASHSCOPE_API_KEY; else the Joi project's Qwen key: its config value, the env var that names, or the macOS
    keychain item Joi keeps it in (service "Joi BYOK", account "realtime_voice.qwen_api_key")."""
    k = os.environ.get('DASHSCOPE_API_KEY', '').strip()
    if k:
        return k
    if joi:
        s = open(joi, encoding='utf-8').read()
        m = re.search(r'^realtime_voice:\n((?:[ \t].*\n|\n)*)', s, re.M)
        km = re.search(r'^\s*api_key:\s*["\']?([^"\'\s]+)', m.group(1), re.M) if m else None
        v = km.group(1) if km else ''
        ref = re.fullmatch(r'\$\{(\w+)\}', v)
        if ref:
            v = os.environ.get(ref.group(1), '').strip()
        if not v:
            r = subprocess.run(['security', 'find-generic-password', '-s', 'Joi BYOK', '-a', 'realtime_voice.qwen_api_key', '-w'],
                               capture_output=True, text=True)
            v = r.stdout.strip() if r.returncode == 0 else ''
        if v:
            return v
    sys.exit('no key: set DASHSCOPE_API_KEY or pass --joi path/to/config.yaml (Joi keeps it in the keychain)')


def post(key, path, body):
    last = None
    for host in HOSTS:
        req = urllib.request.Request(host + path, data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                last = f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:300]}'
                if e.code in (429, 500, 502, 503):
                    time.sleep(2 + attempt * 3)
                    continue
                break
            except Exception as e:  # noqa: BLE001 -- dropped connections, timeouts: try again
                last = str(e)
                time.sleep(2 + attempt * 2)
    raise RuntimeError(last)


def synth(key, model, voice, text, instruction=None):
    """-> wav bytes"""
    if model.startswith('qwen3-tts'):
        lang = 'English' if sum(c.isascii() for c in text) > 0.8 * len(text) else 'Chinese'
        body = {'model': model, 'input': {'text': text, 'voice': voice, 'language_type': lang}}
        if instruction and 'instruct' in model:
            body['input']['instructions'] = instruction
        r = post(key, QWEN3, body)
    else:
        inp = {'text': text, 'voice': voice, 'format': 'wav', 'sample_rate': 24000}
        if instruction:
            inp['instruction'] = instruction
        r = post(key, SYNTH, {'model': model, 'input': inp})
    url = ((r.get('output') or {}).get('audio') or {}).get('url')
    if not url:
        raise RuntimeError('no audio in response: ' + json.dumps(r, ensure_ascii=False)[:300])
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as a:
                return a.read()
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(2)


def to_mp3(wav, dst, pitch=1.0):
    """mono 44.1 kHz mp3; pitch != 1 shifts the voice (older / younger) without changing its speed"""
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        f.write(wav)
        src = f.name
    af = ['silenceremove=start_periods=1:start_threshold=-50dB', 'areverse', 'silenceremove=start_periods=1:start_threshold=-50dB', 'areverse']
    if abs(pitch - 1) > 1e-3:
        af = [f'asetrate=24000*{pitch:.4f}', 'aresample=24000', f'atempo={1 / pitch:.4f}'] + af
    af.append('loudnorm=I=-17:TP=-1.5:LRA=9')
    try:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', ','.join(af), '-ac', '1', '-ar', '44100',
                        '-b:a', '56k', dst], check=True)
    finally:
        os.unlink(src)


# ------------------------------------------------------------------------------------------ audition
AUDITION_SET = [
    ('麦姐（粤语女）', '阿杰！好咗喇！趁热拎去啊。汤我同你多套咗个袋，点颠都唔会洒嘅。', [
        ('qwen3-tts-flash', 'Kiki', None),
        ('cosyvoice-v3-flash', 'longjiaxin_v3', None),
        ('cosyvoice-v3-flash', 'longjiayi_v3', None),
        ('qwen-audio-3.1-tts-flash', 'longanfengyue_v3.1', YUE),
        ('qwen-audio-3.1-tts-flash', 'longanhuan_v3.1', YUE),
        ('qwen-audio-3.1-tts-flash', 'longanlingxin_v3.1', YUE),
    ]),
    ('发哥（粤语男）', '靓仔，帮个忙啦。同客人讲声係现炸嘅，下次多俾只卤蛋你。', [
        ('qwen3-tts-flash', 'Rocky', None),
        ('cosyvoice-v3-flash', 'longanyue_v3', None),
        ('qwen-audio-3.1-tts-flash', 'xunanchuan_v3.1', YUE),
    ]),
    ('李伯（粤语老伯，同一个男声压低音调）', '后生仔，员工电梯喺后面，快啲上去。我当冇见过你，你都冇见过我。', [
        ('qwen3-tts-flash', 'Rocky', None),
        ('cosyvoice-v3-flash', 'longanyue_v3', None),
        ('qwen-audio-3.1-tts-flash', 'xunanchuan_v3.1', YUE),
    ]),
    ('小准（平台 AI，普通话）', '温馨提示：商家已于二十八分钟前出餐，超时责任将由骑手承担。祝您工作愉快。', [
        ('qwen3-tts-flash', 'Cherry', None),
        ('qwen3-tts-flash', 'Katerina', None),
        ('qwen3-tts-flash', 'Serena', None),
        ('qwen-audio-3.1-tts-flash', 'longanhuan_v3.1', None),
    ]),
    ('王总（产品经理，普通话）', '这个问题你需要自己拉通一下。我这边在对齐一个很重要的颗粒度。', [
        ('qwen3-tts-flash', 'Elias', None),
        ('qwen3-tts-flash', 'Ethan', None),
        ('qwen-audio-3.1-tts-flash', 'xunanchuan_v3.1', None),
    ]),
]


def audition(key):
    os.makedirs(AUDITION, exist_ok=True)
    rows = []
    for role, text, cands in AUDITION_SET:
        items = []
        for model, voice, ins in cands:
            name = re.sub(r'[^a-z0-9]+', '_', f'{model}_{voice}'.lower()) + ('_' + hashlib.md5(role.encode()).hexdigest()[:6])
            dst = os.path.join(AUDITION, name + '.mp3')
            err = None
            pitch = 0.9 if role.startswith('李伯') else 1.0
            try:
                if os.path.exists(dst):
                    items.append((model, voice, ins, name + '.mp3', None))
                    continue
                to_mp3(synth(key, model, voice, text, ins), dst, pitch)
                print('ok  ', role, model, voice)
            except Exception as e:  # noqa: BLE001 -- list the failure on the page and carry on
                err = str(e)
                print('FAIL', role, model, voice, err[:200])
            items.append((model, voice, ins, name + '.mp3', err))
        rows.append((role, text, items))
    html = ['<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>配音试听</title><style>body{font:15px/1.5 -apple-system,"PingFang SC",sans-serif;max-width:820px;margin:24px auto;padding:0 16px;background:#111;color:#eee}',
            'h2{margin:28px 0 4px;font-size:18px}p.t{color:#c6f03c;margin:0 0 10px}div.r{display:flex;align-items:center;gap:12px;margin:6px 0;padding:8px 10px;background:#1c1f22;border-radius:8px}',
            'b{min-width:270px;font-weight:600}audio{flex:1}i{color:#ff8a6a;font-style:normal;font-size:13px}</style>',
            '<h1>天河 demo · 配音试听</h1><p>每个角色挑一个最好听的（记下左边的模型 / 音色名告诉我）。</p>']
    for role, text, items in rows:
        html.append(f'<h2>{role}</h2><p class="t">{text}</p>')
        for model, voice, ins, f, err in items:
            label = f'{model} · {voice}' + (' · 指令粤语' if ins else '')
            html.append(f'<div class="r"><b>{label}</b>' + (f'<i>失败：{err[:120]}</i>' if err else f'<audio controls preload="none" src="{f}"></audio>') + '</div>')
    open(os.path.join(AUDITION, 'index.html'), 'w', encoding='utf-8').write('\n'.join(html))
    print('audition page:', os.path.join(AUDITION, 'index.html'), '-> open http://127.0.0.1:5288/voice/audition/index.html')


# ------------------------------------------------------------------------------------------ build
def clip_id(cast, say):
    h = hashlib.sha1(json.dumps([cast.get('model'), cast.get('voice'), cast.get('instruction'), cast.get('pitch', 1.0), say],
                                ensure_ascii=False).encode('utf-8')).hexdigest()
    return h[:12]


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True)
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return 0.0


def jobs_of(data):
    """-> [(who, text, variant, cast, say)] for every clip the lines ask for"""
    cast_all = data['cast']
    out = []
    for ln in data['lines']:
        who, text = ln['who'], ln['text']
        ck = ln.get('cast', who)
        c = cast_all.get(ck)
        if c is None:
            raise SystemExit(f'no cast for {ck!r} ({text})')
        say = ln.get('say') or text
        if 'variants' in c:
            for v, cv in c['variants'].items():
                out.append((who, text, v, cv, say))
        else:
            out.append((who, text, '', c, say))
    return out


def build(key, only, force, workers=6):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    data = json.load(open(LINES, encoding='utf-8'))
    os.makedirs(OUT, exist_ok=True)
    todo, index = [], {}
    for who, text, var, cast, say in jobs_of(data):
        cid = clip_id(cast, say)
        index.setdefault(who, {}).setdefault(text, {})[var] = cid
        dst = os.path.join(OUT, cid + '.mp3')
        if (os.path.exists(dst) and not force) or (only and who not in only):
            continue
        if not any(t[0] == cid for t in todo):
            todo.append((cid, cast, say, f'{who}{":" + var if var else ""}'))
    print(f'{len(todo)} clips to make ({sum(len(v) for m in index.values() for v in m.values())} in all)')
    failed = []

    def make(job):
        cid, cast, say, label = job
        to_mp3(synth(key, cast['model'], cast['voice'], say, cast.get('instruction')), os.path.join(OUT, cid + '.mp3'), cast.get('pitch', 1.0))
        return label, say

    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(make, j): j for j in todo}
        for n, f in enumerate(as_completed(futs), 1):
            j = futs[f]
            try:
                label, say = f.result()
                print(f'[{n}/{len(todo)}] {label}: {say}')
            except Exception as e:  # noqa: BLE001
                failed.append((j[3], j[2], str(e)[:200]))
                print(f'[{n}/{len(todo)}] FAIL {j[3]}: {j[2]} -- {str(e)[:160]}')
    # index: who -> subtitle -> variant -> [clip, seconds]; clips that are not there (failed) are left out
    final, live = {}, set()
    for who, m in index.items():
        for text, vs in m.items():
            for var, cid in vs.items():
                path = os.path.join(OUT, cid + '.mp3')
                if os.path.exists(path):
                    final.setdefault(who, {}).setdefault(text, {})[var] = [cid, duration(path)]
                    live.add(cid)
    if not only:
        for f in os.listdir(OUT):
            if f.endswith('.mp3') and f[:-4] not in live:
                os.unlink(os.path.join(OUT, f))
    json.dump(final, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'done: {len(live)} clips, {total / 1e6:.1f} MB, failed {len(failed)}')
    for f in failed:
        print('  failed:', f)


def check():
    """Every Chinese line in the delivery scripts that has no entry in lines.json (and is not narration)."""
    data = json.load(open(LINES, encoding='utf-8'))
    known = {ln['text'] for ln in data['lines']}
    pats = [re.compile('^' + re.escape(t).replace(r'\{\}', '.+?') + '$') for t in known if '{}' in t]
    missing = []
    for f in ['src/delivery/Story.ts', 'src/delivery/Orders.ts']:
        src = open(os.path.join(DEMO, f), encoding='utf-8').read()
        for m in re.finditer(r"'([^'\n]*[\u4e00-\u9fff][^'\n]*)'|`([^`\n]*[\u4e00-\u9fff][^`\n]*)`", src):
            t = m.group(1) or re.sub(r'\$\{[^}]*\}', '{}', m.group(2))
            if t in known or any(p.match(t) for p in pats) or t.startswith('（') or t.startswith('第一章'):
                continue
            missing.append((f, src[:m.start()].count('\n') + 1, t))
    for f, ln, t in missing:
        print(f'{f}:{ln}  {t}')
    print(len(missing), 'strings without a voice line (many are UI text, notes and reviews: that is fine)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['audition', 'build', 'check'])
    ap.add_argument('--joi', default=None, help='a config.yaml with realtime_voice.api_key (the Joi project)')
    ap.add_argument('--only', default='', help='comma-separated speakers to (re)make')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.mode == 'check':
        check()
        return
    key = api_key(a.joi)
    if a.mode == 'audition':
        audition(key)
    else:
        build(key, set(filter(None, a.only.split(','))), a.force)


if __name__ == '__main__':
    main()
