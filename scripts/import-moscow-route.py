#!/usr/bin/env python3
"""Fetch OSM roads and build an auditable directed route through the supplied waypoints.

Uses Python's standard library. Raw responses are cached; normal rebuilds are offline.
This is an OSM route candidate, NOT a reproduction of Yandex's routing algorithm.
"""
import argparse
import collections
import datetime
import heapq
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'moscow'
WAYPOINTS = [(55.576894, 37.616692), (55.746178, 37.738748),
             (55.710893, 37.836291), (55.576888, 37.617271)]
BOUNDS = (55.56, 37.59, 55.765, 37.86)
ENDPOINT = 'https://overpass-api.de/api/interpreter'


def distance(a, b):
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, h)))


def fetch(refresh):
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / 'roads.osm.json'
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    query = ('[out:json][timeout:90];way["highway"~'
             '"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
             'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]'
             f'({",".join(map(str, BOUNDS))});out body geom;')
    request = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({'data': query}).encode(),
                                    headers={'User-Agent': 'TrafficCuttingUp OSM map prototype'})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
    data = json.loads(raw)
    if data.get('remark') or not data.get('elements'):
        raise RuntimeError(f'Incomplete Overpass response: {data.get("remark", "no elements")}')
    path.write_bytes(raw)
    return data


def graph(data):
    nodes, adjacency, ways = {}, collections.defaultdict(list), {}
    for way in data['elements']:
        tags = way.get('tags', {})
        if tags.get('access') in ('no', 'private') or tags.get('motor_vehicle') in ('no', 'private'):
            continue
        ways[way['id']] = way
        pairs = list(zip(way['nodes'], way['geometry']))
        for node, point in pairs:
            nodes[node] = (point['lat'], point['lon'])
        oneway = tags.get('oneway', 'yes' if tags.get('highway') == 'motorway' or tags.get('junction') == 'roundabout' else 'no')
        for (a, _), (b, _) in zip(pairs, pairs[1:]):
            length = distance(nodes[a], nodes[b])
            if length < .01:
                continue
            # Fast-road preference avoids shortcutting the motorway loop through residential streets.
            road = tags['highway'].removesuffix('_link')
            factor = {'motorway': 1, 'trunk': 1, 'primary': 1.5, 'secondary': 2,
                      'tertiary': 3}.get(road, 5)
            if oneway != '-1':
                adjacency[a].append((b, length * factor, length, way['id']))
            if oneway not in ('yes', '1', 'true'):
                adjacency[b].append((a, length * factor, length, way['id']))
    return nodes, adjacency, ways


def shortest(adjacency, start, end):
    best, previous, queue = {start: 0}, {}, [(0, start)]
    while queue:
        cost, node = heapq.heappop(queue)
        if cost != best[node]:
            continue
        if node == end:
            path = []
            while node != start:
                parent, length, way = previous[node]
                path.append((parent, node, length, way))
                node = parent
            return list(reversed(path))
        for target, weight, length, way in adjacency[node]:
            candidate = cost + weight
            if candidate < best.get(target, math.inf):
                best[target] = candidate
                previous[target] = (node, length, way)
                heapq.heappush(queue, (candidate, target))
    raise RuntimeError(f'No directed route from {start} to {end}')


def build(data):
    nodes, adjacency, ways = graph(data)
    # Snap to routable nodes, recording the error rather than hiding it.
    snapped = [min(adjacency, key=lambda n: distance(p, nodes[n])) for p in WAYPOINTS]
    # The two user endpoints are close but distinct. Close via actual road topology,
    # never a fabricated straight segment across a barrier or carriageway.
    legs = [shortest(adjacency, a, b) for a, b in zip(snapped, snapped[1:] + snapped[:1])]
    sections = []
    for leg_index, leg in enumerate(legs):
        for a, b, length, way_id in leg:
            if not sections or sections[-1]['wayId'] != way_id or sections[-1]['leg'] != leg_index:
                sections.append({'wayId': way_id, 'leg': leg_index, 'tags': ways[way_id]['tags'],
                                 'coordinates': [list(nodes[a])], 'length': 0})
            sections[-1]['coordinates'].append(list(nodes[b]))
            sections[-1]['length'] += length
    return {
        'id': 'moscow-mkad-msd', 'status': 'osm-route-candidate',
        'source': {'provider': 'OpenStreetMap', 'license': 'ODbL-1.0',
                   'attribution': '© OpenStreetMap contributors',
                   'url': 'https://www.openstreetmap.org/copyright',
                   'endpoint': ENDPOINT, 'osmTimestamp': data.get('osm3s', {}).get('timestamp_osm_base'),
                   'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()},
        'coordinateOrder': 'latitude,longitude', 'bounds': list(BOUNDS),
        'waypoints': [{'requested': list(p), 'snapped': list(nodes[n]), 'nodeId': n,
                       'errorMetres': distance(p, nodes[n])} for p, n in zip(WAYPOINTS, snapped)],
        'lengthMetres': sum(s['length'] for s in sections),
        'legLengthsMetres': [sum(e[2] for e in leg) for leg in legs],
        'sections': sections,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Explicitly refresh the OSM cache')
    args = parser.parse_args()
    route = build(fetch(args.refresh))
    target = DATA / 'route.json'
    target.write_text(json.dumps(route, ensure_ascii=False, indent=2) + '\n')
    names = collections.Counter()
    for section in route['sections']:
        names[section['tags'].get('name', section['tags']['highway'])] += section['length']
    print(json.dumps({'output': str(target.relative_to(ROOT)), 'lengthKm': route['lengthMetres'] / 1000,
                      'legsKm': [n / 1000 for n in route['legLengthsMetres']],
                      'snapErrorsMetres': [p['errorMetres'] for p in route['waypoints']],
                      'roadsKm': {name: round(n / 1000, 3) for name, n in names.most_common(30)}},
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
