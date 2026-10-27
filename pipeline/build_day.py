#!/usr/bin/env python3
"""Build today's game from live Israeli supermarket price feeds.

Standard library only. Usage:
    python pipeline/build_day.py [--date YYYY-MM-DD] [--chain shufersal|ramilevy] [--force]

Writes data/days/<date>.json, updates data/index.json, and downloads any missing
product images into images/<barcode>.jpg (from Open Food Facts).
"""
import argparse, datetime as dt, gzip, html, io, json, random, re, sys, time, urllib.parse, urllib.request, http.cookiejar, xml.etree.ElementTree as ET, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
DAYS = DATA / 'days'
IMAGES = ROOT / 'images'
STAPLES = json.loads((ROOT / 'pipeline' / 'staples.json').read_text(encoding='utf-8'))
BASKETS = json.loads((ROOT / 'pipeline' / 'baskets.json').read_text(encoding='utf-8'))
UA = 'kamaze-game/1.0 (+https://github.com/benklinger/kamaze)'
TZ = dt.timezone(dt.timedelta(hours=2))  # Israel standard time; only used to pick "today"

CHAINS = {
    'shufersal': {
        'name': 'שופרסל',
        # Preferred stores in order; first one with a published file today wins.
        'stores': [('69', 'שופרסל שלי רמת אביב ב׳, תל אביב'), ('596', 'שופרסל אקספרס אבן גבירול, תל אביב'), ('41', 'BE דיזנגוף סנטר, תל אביב')],
    },
    'ramilevy': {
        'name': 'רמי לוי',
        'stores': [('1', 'רמי לוי שיווק השקמה'), ],  # any store accepted as fallback, name read from the feed
    },
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_get(url, opener=None, data=None, timeout=90, headers=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, **(headers or {})})
    op = opener or urllib.request.build_opener()
    with op.open(req, timeout=timeout) as r:
        return r.read()


