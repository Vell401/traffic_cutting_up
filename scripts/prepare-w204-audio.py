"""Prepare original M156 PCM, without trimming, resampling or re-encoding.

Run from any directory: python3 scripts/prepare-w204-audio.py
The duplicate off/on lists reference one physical clip and one runtime voice.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import wave

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'mods_to_convert/MercedesW204'
OUT = ROOT / 'public/audio/w204'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare():
    clips, banks, provenance = [], [], []
    by_hash = {}
    config_path = 'vehicles/c63w204kene/c63w204kene_engine_v8_4.4_petrol.jbeam'
    config_data = (SOURCE / config_path).read_bytes()
    # JBeam permits trailing commas; only parse the two narrow sound objects.
    config_text = config_data.decode('utf-8-sig')
    provenance.append(dict(source=config_path, sha256=digest(config_data)))
    payloads = {}
    for channel, key in [('engine', 'soundConfig'), ('exhaust', 'soundConfigExhaust')]:
        match = re.search(r'"' + key + r'"\s*:\s*(\{[^}]*\})', config_text)
        config = json.loads(re.sub(r',\s*}', '}', match[1]))
        blend_path = f'art/sound/blends/V8_AMG_M156_{channel}.sfxBlend2D.json'
        blend_data = (SOURCE / blend_path).read_bytes()
        provenance.append(dict(source=blend_path, sha256=digest(blend_data)))
        samples = json.loads(blend_data)['samples']
        lists = []
        for entries in samples:
            ids = []
            assert all(a[1] < b[1] for a, b in zip(entries, entries[1:]))
            for source, rpm in entries:
                data = (SOURCE / source).read_bytes()
                sha = digest(data)
                if sha not in by_hash:
                    file = Path(source).name
                    assert file not in payloads, f'Output name collision: {file}'
                    with wave.open(io.BytesIO(data)) as wav:
                        clip = dict(file=file, source=source, sha256=sha, bytes=len(data),
                                    rpm=rpm, channel=channel, rate=wav.getframerate(),
                                    channels=wav.getnchannels(), sampleWidth=wav.getsampwidth(),
                                    frames=wav.getnframes(), seconds=wav.getnframes()/wav.getframerate())
                    by_hash[sha] = len(clips)
                    clips.append(clip)
                    payloads[file] = data
                index = by_hash[sha]
                assert clips[index]['rpm'] == rpm
                ids.append(index)
            lists.append(ids)
        assert len(lists) == 2
        banks.append(dict(channel=channel, off=lists[0], on=lists[1], config=config))
    assert len(clips) == 32, 'Expected the complete original 32-clip bank'
    OUT.mkdir(parents=True, exist_ok=True)
    for file, data in payloads.items():
        (OUT / file).write_bytes(data)
    manifest = dict(source='mods_to_convert/MercedesW204', format='original PCM WAV',
                    provenance=provenance, clips=clips, banks=banks,
                    serviceEffects='External BeamNG event banks are not supplied; retain game service effects.')
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'{len(clips)} unique clips; {sum(c["bytes"] for c in clips)} bytes; PCM unchanged')


if __name__ == '__main__':
    prepare()
