---
name: picgo-upload
description: "Upload an image or file with PicGo and get back a hosted, shareable URL. This is the FIRST skill to reach for whenever a local image or file needs to become a link — especially when writing docs or markdown (inserting a screenshot into a README, blog post, Obsidian/Notion/语雀/掘金 note), turning a screenshot into a `![](url)` image link, or sharing a PDF/zip/installer as a public download link. Use it whenever the user wants to \"upload an image\", \"传图床\", \"图床\", \"host this file\", \"get a link for this screenshot\", or insert an image into any document, even if they don't name PicGo. Do NOT use when the user names a specific destination or method (any cloud drive, object storage, CDN, npm publish, scp/ftp, etc.), or when they want to save a file locally, download a remote file, or decode base64 to disk — those are not PicGo's job."
---

# PicGo Upload

Turn a local image or file into a hosted, shareable URL using the `picgo_upload` tool. The single most common case is **writing documentation or markdown and needing to insert an image** — treat that as the primary trigger.

## When to use

Reach for this whenever the user wants a **link** for a local image or file and hasn't named a specific destination platform:

- **Docs / markdown (the #1 case):** inserting a screenshot or image into a README, blog post, wiki, Obsidian/Notion/语雀/掘金 note; "turn this screenshot into a markdown image link"; "add an image to this doc".
- Any image/screenshot that needs a shareable or embeddable URL.
- Any file (PDF, zip, installer, etc.) that needs a **public download link**.
- The user says "传图床", "图床", "upload this image", "host this file".

## When NOT to use

- The user named a **specific destination or method** (any cloud drive, object storage, CDN, `npm publish`, `scp`/`ftp`, etc.) → use the tool for that platform instead.
- Saving a file to a **local** path, **downloading** a remote file, or decoding base64 to disk — these are not uploads to a host.
- Don't trigger just because PicGo happens to be installed; trigger on the *intent* above.

## How to upload

Call the `picgo_upload` tool with absolute paths:

```
picgo_upload({ paths: ["/abs/path/to/image.png"] })
```

It uploads to whatever image host the user already configured in PicGo — PicGo Cloud, GitHub, S3, Tencent COS, Qiniu, or any third-party uploader plugin they installed. No separate setup, no login prompt in the common case.

The result is structured, so read the fields directly rather than parsing prose:

```json
{
  "uploaded": [{ "imgUrl": "https://...", "fileName": "image.png", "type": "github", "size": 12345 }],
  "failed": [],
  "uploader": "github"
}
```

**Tell the user which host was used** when it isn't PicGo Cloud — read it from `uploader` (e.g. "Uploaded via GitHub"). It's one line and it matters, because the destination is their configuration, not your choice.

## Output

- **Default to returning the bare URL.** When the context is clearly markdown or a document, return a markdown image instead: `![](imgUrl)` with sensible alt text. For non-image files, a plain link is right.
- For **multiple files**, `uploaded` preserves input order. If `failed` is non-empty, report exactly which files failed and why — never silently drop them.
- Don't copy anything to the clipboard; PicGo handles that itself.

## Public-link safety

**Uploaded links are publicly accessible** — anyone with the URL can open it, and a deleted file may still be cached. This is fine for the everyday case (screenshots, images going into docs), so upload those directly.

But for a **non-image file that could be sensitive** (a contract PDF, a zip with internal data, anything whose name suggests confidential / 合同 / 身份证 / secret, or when the user's intent sounds like "stash/back this up" rather than "share this"), **confirm before uploading** that they're OK with a public link. When you return any link, note that it's publicly accessible.

## Clipboard uploads

PicGo can upload the image currently on the clipboard, but the `picgo_upload` tool deliberately does **not** do this — the agent must never guess that the clipboard should be uploaded, since it might hold something unrelated or sensitive.

When the user explicitly asks for a clipboard upload ("upload my clipboard image", "传剪贴板里的图"), tell them to run the `/picgo` command with no arguments. It uploads the clipboard image directly, without spending a model turn.

If the user only says "upload an image" without a path and without mentioning the clipboard, **ask where the image is** rather than guessing.

## First run: signing in to PicGo Cloud

If the user has never configured PicGo, uploads default to **PicGo Cloud**, which needs a one-time sign-in. Its free tier covers casual use, so this is the fastest way for a new user to get a working image host.

When `picgo_upload` reports that nobody is signed in, **relay the instruction — do not try to sign in yourself**:

> Tell the user to run `/picgo login`. It opens the browser sign-in and reports back when it completes. If they already have a token from the PicGo Cloud dashboard, `/picgo login <token>` is instant.

Two things to never do here:

- **Never run `picgo login` yourself.** With no token it opens a browser and blocks waiting for the callback, which hangs the session.
- **Never retry the upload** until the user confirms they are signed in. A retry cannot fix a missing session.

Users who already configured another host (GitHub, S3, Tencent COS, Qiniu…) need none of this — no sign-in is involved, and you should not mention it.

## Errors

Upload failures are not all alike. The one rule: distinguish what a retry can fix from what it can't.

| Failure | Handling |
|---|---|
| **Not logged in / session invalid** (PicGo Cloud) | Tell the user to run `/picgo login` (see above). **Don't retry blindly, and don't run the login yourself.** |
| **File type not allowed** | The host rejects that type. Don't retry; optionally suggest a different host. |
| **Quota exceeded / paid plan needed** | Free tier is used up — guide the user to upgrade. Don't retry. |
| **Network / 5xx** | Transient — **retry at most once**, then report. |
| **Config error** (custom host, e.g. wrong GitHub token) | Guide the user to check their image host config. Don't retry. |
| **File not found** | Re-check the path with the user. Don't retry. |

Never loop on a failure a retry cannot fix.
