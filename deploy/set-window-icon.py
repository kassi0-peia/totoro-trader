#!/usr/bin/env python3
"""Set a window's _NET_WM_ICON from a PNG so the taskbar/alt-tab shows the totoro
art (Opus 4.7's drawing) instead of the generic Firefox icon.

Usage: set-window-icon.py <window-id hex|dec> <png-path>
"""
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
from Xlib import X, display


def icon_data(png, size=64):
    pb = GdkPixbuf.Pixbuf.new_from_file(png)
    pb = pb.scale_simple(size, size, GdkPixbuf.InterpType.BILINEAR)
    if not pb.get_has_alpha():
        pb = pb.add_alpha(False, 0, 0, 0)
    px, stride, nch = pb.get_pixels(), pb.get_rowstride(), pb.get_n_channels()
    w, h = pb.get_width(), pb.get_height()
    out = [w, h]  # _NET_WM_ICON = width, height, then ARGB pixels (row-major)
    for y in range(h):
        for x in range(w):
            o = y * stride + x * nch
            r, g, b = px[o], px[o + 1], px[o + 2]
            a = px[o + 3] if nch == 4 else 255
            out.append((a << 24) | (r << 16) | (g << 8) | b)
    return out


def main():
    wid_s, png = sys.argv[1], sys.argv[2]
    wid = int(wid_s, 16) if wid_s.lower().startswith("0x") else int(wid_s)
    d = display.Display()
    win = d.create_resource_object("window", wid)
    win.change_property(
        d.intern_atom("_NET_WM_ICON"),
        d.intern_atom("CARDINAL"),
        32,
        icon_data(png),
        X.PropModeReplace,
    )
    d.sync()


if __name__ == "__main__":
    main()
