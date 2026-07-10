#!/usr/bin/env python3
import json, os, sys, time, uuid, hashlib, glob
from urllib.parse import urlparse, parse_qs

DIR = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default")
BM = os.path.join(DIR, "Bookmarks")
# Always build from the pristine pre-change backup, not whatever Chrome last wrote.
_backups = sorted(glob.glob(os.path.join(DIR, "Bookmarks.backup-*")))
SRC = _backups[-1] if _backups else BM

def update_node(h, node):
    h.update(node.get('id','').encode('utf-8'))
    h.update(node.get('name','').encode('utf-16-le'))
    if node['type'] == 'url':
        h.update(b'url')
        h.update(node['url'].encode('utf-8'))
    else:
        h.update(b'folder')
        for c in node.get('children', []):
            update_node(h, c)

def compute_checksum(roots):
    h = hashlib.md5()
    for key in ('bookmark_bar', 'other', 'synced'):
        update_node(h, roots[key])
    return h.hexdigest()

# (substring-in-url, category). Checked in order; first match wins.
RULES = [
    # --- AI Engineering ---
    ("typingmind.com", "AI Engineering"),
    ("drive.google.com/drive/folders/1kQhae0", "AI Engineering"),
    ("1DNtKoRG8Y8", "AI Engineering"),
    ("genaibook", "AI Engineering"),
    ("ai-eng-projects", "AI Engineering"),
    ("jolly-field-035345f1e", "AI Engineering"),
    ("ui-ux-pro-max-skill", "AI Engineering"),
    # --- Coding Interview & System Design ---
    ("coding-interview-patterns", "Coding Interview & System Design"),
    ("bytebytego.com/exercises", "Coding Interview & System Design"),
    ("javarevisited/10-best-system-design", "Coding Interview & System Design"),
    ("educative.io/path/scalability", "Coding Interview & System Design"),
    ("infoq.com/articles/data-model-mongodb", "Coding Interview & System Design"),
    # --- Courses & Learning ---
    ("schoolofmotion.com/library", "Courses & Learning"),
    ("hub.schoolofmotion.com", "Courses & Learning"),
    ("joshwcomeau.com", "Courses & Learning"),
    ("courses.nan.fyi", "Courses & Learning"),
    ("jsmastery.com/course/gsap", "Courses & Learning"),
    ("investingwithrain.com", "Courses & Learning"),
    ("codewithandrea.com", "Courses & Learning"),
    ("ebook4expert.org", "Courses & Learning"),
    ("how-to-learn-digital-marketing", "Courses & Learning"),
    ("educative.io/projects", "Courses & Learning"),
    ("courses.edx.org", "Courses & Learning"),
    ("MicrosoftDeveloper", "Courses & Learning"),
    ("watch?v=Rub-JsjMhWY", "Courses & Learning"),
    ("watch?v=_bYFu9mBnr4", "Courses & Learning"),
    ("watch?v=jaVNP3nIAv0", "Courses & Learning"),
    ("watch?v=OK_JCtrrv-c", "Courses & Learning"),
    ("watch?v=7TF00hJI78Y", "Courses & Learning"),
    ("watch?v=qVU3V0A05k8", "Courses & Learning"),
    ("watch?v=CYNZ6QTbB3A", "Courses & Learning"),
    ("list=PLgCYzUzKIBE9", "Courses & Learning"),
    # --- Flutter (subfolder) ---
    ("codemagic.io", "Flutter"),
    ("medium.freecodecamp.org/learn-flutter", "Flutter"),
    ("startflutter.com", "Flutter"),
    ("flutter.dev/docs/cookbook", "Flutter"),
    ("mdanics/fluttergram", "Flutter"),
    ("flutter-layout-cheat-sheet", "Flutter"),
    ("FlutterFire", "Flutter"),
    ("building-a-chat-app-with-flutter", "Flutter"),
    ("Solido/awesome-flutter", "Flutter"),
    ("flutter/samples", "Flutter"),
    ("21doc.net/awesome/platformsflutter", "Flutter"),
    ("flatteredwithflutter.com", "Flutter"),
    ("gitter.im/flutter", "Flutter"),
    ("Agora-Flutter-Quickstart", "Flutter"),
    ("simple-and-bug-free-code-with-dart", "Flutter"),
    ("flutter/flutter/issues/63281", "Flutter"),
    ("watch?v=qWL1lGchpRA", "Flutter"),
    ("flutter_counter_challenge_2020", "Flutter"),
    ("wilsonwilson.dev/flutter-resources", "Flutter"),
    ("flutter.dev/docs/get-started/install/macos", "Flutter"),
    # --- Angular (subfolder) ---
    ("jira-clone-angular", "Angular"),
    ("angular-spotify", "Angular"),
    ("paperless-ng", "Angular"),
    ("Chocobozzz/PeerTube", "Angular"),
    ("ever-co/ever-demand", "Angular"),
    ("withinpixels/fuse-angular", "Angular"),
    # --- Web Dev ---
    ("getbootstrap.com", "Web Dev"),
    ("codepen.io/chrisdothtml", "Web Dev"),
    ("redstapler.co", "Web Dev"),
    ("bootstrapdash.com", "Web Dev"),
    ("codepen.io/frankhe", "Web Dev"),
    ("gitness.com", "Web Dev"),
    ("abjt14/portfolio", "Web Dev"),
    ("carbon.now.sh", "Web Dev"),
    ("downloadly.ir", "Web Dev"),
    ("jsonformatter.curiousconcept", "Web Dev"),
    ("squareup.com", "Web Dev"),
    ("vercel.com/junmuns-projects", "Web Dev"),
    ("localhost:3000/community", "Web Dev"),
    ("localhost:8080", "Web Dev"),
    # --- Design & UI ---
    ("godly.website", "Design & UI"),
    ("dribbble.com", "Design & UI"),
    ("mobbin.design", "Design & UI"),
    ("ui.aceternity.com", "Design & UI"),
    ("reactbits.dev", "Design & UI"),
    ("itshover.com", "Design & UI"),
    ("21st.dev", "Design & UI"),
    ("watch?v=dWZNtpNRpG8", "Design & UI"),
    ("uplabs.com/android", "Design & UI"),
    ("developer.apple.com/design/human-interface", "Design & UI"),
    ("vakoshvili.com/resources", "Design & UI"),
    ("data-to-viz.com", "Design & UI"),
    ("datavizproject.com", "Design & UI"),
    ("magicui.design", "Design & UI"),
    # --- Design Assets ---
    ("lucide.dev", "Design Assets"),
    ("thenounproject.com", "Design Assets"),
    ("bgjar.com", "Design Assets"),
    ("tailwindtoolbox.com", "Design Assets"),
    ("tailwindcomponents.com/gradient", "Design Assets"),
    ("iconbolt.com", "Design Assets"),
    ("happyhues.co", "Design Assets"),
    ("icons8.com", "Design Assets"),
    ("vecteezy.com", "Design Assets"),
    ("app.brandmark.io", "Design Assets"),
    ("materialpalette.com", "Design Assets"),
    ("colorhunt.co", "Design Assets"),
    ("iconstore.co", "Design Assets"),
    ("13uIkU26WLBf6DZiSV9Bg9V_2g12ttG-M", "Design Assets"),
    ("contrast-ratio.com", "Design Assets"),
    ("coolors.co", "Design Assets"),
    ("uicolors.app", "Design Assets"),
    ("fonts.google.com", "Design Assets"),
    ("fontawesome.com", "Design Assets"),
    ("gwfh.mranftl.com", "Design Assets"),
    ("2dimensions.com", "Design Assets"),
    ("nappy.co", "Design Assets"),
    ("pexels.com", "Design Assets"),
    ("pixabay.com", "Design Assets"),
    ("unsplash.com", "Design Assets"),
    ("genderphotos.vice.com", "Design Assets"),
    # --- Music ---
    ("UC65OhXlLUNeuWJ", "Music"),
    ("watch?v=ec6pJSIw4L8", "Music"),
    ("user/dancepiano", "Music"),
    ("watch?v=vphWgqbF-AM", "Music"),
    ("user/stevenhu1130", "Music"),
    ("musescore.com/piano-tutorial", "Music"),
    ("bilibili.com/video/av27913157", "Music"),
    ("bilibili.com/video/av62117371", "Music"),
    ("wiki.nicechord.com", "Music"),
    ("space.bilibili.com/326251291", "Music"),
    ("watch?v=G1vs12WNCms", "Music"),
    ("songsterr.com", "Music"),
    # --- Crypto & NFT ---
    ("nftnerds.ai", "Crypto & NFT"),
    ("genie.xyz", "Crypto & NFT"),
    ("revoke.defiplot.com", "Crypto & NFT"),
    ("objkt.com/profile", "Crypto & NFT"),
    # --- Shopping ---
    ("1688.com", "Shopping"),
    # --- Personal ---
    ("dandanzan.com", "Personal"),
    ("reddit.com/r/TheGenius", "Personal"),
    ("jable.tv", "Personal"),
    ("h5.hunbei.com", "Personal"),
    ("process-safety-lab.com/archives/26622", "Personal"),
    ("vjshi.com/watch/9516769", "Personal"),
    ("muscleandstrength.com", "Personal"),
    ("gothere.sg", "Personal"),
    ("officialharrylee.com", "Personal"),
    ("tapfiliate", "Personal"),
    # --- Archive (stale) ---
    ("artsonline.monash.edu.au/korean", "Archive"),
    ("agoda.com", "Archive"),
    ("booking.com/hotel/tw/queens-hotel", "Archive"),
    ("bitbucket.org/eugenmihailescu/lexicon", "Archive"),
    ("flashdba.com", "Archive"),
    ("mitsueki.sg", "Archive"),
    ("google.com.sg/search?q=hsiao", "Archive"),
    ("towardsdatascience.com/getting-started-with-git", "Archive"),
    ("academind.com/learn/web-dev/git", "Archive"),
    ("accaglobal.com", "Archive"),
    ("portal.ishinecloud.sg", "Archive"),
]

