import urllib.request
import json

url = "https://api.github.com/repos/facebook/react/pulls/1"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("URL:", data.get("html_url"))
        print("State:", data.get("state"))
        print("Merged:", data.get("merged"))
        print("Merged At:", data.get("merged_at"))
        print("Merge Commit SHA:", data.get("merge_commit_sha"))
        print("Base Ref:", data.get("base", {}).get("ref"))
        print("Base Repo Full Name:", data.get("base", {}).get("repo", {}).get("full_name"))
        print("Head User:", data.get("head", {}).get("user", {}).get("login"))
        print("Number:", data.get("number"))
        print("\nAll top-level keys:", list(data.keys()))
except Exception as e:
    print("Error fetching GitHub PR:", e)
