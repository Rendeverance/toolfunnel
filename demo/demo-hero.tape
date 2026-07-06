# demo-hero.tape — the README hero GIF (~20s): "your scripts → your own MCP server.
# Zero code, zero dependencies." Render with vhs (https://github.com/charmbracelet/vhs):
#
#   vhs demo/demo-hero.tape                     # local install
#   docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs demo/demo-hero.tape
#
# Run from the REPO ROOT (the commands below use repo-relative paths).

Output demo/toolfunnel-demo.gif

Set Shell bash
Set FontSize 16
Set Width 1080
Set Height 640
Set TypingSpeed 35ms
Set Theme "Dracula"

Type "# 3 ordinary scripts, 3 languages — no SDK, no framework:"
Enter
Sleep 800ms
Type "ls demo/home/tools/scripts/"
Enter
Sleep 2.5s

Type "# each one is a JSON entry in a register. That's the whole 'server':"
Enter
Sleep 800ms
Type "node demo/client.js"
Enter
Sleep 7s

Type "# zero code written. zero dependencies installed."
Enter
Sleep 3s