# Top-level folder order on the Bookmarks Bar
BAR_FOLDER_ORDER = [
    "AI Engineering", "Courses & Learning", "Web Dev", "Design & UI",
    "Design Assets", "Coding Interview & System Design", "Music",
    "Crypto & NFT", "Shopping", "Personal",
]

def normkey(url):
    """Normalized dedupe key: scheme-less host+path+query, with youtube collapsed by video/list id."""
    p = urlparse(url)
    host = p.netloc.lower().replace("www.", "")
    if "youtube.com" in host:
        q = parse_qs(p.query)
        if p.path.startswith("/watch") and "v" in q:
            return "yt:" + q["v"][0]
        if "list" in q and (p.path.startswith("/playlist") or p.path == "/"):
            return "ytlist:" + q["list"][0]
    key = host + p.path.rstrip("/")
    if p.query:
        key += "?" + p.query
    return key.lower()

def is_bar(url):
    nk = normkey(url)
    if nk == "google.com.my": return "Google"
    if nk == "youtube.com": return "YouTube"
    if nk == "facebook.com": return "Facebook"
    if "accounts.google.com/servicelogin?service=mail" in url.lower(): return "Gmail"
    if "github.com/junmun28?tab=repositories" in url.lower(): return "GitHub"
    return None

def classify(url):
    if is_bar(url):
        return "BAR"
    low = url.lower()
    for sub, cat in RULES:
        if sub.lower() in low:
            return cat
    return None

