"""Refresh the local Activity Almanac from the signed-in gh CLI and Agent HUD."""
import argparse
import json
import os
import subprocess
import tempfile
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from select import select
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
HUD = '/Applications/Agent HUD.app/Contents/MacOS/Agent HUD'
QUERY = '''query($from:DateTime!, $to:DateTime!){
  viewer { contributionsCollection(from:$from,to:$to){
    contributionCalendar { weeks { contributionDays { date contributionCount } } }
  } }
}'''


def github(start, end):
    result = subprocess.run(
        ['gh', 'api', 'graphql', '-f', 'query=' + QUERY, '-f', 'from=' + start.isoformat(),
         '-f', 'to=' + end.isoformat()], check=True, capture_output=True, text=True, timeout=30)
    weeks = json.loads(result.stdout)['data']['viewer']['contributionsCollection']['contributionCalendar']['weeks']
    return {day['date']: day['contributionCount'] for week in weeks for day in week['contributionDays']}


def hud_days(executable, provider, start, end, zone):
    # The supported stdio tool supplies deduplicated usage and its coverage boundary.
    with subprocess.Popen([executable, '--mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True) as process:
        def request(method, params, number=None):
            msg = dict(jsonrpc='2.0', method=method, params=params)
            if number is not None:
                msg['id'] = number
            process.stdin.write(json.dumps(msg) + '\n')
            process.stdin.flush()
            if number is None:
                return
            while select([process.stdout], [], [], 30)[0]:
                line = process.stdout.readline()
                if not line:
                    raise ValueError('Agent HUD connection closed')
                reply = json.loads(line)
                if reply.get('id') == number:
                    if 'error' in reply:
                        raise ValueError('Agent HUD request failed')
                    return reply['result']
            raise TimeoutError('Agent HUD timed out')

        try:
            request('initialize', dict(protocolVersion='2025-03-26', capabilities={},
                    clientInfo=dict(name='SceneCV', version='1')), 1)
            request('notifications/initialized', {})
            arguments = {'from': start.isoformat(), 'to': end.isoformat(), 'providers': [provider],
                         'timeZone': zone.key, 'bucketMinutes': 1440, 'tokenKinds': ['input', 'output']}
            result = request('tools/call', {'name': 'hud_statistics', 'arguments': arguments}, 2)
            if result.get('isError'):
                raise ValueError('Agent HUD statistics unavailable')
            stats = json.loads(result['content'][0]['text'])
        finally:
            process.terminate()
    coverage = stats['coverage']
    if not coverage.get('observedFrom') or provider in coverage.get('unavailableProviders', []):
        return {}
    observed = datetime.fromisoformat(coverage['observedFrom'].replace('Z', '+00:00'))
    observed_to = datetime.fromisoformat(coverage['observedTo'].replace('Z', '+00:00'))
    counts = {}
    for bucket in stats['buckets']:
        at = datetime.fromisoformat(bucket['timestamp'].replace('Z', '+00:00')).astimezone(zone)
        count = bucket['selectedTokens']
        # Index gaps and days outside coverage must not look like confirmed zero-use days.
        if count or (observed <= at <= observed_to and not coverage.get('pendingSources')):
            counts[at.date().isoformat()] = count
    return counts


def local_zone():
    # The computer's own zone name (macOS links /etc/localtime into the zoneinfo database).
    if os.environ.get('TZ'):
        return os.environ['TZ']
    link = os.path.realpath('/etc/localtime')
    return link.split('/zoneinfo/', 1)[1] if '/zoneinfo/' in link else 'UTC'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timezone', default=local_zone(), help='IANA zone, e.g. Asia/Tokyo (default: this computer)')
    parser.add_argument('--hud', default=HUD, help='Agent HUD executable supporting --mcp')
    args = parser.parse_args()
    zone = ZoneInfo(args.timezone)
    now = datetime.now(zone)
    today = now.date()
    first = today - timedelta(days=77 + (today.weekday()+1) % 7)
    start = datetime.combine(first, time.min, zone)
    days = {(first+timedelta(days=i)).isoformat(): {} for i in range((today-first).days+1)}
    readings = {'github': github(start, now)}
    for source in ('codex', 'claude'):
        readings[source] = hud_days(args.hud, source, start, now, zone)
    if not all(readings.values()):
        raise SystemExit('A source has no usable records. The previous snapshot is still available.')
    for day, row in days.items():
        row.update({key: values.get(day) for key, values in readings.items()})
    dest = ROOT / 'assets/activity-local/daily.json'
    dest.parent.mkdir(parents=True, exist_ok=True)
    snapshot = dict(asOf=today.isoformat(), updatedAt=now.astimezone(timezone.utc).isoformat(),
                    timeZone=zone.key, days=days)
    with tempfile.NamedTemporaryFile(mode='w', dir=dest.parent, delete=False) as temp:
        json.dump(snapshot, temp, separators=(',', ':'))
    os.replace(temp.name, dest)
    print(f'{len(days)} calendar days through {today} · {dest.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