def read_price_file(raw):
    """Return (store_id, {barcode: (name, price)}) from a gz/zip/xml PriceFull payload."""
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    elif raw[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    root = ET.fromstring(raw.decode('utf-8-sig', errors='replace'))
    def find(node, name):
        for c in node.iter():
            if c.tag.lower() == name.lower():
                return (c.text or '').strip()
        return ''
    store_id = find(root, 'StoreId')
    items = {}
    for it in root.iter():
        if it.tag.lower() != 'item':
            continue
        f = {c.tag.lower(): (c.text or '').strip() for c in it}
        code, price = f.get('itemcode', ''), f.get('itemprice', '')
        try:
            price = float(price)
        except ValueError:
            continue
        if code and price > 0:
            items[code] = (f.get('itemname', ''), price)
    return store_id, items


# ---------------- Shufersal ----------------
def fetch_shufersal(preferred):
    base = 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&sort=Time&sortdir=DESC'
    page = http_get(base).decode('utf-8', 'replace')
    links = [html.unescape(m) for m in re.findall(r'href="(https://[^"]+/pricefull/PriceFull[^"]+)"', page)]
    if not links:
        raise RuntimeError('Shufersal: no PriceFull links found')
    def store_of(u):
        m = re.search(r'PriceFull\d+-\d{3}-(\d+)-', u)
        return m.group(1) if m else ''
    chosen = None
    for sid, label in preferred:
        for u in links:
            if store_of(u) == sid:
                chosen, name = u, label
                break
        if chosen:
            break
    if not chosen:
        chosen, name = links[0], shufersal_store_name(store_of(links[0]))
    log('Shufersal file:', chosen.split('?')[0])
    _, items = read_price_file(http_get(chosen))
    return name, items


def shufersal_store_name(store_id):
    """Resolve 'שופרסל <sub-chain> <store>' from the daily Stores file; fall back to the id."""
    try:
        page = http_get('https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=5&storeId=0').decode('utf-8', 'replace')
        m = re.search(r'href="(https://[^"]+/stores/Stores[^"]+)"', page)
        raw = http_get(html.unescape(m.group(1)))
        if raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        root = ET.fromstring(raw.decode('utf-8-sig', 'replace'))
        for sc in root.iter('SubChain'):
            sub = (sc.findtext('SubChainName') or '').strip()
            for st in sc.iter('Store'):
                if (st.findtext('StoreID') or '').lstrip('0') == store_id.lstrip('0'):
                    name = (st.findtext('StoreName') or '').strip()
                    return f"{sub} – {name}" if not name.startswith(sub.replace('שופרסל ', '')) else f"שופרסל {name}"
    except Exception as e:  # noqa
        log('Shufersal store lookup failed:', e)
    return f'שופרסל (סניף {store_id})'


# ---------------- Rami Levy (publishedprices.co.il portal) ----------------
def csrf_token(page):
    m = (re.search(r'<meta\s+name="csrftoken"\s+content="([^"]+)"', page)
         or re.search(r'name="csrftoken"[^>]*value="([^"]+)"', page)
         or re.search(r'value="([^"]+)"[^>]*name="csrftoken"', page))
    return m.group(1) if m else ''


def fetch_ramilevy(preferred):
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    login_page = http_get('https://url.publishedprices.co.il/login', op).decode('utf-8', 'replace')
    token = csrf_token(login_page)
    http_get('https://url.publishedprices.co.il/login/user', op,
             data=urllib.parse.urlencode({'csrftoken': token, 'username': 'RamiLevi', 'password': '', 'r': ''}).encode())
    file_page = http_get('https://url.publishedprices.co.il/file', op).decode('utf-8', 'replace')
    token = csrf_token(file_page) or token
    body = urllib.parse.urlencode({'sEcho': 1, 'iColumns': 5, 'sColumns': ',,,,', 'iDisplayStart': 0, 'iDisplayLength': 1000,
                                   'sSearch': 'PriceFull', 'cd': '/', 'csrftoken': token}).encode()
    listing = json.loads(http_get('https://url.publishedprices.co.il/file/json/dir', op, data=body, headers={'X-Requested-With': 'XMLHttpRequest'}))
    rows = listing.get('aaData') or listing.get('data') or []
    names = []
    for r in rows:
        s = json.dumps(r, ensure_ascii=False)
        names += re.findall(r'(PriceFull\d+-\d+-\d{12}\.(?:gz|xml|zip))', s)
    names = sorted(set(names), reverse=True)
    if not names:
        raise RuntimeError('Rami Levy: no PriceFull files listed')
    today = dt.datetime.now(TZ).strftime('%Y%m%d')
    todays = [n for n in names if f'-{today}' in n] or names
    def store_of(n):
        return re.search(r'PriceFull\d+-(\d+)-', n).group(1).lstrip('0') or '0'
    chosen, label = None, None
    for sid, lbl in preferred:
        for n in todays:
            if store_of(n) == sid:
                chosen, label = n, lbl
                break
        if chosen:
            break
    if not chosen:
        chosen = todays[0]
    log('Rami Levy file:', chosen)
    store_id, items = read_price_file(http_get('https://url.publishedprices.co.il/file/d/' + chosen, op))
    if not label:
        label = f'רמי לוי (סניף {store_id or store_of(chosen)})'
        try:  # try to resolve the store name from the Stores file
            body = urllib.parse.urlencode({'sEcho': 1, 'iColumns': 5, 'iDisplayStart': 0, 'iDisplayLength': 50, 'sSearch': 'Stores', 'cd': '/', 'csrftoken': token}).encode()
            lst = json.loads(http_get('https://url.publishedprices.co.il/file/json/dir', op, data=body, headers={'X-Requested-With': 'XMLHttpRequest'}))
            sn = re.findall(r'(Stores\d+-\d+-\d{12}\.(?:gz|xml|zip))', json.dumps(lst))
            if sn:
                raw = http_get('https://url.publishedprices.co.il/file/d/' + sorted(sn)[-1], op)
                if raw[:2] == b'\x1f\x8b':
                    raw = gzip.decompress(raw)
                root = ET.fromstring(raw.decode('utf-8-sig', 'replace'))
                for st in root.iter():
                    if st.tag.lower() == 'store':
                        f = {c.tag.lower(): (c.text or '').strip() for c in st}
                        if f.get('storeid', '').lstrip('0') == (store_id or store_of(chosen)).lstrip('0'):
                            label = f"רמי לוי {f.get('storename', '')}, {f.get('city', '')}".strip(', ')
                            break
        except Exception as e:  # noqa
            log('store name lookup failed:', e)
    return label, items


FETCHERS = {'shufersal': fetch_shufersal, 'ramilevy': fetch_ramilevy}


# ---------------- selection ----------------
def nice_round(x):
    """Round a shekel amount to a 'nice' slider boundary."""
    if x < 10:
        return round(x * 10) / 10
    if x < 50:
        return round(x * 2) / 2
    return float(round(x))


def make_range(price, rng):
    lo = nice_round(price * rng.uniform(0.40, 0.72))
    hi = nice_round(price * rng.uniform(1.30, 1.95))
    lo = max(0.5, min(lo, price - 0.5))
    hi = max(hi, price + 0.5)
    return lo, hi


def recent_barcodes(exclude_date, days=14):
    seen = set()
    files = [p for p in sorted(DAYS.glob('*.json'), reverse=True) if p.stem != exclude_date]
    for p in files[:days]:
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
            seen.update(x['barcode'] for x in d['products'])
        except Exception:
            pass
    return seen


def ensure_image(barcode):
    out = IMAGES / f'{barcode}.jpg'
    if out.exists():
        return f'images/{barcode}.jpg'
    try:
        url = f'https://world.openfoodfacts.org/api/v2/product/{barcode}.json?fields=image_front_url'
        d = json.loads(http_get(url, timeout=40))
        img = (d.get('product') or {}).get('image_front_url')
        if img:
            out.write_bytes(http_get(img, timeout=60))
            log('downloaded image for', barcode)
            return f'images/{barcode}.jpg'
    except Exception as e:  # noqa
        log('image fetch failed for', barcode, e)
    return 'images/placeholder.svg'


def build(date, chain, items, store_label):
    rng = random.Random(f'{date}:{chain}')
    staples = {s['barcode']: s for s in STAPLES}
    avail = {b: items[b] for b in staples if b in items}
    log(f'{len(avail)}/{len(staples)} staples found in feed')
    if len(avail) < 8:
        raise RuntimeError('too few staples found in this feed')
    recent = recent_barcodes(date)

    # basket: all products must be in the feed; prefer baskets not used recently
    baskets = [b for b in BASKETS if all(x in avail for x in b['barcodes'])]
    if not baskets:
        raise RuntimeError('no complete basket available')
    fresh = [b for b in baskets if not any(x in recent for x in b['barcodes'])]
    basket = rng.choice(fresh or baskets)

    # product of the day: not in basket, prefer not seen recently
    pool = [b for b in avail if b not in basket['barcodes']]
    fresh = [b for b in pool if b not in recent]
    product = rng.choice(fresh or pool)

    products = []
    for i, bc in enumerate([product] + basket['barcodes'], start=1):
        price = avail[bc][1]
        lo, hi = make_range(price, rng)
        products.append({'id': i, 'barcode': bc, 'name': staples[bc]['name'], 'image': ensure_image(bc),
                         'price': round(price, 2), 'min': lo, 'max': hi})
    return {
        'date': date, 'chain': chain, 'chainName': CHAINS[chain]['name'], 'store': store_label,
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'products': products,
        'basket': {'name': basket['name'], 'products': list(range(2, 2 + len(basket['barcodes'])))},
    }


def update_index():
    days = []
    for p in sorted(DAYS.glob('*.json'), reverse=True):
        d = json.loads(p.read_text(encoding='utf-8'))
        days.append({'date': d['date'], 'chainName': d['chainName'], 'product': d['products'][0]['name'], 'basket': d['basket']['name']})
    (DATA / 'index.json').write_text(json.dumps({'days': days, 'updated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}, ensure_ascii=False, indent=1), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default=dt.datetime.now(TZ).strftime('%Y-%m-%d'))
    ap.add_argument('--chain', choices=list(CHAINS))
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    DAYS.mkdir(parents=True, exist_ok=True)
    out = DAYS / f'{a.date}.json'
    if out.exists() and not a.force:
        log(f'{out.name} already exists; use --force to rebuild')
        update_index()
        return 0
    # alternate chains by day; fall back to the other chain if a feed fails
    order = [a.chain] if a.chain else (['shufersal', 'ramilevy'] if dt.date.fromisoformat(a.date).toordinal() % 2 == 0 else ['ramilevy', 'shufersal'])
    errors = []
    for chain in order:
        try:
            label, items = FETCHERS[chain](CHAINS[chain]['stores'])
            log(f'{chain}: {len(items)} priced items from {label}')
            day = build(a.date, chain, items, label)
            out.write_text(json.dumps(day, ensure_ascii=False, indent=1), encoding='utf-8')
            update_index()
            log('wrote', out)
            return 0
        except Exception as e:  # noqa
            log(f'{chain} failed: {e!r}')
            errors.append(f'{chain}: {e!r}')
    log('ALL CHAINS FAILED:\n' + '\n'.join(errors))
    return 1


if __name__ == '__main__':
    sys.exit(main())
