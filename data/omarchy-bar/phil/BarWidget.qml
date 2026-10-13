import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

// phil's copies, moves and deletes that have taken more than 10 seconds:
// "󰆏 Top Gear 45%" with a thin bar under it, the first one's ("+2": more of
// them); the tooltip lists them all. A click opens where the first one goes
// in phil. From what phil writes ($XDG_RUNTIME_DIR/phil/progress.json, see
// apps/phil/server.js): nothing shows when that's more than 15 s old (phil
// writes it every 5 s while anything's under way).
BarWidget {
  id: root
  moduleName: "phil"

  property var progress: null
  property real now: Date.now()
  readonly property var jobs: progress && now - (progress.updated || 0) < 15000
    ? (progress.jobs || []).filter(j => now - j.started >= 10000) : []
  readonly property var first: jobs.length ? jobs[0] : null

  visible: first !== null
  implicitWidth: first ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  FileView {
    id: file
    path: Quickshell.env("XDG_RUNTIME_DIR") + "/phil/progress.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        root.progress = JSON.parse(text())
      } catch (e) {
        root.progress = null
      }
      root.now = Date.now()
    }
    onLoadFailed: root.progress = null
  }

  // A job passes 10 seconds, or phil stops writing (gone), with nothing new in the file.
  Timer {
    interval: 1000
    running: true
    repeat: true
    onTriggered: {
      root.now = Date.now()
      if (root.progress === null) file.reload()
    }
  }

  function size(n) {
    const units = ["B", "KB", "MB", "GB", "TB"]
    let i = 0
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
    return (i && n < 10 ? n.toFixed(1) : Math.round(n)) + " " + units[i]
  }
  function icon(j) {
    return j.op === "delete" ? "󰆴" : j.op === "move" ? "󰪹" : "󰆏"
  }
  function short(name) {
    return name.length > 22 ? name.slice(0, 21) + "…" : name
  }
  function what(j) {
    return j.items > 1 ? "“" + j.name + "” and " + (j.items - 1) + " more" : "“" + j.name + "”"
  }
  function line(j) {
    const verb = j.op === "delete" ? "Deleting" : j.op === "move" ? "Moving" : "Copying"
    const where = j.op === "delete" ? "" : " to " + (j.dest.split("/").pop() || "/")
    if (j.counting) return verb + " " + what(j) + ": counting (" + j.found.toLocaleString() + " so far)"
    const amount = j.op === "delete" ? j.bytes.toLocaleString() + " of " + j.total.toLocaleString() + " items"
      : size(j.bytes) + " of " + size(j.total)
    return verb + " " + what(j) + where + ": " + (j.paused ? "paused at " : "") + j.percent + "% (" + amount
      + (j.speed && !j.paused ? ", " + j.speed + ", " + j.eta + " left" : "") + ")"
  }
  function quote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.first
      ? root.icon(root.first) + " " + root.short(root.first.name) + " "
        + (root.first.counting ? "…" : (root.first.paused ? "󰏤 " : "") + root.first.percent + "%")
        + (root.jobs.length > 1 ? "  +" + (root.jobs.length - 1) : "")
      : ""
    tooltipText: root.jobs.map(root.line).join("\n") + (root.first ? "\nClick: open in phil" : "")
    onPressed: function(b) {
      if (b === Qt.LeftButton && root.first && root.bar) root.bar.run("phil " + root.quote(root.first.dest))
    }
  }

  // The first one's progress, under its text.
  Rectangle {
    id: track
    visible: root.first !== null && !root.first.counting
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 3
    anchors.horizontalCenter: parent.horizontalCenter
    width: Math.max(0, button.width - button.scaledHorizontalMargin * 2)
    height: 2
    radius: 1
    color: button.foreground
    opacity: 0.25
  }
  Rectangle {
    visible: track.visible
    anchors.left: track.left
    anchors.verticalCenter: track.verticalCenter
    width: track.width * (root.first ? Math.min(100, root.first.percent) : 0) / 100
    height: 2
    radius: 1
    color: button.foreground
    opacity: root.first && root.first.paused ? 0.5 : 1
    Behavior on width { NumberAnimation { duration: 300 } }
  }
}
