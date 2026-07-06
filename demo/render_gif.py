#!/usr/bin/env python3
"""render_gif.py - render the demo hero GIF directly with Pillow.

VHS wedges on this Windows box (ttyd/browser spawn), so this renders the SAME story
deterministically: run the REAL demo client, capture its real ANSI output, and draw a
typewriter-style terminal recording frame by frame. No browser, no ttyd, no ffmpeg.

Usage (from the repo root):
    python demo/render_gif.py            -> demo/toolfunnel-demo.gif
"""
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "demo", "toolfunnel-demo.gif")

# ── Dracula-ish palette ────────────────────────────────────────────────────────
BG = (40, 42, 54)
BAR = (30, 31, 41)
FG = (248, 248, 242)
DIM = (98, 114, 164)
CYAN = (139, 233, 253)
GREEN = (80, 250, 123)
RED = (255, 85, 85)
PROMPT = (189, 147, 249)

W, H = 1080, 640
PAD_X, PAD_Y = 28, 56
LINE_H = 26
FONT_SIZE = 17

ANSI = re.compile(r"\x1b\[(\d+)m")
COLOURS = {"2": DIM, "36": CYAN, "32": GREEN, "31": RED, "1": FG, "0": None}


def load_font():
    for name in (r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\cour.ttf"):
        if os.path.exists(name):
            return ImageFont.truetype(name, FONT_SIZE)
    return ImageFont.load_default()


FONT = load_font()


def parse_ansi(line):
    """One ANSI line -> [(text, colour), ...] using the demo client's small code set."""
    segs, colour, pos = [], FG, 0
    for m in ANSI.finditer(line):
        if m.start() > pos:
            segs.append((line[pos:m.start()], colour))
        code = m.group(1)
        colour = FG if code in ("0", "1") else COLOURS.get(code, colour) or FG
        pos = m.end()
    if pos < len(line):
        segs.append((line[pos:], colour))
    return segs


def capture_demo():
    """Run the REAL client and return its ANSI output lines."""
    node = os.environ.get("TOOLFUNNEL_NODE", "node")
    res = subprocess.run(
        [node, os.path.join(ROOT, "demo", "client.js"), "--denied"],
        cwd=ROOT, capture_output=True, text=True, timeout=90,
    )
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        raise SystemExit("demo client failed - nothing to record")
    return [ln.rstrip() for ln in res.stdout.splitlines()]


def capture_pack():
    """Run the REAL tf_pack (format npm) against a throwaway copy of the demo home.
    Returns the dist/my-tools listing lines. Everything shown in the pack beat is real."""
    import json
    import shutil
    import tempfile
    node = os.environ.get("TOOLFUNNEL_NODE", "node")
    tmp = tempfile.mkdtemp(prefix="tf-demo-pack-")
    try:
        home = os.path.join(tmp, "home")
        shutil.copytree(os.path.join(ROOT, "demo", "home"), home)
        env = dict(os.environ,
                   TOOLFUNNEL_HOME=home,
                   TOOLFUNNEL_PKG=ROOT,
                   TOOLFUNNEL_TOOL_ARGS=json.dumps({"format": "npm", "name": "my-tools"}))
        # The minimal demo home carries only the 3 user scripts (tf-* arrive via seeding at
        # runtime), so run the PACKAGE's tf-pack.js pointed at the copied home via the env
        # contract - the exact layout a seeded script runs under.
        res = subprocess.run(
            [node, os.path.join(ROOT, "tools", "scripts", "tf-pack.js")],
            cwd=ROOT, capture_output=True, text=True, timeout=60, env=env,
        )
        payload = json.loads(res.stdout.strip())
        if not payload.get("ok"):
            raise SystemExit("tf_pack failed: " + str(payload))
        out = os.path.join(home, "dist", "my-tools")
        top = sorted(os.listdir(out))
        return top
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


EDGE = next((p for p in (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
) if os.path.exists(p)), None)


def capture_ui():
    """Start the REAL config UI against a throwaway demo home, screenshot it headlessly
    (Edge - present on every Windows box), return the PNG path or None (beat is skipped)."""
    import shutil
    import tempfile
    import time
    if not EDGE:
        return None
    node = os.environ.get("TOOLFUNNEL_NODE", "node")
    tmp = tempfile.mkdtemp(prefix="tf-demo-ui-")
    home = os.path.join(tmp, "home")
    shutil.copytree(os.path.join(ROOT, "demo", "home"), home)
    shot = os.path.join(tmp, "ui.png")
    srv = subprocess.Popen(
        [node, os.path.join(ROOT, "bin", "toolfunnel.js"), "--ui", "--config-dir", home],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # Wait until the UI actually answers (seed + bind), not a fixed nap.
        import urllib.request
        up = False
        for _ in range(30):
            try:
                with urllib.request.urlopen("http://127.0.0.1:7332/", timeout=1) as r:
                    up = r.status == 200
                    break
            except Exception:
                time.sleep(0.5)
        if not up:
            return None
        # Edge's launcher can exit before the screenshot is flushed - poll for the file.
        subprocess.run(
            [EDGE, "--headless=new", "--disable-gpu", f"--screenshot={shot}",
             f"--user-data-dir={os.path.join(tmp, 'edgeprofile')}",
             "--window-size=1280,800", "--hide-scrollbars", "http://127.0.0.1:7332/"],
            capture_output=True, timeout=60,
        )
        for _ in range(20):
            if os.path.exists(shot) and os.path.getsize(shot) > 10000:
                keep = os.path.join(tempfile.gettempdir(), "tf-demo-ui.png")
                shutil.copyfile(shot, keep)
                return keep
            time.sleep(0.5)
        return None
    finally:
        srv.terminate()
        shutil.rmtree(tmp, ignore_errors=True)


def image_frame(png_path, caption=None):
    """A full frame showing an image (UI screenshot / logo), letterboxed on the theme bg."""
    img = Image.new("RGB", (W, H), BG)
    src = Image.open(png_path).convert("RGB")
    avail_h = H - 70 - (30 if caption else 0)
    scale = min((W - 40) / src.width, avail_h / src.height)
    src = src.resize((int(src.width * scale), int(src.height * scale)))
    img.paste(src, ((W - src.width) // 2, 50))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 36], fill=BAR)
    for i, colour in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        d.ellipse([16 + i * 24, 12, 28 + i * 24, 24], fill=colour)
    if caption:
        tw = d.textlength(caption, font=FONT)
        d.text(((W - tw) // 2, H - 34), caption, font=FONT, fill=DIM)
    return img


def new_frame(lines):
    """Draw one terminal frame from [(segments, is_typed_prompt)] line tuples."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 36], fill=BAR)
    for i, colour in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        d.ellipse([16 + i * 24, 12, 28 + i * 24, 24], fill=colour)
    d.text((W // 2 - 60, 10), "my-tools - demo", font=FONT, fill=DIM)
    y = PAD_Y
    for segs in lines[-((H - PAD_Y - 20) // LINE_H):]:  # simple scroll: keep the tail
        x = PAD_X
        for text, colour in segs:
            d.text((x, y), text, font=FONT, fill=colour)
            x += d.textlength(text, font=FONT)
        y += LINE_H
    return img


def register_entry_lines(tool_id):
    """The REAL register entry for `tool_id`, pretty-printed as coloured segment lines."""
    import json
    with open(os.path.join(ROOT, "demo", "home", "tools", "tools.register.json"), encoding="utf-8") as f:
        entry = next(t for t in json.load(f)["tools"] if t["id"] == tool_id)
    # Keep the frame honest but readable: full entry, long instructions elided for display.
    if len(entry.get("instructions", "")) > 60:
        entry["instructions"] = entry["instructions"][:57] + "..."
    lines = []
    for raw in json.dumps(entry, indent=2).splitlines():
        stripped = raw.lstrip()
        indent = raw[: len(raw) - len(stripped)]
        if ":" in stripped and stripped.startswith('"'):
            key, rest = stripped.split(":", 1)
            lines.append([(indent, FG), (key, CYAN), (":", FG), (rest, GREEN if '"' in rest else FG)])
        else:
            lines.append([(raw, DIM)])
    return lines


def main():
    demo_lines = capture_demo()
    pack_listing = capture_pack()
    ui_shot = capture_ui()
    if not ui_shot:
        print("note: UI screenshot unavailable - the UI beat will be skipped")
    scripts = sorted(os.listdir(os.path.join(ROOT, "demo", "home", "tools", "scripts")))

    frames, durations = [], []
    shown = []  # committed lines: list of segment-lists

    def snap(ms):
        frames.append(new_frame(shown))
        durations.append(ms)

    def type_line(text, colour=FG, prompt=True, chars_per_frame=3, ms=40):
        prefix = [("$ ", PROMPT)] if prompt else []
        for i in range(0, len(text) + 1, chars_per_frame):
            partial = prefix + [(text[:i], colour), ("█", FG)]
            frames.append(new_frame(shown + [partial]))
            durations.append(ms)
        shown.append(prefix + [(text, colour)])
        snap(350)

    def out_line(segs, ms=90):
        shown.append(segs)
        snap(ms)

    def clear(ms=250):
        shown.clear()
        snap(ms)

    # Beat 1 - the raw material.
    type_line("# you have 3 ordinary scripts - any language, no SDK, no framework:", DIM, prompt=False)
    type_line("ls my-tools/scripts/")
    out_line([("  ".join(scripts), CYAN)], ms=2000)
    out_line([("", FG)], ms=60)

    # Beat 2 - THE MAKING: describe a script to ToolFunnel. One JSON entry, no code.
    type_line("# describe each one to TOOLFUNNEL - one JSON register entry, zero code:", DIM, prompt=False)
    type_line("cat my-tools/tools.register.json   # (the slugify entry)")
    for segs in register_entry_lines("slugify"):
        out_line(segs, ms=110)
    durations[-1] = 3000  # let the entry land
    clear()

    # Beat 3 - the config flip that makes it YOUR server.
    type_line("# promote your tools hot + hide toolfunnel's own - config, not code:", DIM, prompt=False)
    type_line("cat my-tools/tools.state.json")
    out_line([('{ "summarize": {"hot": true}, "sentiment": {"hot": true},', FG)], ms=110)
    out_line([('  "slugify": {"hot": true}, "cleanup": {"hot": true},', FG)], ms=110)
    out_line([('  "toolfunnel_list_tools": {"hot": false}, ', FG), ('... (metas hidden)', DIM)], ms=2200)
    out_line([("", FG)], ms=60)

    # Beat 4 - identity: name it, version it, give it its own ports. Still just config.
    type_line("# name it, version it, pick its ports - toolfunnel.json:", DIM, prompt=False)
    type_line("cat my-tools/toolfunnel.json")
    import json as _json
    with open(os.path.join(ROOT, "demo", "home", "toolfunnel.json"), encoding="utf-8") as f:
        for raw in _json.dumps(_json.load(f), indent=2).splitlines():
            stripped = raw.lstrip()
            if ":" in stripped and stripped.startswith('"'):
                key, rest = stripped.split(":", 1)
                indent = raw[: len(raw) - len(stripped)]
                out_line([(indent, FG), (key, CYAN), (":", FG), (rest, GREEN if '"' in rest else FG)], ms=110)
            else:
                out_line([(raw, DIM)], ms=110)
    durations[-1] = 2400
    clear()

    # Beat 5 - the payoff: ToolFunnel now IS their MCP server. Real captured output.
    type_line("# that's it. toolfunnel now IS your MCP server - ask it yourself:", DIM, prompt=False)
    type_line("node demo/client.js --denied")
    for ln in demo_lines:
        out_line(parse_ansi(ln), ms=240)
    durations[-1] = 2800  # hold on the checkmark line
    clear()

    # Beat 6 - packaging: one call -> a publishable npm package (real tf_pack output).
    type_line("# ship it: ONE call packages everything for npm - tf_pack:", DIM, prompt=False)
    type_line('run_tool tf_pack { "format": "npm", "name": "my-tools" }')
    out_line([("dist/my-tools/", CYAN), ("   " + "   ".join(pack_listing), FG)], ms=2000)
    out_line([("", FG)], ms=60)
    out_line([("$ ", PROMPT), ("cd dist/my-tools && npm publish", FG)], ms=1600)
    out_line([("", FG)], ms=60)
    out_line([("your users:  ", DIM), ("npx my-tools", GREEN),
              ("   (toolfunnel rides along as a dependency)", DIM)], ms=2600)
    clear()

    # Beat 7 - "or use the UI": a REAL screenshot of the config web UI on the demo home.
    if ui_shot:
        type_line("# prefer point-and-click? the same config has a web UI:", DIM, prompt=False)
        type_line("toolfunnel --ui")
        snap(500)
        frames.append(image_frame(ui_shot, caption="toolfunnel --ui  ->  http://127.0.0.1:7332  (tools, MCPs, hooks, auth - all live)"))
        durations.append(4000)
        shown.clear()
        snap(80)

    # Beat 8 - "or just ask your AI": the management tools ARE MCP tools.
    type_line("# or skip the files entirely - the manager tools are MCP tools too:", DIM, prompt=False)
    out_line([("", FG)], ms=60)
    out_line([('  "Claude, add my backup script to toolfunnel"', CYAN)], ms=1400)
    out_line([('  "rename the server to acme-tools"', CYAN)], ms=1400)
    out_line([('  "attach the github MCP but only expose two of its tools"', CYAN)], ms=1400)
    out_line([('  "package it all up for npm"', CYAN)], ms=1600)
    out_line([("", FG)], ms=60)
    out_line([("  your agent configures the gateway by itself - through the same gate.", DIM)], ms=3000)

    # Beat 9 - the closer + logo.
    clear()
    type_line("# your scripts -> your named, packaged MCP server. zero code, zero deps.", DIM, prompt=False)
    durations[-1] = 2500
    logo = os.path.join(ROOT, "assets", "logo.png")
    if os.path.exists(logo):
        frames.append(image_frame(logo, caption="github.com/Rendeverance/toolfunnel"))
        durations.append(4000)

    frames[0].save(
        OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True,
    )
    total = sum(durations) / 1000.0
    print(f"wrote {OUT}  ({len(frames)} frames, ~{total:.1f}s, {os.path.getsize(OUT)//1024} KB)")


if __name__ == "__main__":
    main()
