#!/usr/bin/env python3
"""Fetch OSM context features around MSD sections 01 (0-1942.3 m) and 02 (-5849.8 m).

Buildings, railways, landuse/natural areas, barriers, pipelines, lamps, power lines
and road-side structures inside a fixed bounding box. Raw response is cached;
normal rebuilds are offline. Data (c) OpenStreetMap contributors, ODbL.
Imagery is used only as visual reference and is never stored here.
"""
import argparse
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
# Section bounding boxes: route plus ~300 m visibility margin; not the whole MSD.
SECTIONS = {
    '01': ('msd-pilot-environment.osm.json', (55.5735, 37.6070, 55.5975, 37.6290)),
    '02': ('msd-section-02-environment.osm.json', (55.5870, 37.6120, 55.6290, 37.6510)),
}
ENDPOINT = 'https://overpass-api.de/api/interpreter'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--section', default='01', choices=sorted(SECTIONS))
    args = parser.parse_args()
    name, BOUNDS = SECTIONS[args.section]
    PATH = ROOT / 'data' / 'moscow' / name
    if PATH.exists() and not args.refresh:
        print(f'cached: {PATH}')
        return
    bbox = ','.join(map(str, BOUNDS))
    selectors = ['building', 'railway', 'landuse', 'natural', 'barrier', 'man_made', 'power',
                 'leisure', 'amenity', 'waterway', '"bridge:support"', 'highway~"^(street_lamp|footway|path|service|track)$"']
    body = ''.join(f'nwr[{s}]({bbox});' for s in selectors)
    query = f'[out:json][timeout:120];({body});out body geom;'
    request = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({'data': query}).encode(),
                                     headers={'User-Agent': 'TrafficCuttingUp OSM map prototype'})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
    data = json.loads(raw)
    if data.get('remark') or not data.get('elements'):
        raise RuntimeError(f'Incomplete Overpass response: {data.get("remark", "no elements")}')
    PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {len(data["elements"])} elements to {PATH}')


if __name__ == '__main__':
    main()
