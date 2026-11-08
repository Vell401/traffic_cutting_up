"""Extract only the GT3's engine/exhaust RPM banks. Original PCM is copied without re-encoding."""
import zipfile, json, re, pathlib, hashlib, wave, io

root=pathlib.Path(__file__).resolve().parents[1]
out=root/'public/audio/porsche';out.mkdir(parents=True,exist_ok=True)
clips=[]
with zipfile.ZipFile(r'C:\web\Porsche 911.zip') as archive:
 for channel,blend in [('engine','porsche_4.0_gt3_engine'),('exhaust','porsche_4.0_F6_exhaust')]:
  text=archive.read(f'art/sound/blends/{blend}.sfxBlend2D.json').decode()
  banks=json.loads(re.sub(r',\s*([}\]])',r'\1',text))['samples']
  for load,bank in zip(['off','on'],banks):
   bank=[entry for entry in bank if 'limiter' not in entry[0]]
   chosen=sorted({min(range(len(bank)),key=lambda i:abs(bank[i][1]-rpm)) for rpm in [900,1800,2800,4000,5200,6400,7600,8500]})
   for index in chosen:
    source,rpm=bank[index];data=archive.read(source);name=pathlib.PurePosixPath(source).name
    (out/name).write_bytes(data)
    with wave.open(io.BytesIO(data)) as wav:
     seconds=wav.getnframes()/wav.getframerate();rate=wav.getframerate();channels=wav.getnchannels()
    clips.append(dict(file=name,channel=channel,load=load,rpm=rpm,seconds=seconds,rate=rate,channels=channels,bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),source=source))
manifest=dict(source='Porsche 911.zip / original GT3 4.0 sound blends',clips=clips)
(out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(len(clips),'clips;',sum(c['bytes'] for c in clips),'bytes; PCM unchanged')
