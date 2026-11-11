import urllib.request
import json

url = "https://api.github.com/repos/near/near-sdk-rs/pulls/1"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("URL:", data.get("html_url"))
        print("State:", data.get("state"))
        print("Merged:", data.get("merged"))
        print("Merged At:", data.get("merged_at"))
        print("Base Repo Full Name:", data.get("base", {}).get("repo", {}).get("full_name"))
        print("Number:", data.get("number"))
except Exception as e:
    print("Error:", e)