def collect(node, acc):
    if node.get("type") == "url":
        acc.append(node)
    for c in node.get("children", []):
        collect(c, acc)

def main():
    data = json.load(open(SRC))
    roots = data["roots"]
    leaves = []
    for key in ("bookmark_bar", "other", "synced"):
        if key in roots:
            collect(roots[key], leaves)

    # dedupe by normalized key, first wins
    seen = {}
    deduped, dropped = [], []
    for n in leaves:
        k = normkey(n["url"])
        if k in seen:
            dropped.append((n.get("name", ""), n["url"]))
        else:
            seen[k] = n
            deduped.append(n)

    buckets = {}
    unclassified = []
    for n in deduped:
        cat = classify(n["url"])
        if cat is None:
            unclassified.append((n.get("name", ""), n["url"]))
        else:
            buckets.setdefault(cat, []).append(n)

    if "--dry" in sys.argv:
        print(f"total leaves: {len(leaves)}  |  after dedupe: {len(deduped)}  |  dropped dups: {len(dropped)}\n")
        for cat in (["BAR"] + BAR_FOLDER_ORDER + ["Angular", "Flutter", "Archive"]):
            print(f"  {cat:38} {len(buckets.get(cat, []))}")
        print(f"\nDROPPED DUPLICATES ({len(dropped)}):")
        for name, u in dropped:
            print(f"  - {name[:70]}")
        print(f"\nUNCLASSIFIED ({len(unclassified)}):")
        for name, u in unclassified:
            print(f"  ! {name[:60]} :: {u[:80]}")
        return

    # ---- build mode ----
    base_id = max((int(n.get("id", "0")) for n in leaves), default=1000) + 1000
    counter = [base_id]
    now_us = str(int((time.time() + 11644473600) * 1_000_000))  # webkit epoch microseconds

    def folder(name, children):
        counter[0] += 1
        return {
            "type": "folder", "name": name, "children": children,
            "date_added": now_us, "date_modified": now_us,
            "guid": str(uuid.uuid4()), "id": str(counter[0]),
        }

    def items(cat):
        return buckets.get(cat, [])

    webdev_children = [
        folder("Angular", items("Angular")),
        folder("Flutter", items("Flutter")),
    ] + items("Web Dev")

    bar_folders = []
    for cat in BAR_FOLDER_ORDER:
        if cat == "Web Dev":
            bar_folders.append(folder("Web Dev", webdev_children))
        else:
            bar_folders.append(folder(cat, items(cat)))

    # loose quick links on the bar, in a chosen order
    bar_quick_order = ["Google", "Gmail", "YouTube", "GitHub", "Facebook"]
    bar_quick = {is_bar(n["url"]): n for n in buckets.get("BAR", [])}
    bar_loose = [bar_quick[name] for name in bar_quick_order if name in bar_quick]

    roots["bookmark_bar"]["children"] = bar_loose + bar_folders
    roots["bookmark_bar"]["date_modified"] = now_us
    roots["other"]["children"] = [folder("Archive", items("Archive"))]
    roots["other"]["date_modified"] = now_us
    roots["synced"]["children"] = []
    roots["synced"]["date_modified"] = now_us

    data["checksum"] = compute_checksum(roots)  # so Chrome trusts the file
    json.dump(data, open(BM, "w"), indent=3)
    print(f"SRC  {SRC}")
    print(f"WROTE {BM}")
    print(f"checksum: {data['checksum']}")
    print(f"bar loose: {len(bar_loose)}  bar folders: {len(bar_folders)}  archive: {len(items('Archive'))}")

if __name__ == "__main__":
    main()
