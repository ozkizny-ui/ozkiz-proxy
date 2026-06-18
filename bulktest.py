# bulk-create-ads 검증 — Drive 실제 파일명(정확 바이트)으로 dry_run → 실제 생성
import urllib.request, urllib.error, json, time

BASE = "https://ozkiz-proxy.vercel.app/api"
CAMP_NAME = "ODC_Meta_2026_여름_260324"   # 이름 resolve 경로 테스트(이미지)
CAMP_ID   = "6908128883842"               # id 직접 경로 테스트(영상)

def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)

def post(path, payload):
    req = urllib.request.Request(f"{BASE}/{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.load(r), round(time.time()-t0,1)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e), round(time.time()-t0,1)

# 1) Drive 폴더에서 정확한 파일명 확보 (정규화 이슈 회피)
d = get(f"{BASE}/meta?action=drive_test")
files = d["folder_files"]
img = next(f for f in files if f["mimeType"].startswith("image/"))
vids = [f for f in files if f["mimeType"].startswith("video/")]
vid = max(vids, key=lambda f: int(f["size"]))  # 가장 큰 영상(90MB)
print("이미지:", img["name"], f'({int(img["size"])/1024/1024:.2f}MB)')
print("영상  :", vid["name"], f'({int(vid["size"])/1024/1024:.2f}MB)')

rows = [
    {"rowIndex": 1, "type": "image", "campaign": CAMP_NAME, "filename": img["name"],
     "caption": "대량검증 이미지", "landing_url": "https://ozkiz.com/"},
    {"rowIndex": 2, "type": "video", "campaign": CAMP_ID, "filename": vid["name"],
     "caption": "대량검증 영상(90MB file_url)", "landing_url": "https://ozkiz.com/"},
]

# 2) dry_run (검증/캠페인/Drive존재만)
print("\n=== dry_run ===")
st, res, secs = post("bulk-create-ads", {"rows": rows, "dry_run": True})
print(f"status={st} {secs}s")
print(json.dumps(res, ensure_ascii=False, indent=1))

# 3) 실제 생성
print("\n=== 실제 생성 ===")
st, res, secs = post("bulk-create-ads", {"rows": rows})
print(f"status={st} {secs}s")
print(json.dumps(res, ensure_ascii=False, indent=1))

# 생성된 adset_id들 출력 (정리용)
made = [r.get("adset_id") for r in res.get("results", []) if r.get("status") == "ok" and r.get("adset_id")]
print("\n생성된 adset_id:", made)
