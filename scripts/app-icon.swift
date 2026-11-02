// Package the original Stellar mark, not the wordmark's cropped rounded tile.
// A full-bleed opaque canvas lets macOS apply its own icon mask only once.
// Run: swift scripts/app-icon.swift
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let input = root.appendingPathComponent("assets/stellar-vpn-logo.png")
let output = root.appendingPathComponent("assets/app-icon.png")
guard let original = NSImage(contentsOf: input),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
      ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot load the original Stellar logo or create the icon canvas")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
// The source carries Retina DPI metadata; crop in pixel coordinates, not points.
original.size = NSSize(width: 482, height: 128)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
context.imageInterpolation = .high
original.draw(
    in: NSRect(x: 0, y: 0, width: 1024, height: 1024),
    from: NSRect(x: 0, y: 0, width: 128, height: 128),
    operation: .sourceOver, fraction: 1
)
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode the app icon")
}
try png.write(to: output)

// Native menu-bar template: retain the original mark's alpha silhouette.
// White tile pixels become transparent; macOS supplies light/dark coloring.
let template = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 32,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 128, bitsPerPixel: 32)!
for y in 0..<32 {
    for x in 0..<32 {
        let color = bitmap.colorAt(x: x * 32 + 16, y: y * 32 + 16)!.usingColorSpace(.deviceRGB)!
        let alpha = min(1, max(0, (color.blueComponent - color.redComponent) / 0.8))
        template.setColor(NSColor(deviceRed: 0, green: 0, blue: 0, alpha: alpha), atX: x, y: y)
    }
}
let trayPath = root.appendingPathComponent("src-tauri/icons/tray.rgba")
try Data(bytes: template.bitmapData!, count: 32 * 32 * 4).write(to: trayPath)
