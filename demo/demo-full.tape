# demo-full.tape — the full mp4 (~60s): the hero story PLUS the register close-up and the
# gate beat (a server-side DENIED call — the differentiator). Render with vhs:
#
#   vhs demo/demo-full.tape
#   docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs demo/demo-full.tape
#
# Run from the REPO ROOT.

Output demo/toolfunnel-demo.mp4

Set Shell bash
Set FontSize 16
Set Width 1080
Set Height 720
Set TypingSpeed 35ms
Set Theme "Dracula"

Type "# 3 ordinary scripts, 3 languages — no SDK, no framework:"
Enter
Sleep 800ms
Type "ls demo/home/tools/scripts/"
Enter
Sleep 3s

Type "# a tool = ONE JSON entry: name, schema, how to run it."
Enter
Sleep 800ms
Type "head -21 demo/home/tools/tools.register.json"
Enter
Sleep 5s

Type "# promote them hot + hide the plumbing — config, not code:"
Enter
Sleep 800ms
Type "cat demo/home/tools/tools.state.json"
Enter
Sleep 4s

Type "# now talk to it like any MCP client would — plus the DESTRUCTIVE tool:"
Enter
Sleep 800ms
Type "node demo/client.js --denied"
Enter
Sleep 9s

Type "# the deny is a policy HOOK inside the server — it travels with the pack,"
Enter
Type "# and holds on ANY client. Zero code. Zero dependencies."
Enter
Sleep 4s
