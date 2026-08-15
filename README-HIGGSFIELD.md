# SZTR Filipović — setup

## 1. Folder structure

```
projekat-filipovic/
├── index.html
├── style.css
├── script.js
└── assets/
    ├── ograda.glb                  ← your 10K-poly model
    └── higgsfield-trava-loop.mp4   ← generated (see below)
```

## 2. Run it

The site **must** be served over HTTP. Opening `index.html` directly with
`file://` will fail — ES modules and `.glb` fetches are both blocked by CORS
on the file protocol. Any static server works:

```bash
cd projekat-filipovic
npx serve .          # or: python3 -m http.server 8080
```

If `assets/ograda.glb` is missing or fails to parse, the site does **not**
break — it builds an equivalent fence from primitives and logs a warning.
Check the console line starting with `[SZTR] Spremno` to see which was used.

---

## 3. Screen 3 — the Higgsfield neural video texture

Higgsfield is a **generative media platform**: it produces the video asset.
It does not run in the browser and it does not accelerate physics — that part
of the brief was marketing language. The actual acceleration in Screen 3 is
the GPU vertex shader in `WireMorph`, where the panel→coil morph runs entirely
on the graphics card with zero per-frame JavaScript.

So the split is:

| Job | Handled by |
|---|---|
| Hyper-realistic grass loop (PVC Trava) | Higgsfield `generate_video` → MP4 |
| Panel → wire-coil morph (Pletena Žica) | Custom GLSL vertex shader |
| Camera, scroll, assembly | GSAP ScrollTrigger |

### Prompt to generate the loop

```
Macro cinematic shot of dark green PVC privacy grass strips woven vertically
through a galvanized steel chain-link fence, shallow depth of field, soft
overcast daylight, gentle breeze moving the plastic blades, static locked-off
camera, seamless loop, photorealistic, 4 seconds
```

Settings: **1280×720**, static camera, seamless loop, no camera motion
(camera movement breaks the illusion that the plane is behind the fence).

### Encode before shipping

Browser video textures need a web-safe H.264 baseline. Re-encode whatever
Higgsfield returns:

```bash
ffmpeg -i input.mp4 -an \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
  -vf "scale=1280:-2" -crf 26 -movflags +faststart \
  assets/higgsfield-trava-loop.mp4
```

- `-an` strips audio — the element is muted anyway and audio wastes bytes.
- `-profile:v baseline` guarantees hardware decode on old integrated chips.
- `+faststart` moves the index to the front so playback starts before the
  full file has downloaded.

Target **under 2 MB**. The element uses `preload="none"` and only decodes
while PVC Trava is the active mode, so it costs nothing until clicked.

Until the file exists, Screen 3 falls back to a procedurally painted grass
texture. It is obviously a placeholder, which is intentional — a stylised
stand-in reads better than a black plane.

---

## 4. Before going live

- [ ] Replace `+381 00 000 000` and `info@sztr-filipovic.rs` (in `index.html`
      and in `UI._form`).
- [ ] Set the real address in `MAP_QUERY` at the bottom of `script.js`.
- [ ] Point the form at a real endpoint. It currently opens the visitor's
      mail client via `mailto:` — replace that block in `UI._form` with a
      `fetch()` to Formspree or your own handler.
- [ ] Self-host the two Google fonts if you want to drop the third-party
      request entirely.
