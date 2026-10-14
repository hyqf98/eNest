#!/usr/bin/env python3
"""Linux-only protocol/Xvfb regression checks; not a real-desktop acceptance test."""
import json
import os
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from Xlib import X, XK, display
from Xlib.ext import xtest


class Helper:
    def __init__(self, binary, **environment):
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, **environment}, text=True, bufsize=1)
        self.sequence = 0

    def raw(self, value, timeout=4):
        self.process.stdin.write(value + '\n')
        self.process.stdin.flush()
        readable, _, _ = select.select([self.process.stdout], [], [], timeout)
        assert readable, 'helper timed out'
        line = self.process.stdout.readline()
        assert line, self.process.stderr.read()
        return json.loads(line)

    def call(self, command, **values):
        self.sequence += 1
        response = self.raw(json.dumps(dict(id=self.sequence, command=command, **values)))
        assert response['id'] == self.sequence, response
        assert 'error' not in response, response
        return response['result']

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=3)
        errors = self.process.stderr.read()
        assert self.process.returncode == 0, errors
        assert 'CRITICAL' not in errors, errors


def main(binary):
    x = display.Display()
    screen = x.screen()
    root = screen.root
    wm_pid = x.intern_atom('_NET_WM_PID')
    active = x.intern_atom('_NET_ACTIVE_WINDOW')
    clipboard = x.intern_atom('CLIPBOARD')
    window = root.create_window(0, 0, 200, 100, 0, screen.root_depth, X.InputOutput, X.CopyFromParent, event_mask=X.KeyPressMask | X.KeyReleaseMask | X.StructureNotifyMask)
    window.set_wm_class('enest-clipboard-test', 'ENestClipboardTest')
    window.change_property(wm_pid, Xatom_CARDINAL := x.intern_atom('CARDINAL'), 32, [os.getpid()])
    window.map()
    root.change_property(active, x.intern_atom('WINDOW'), 32, [window.id])
    window.set_input_focus(X.RevertToParent, X.CurrentTime)
    window.set_selection_owner(clipboard, X.CurrentTime)
    x.sync()
    reader = Helper(binary, XDG_SESSION_TYPE='x11', WAYLAND_DISPLAY='')
    writer = Helper(binary, XDG_SESSION_TYPE='x11', WAYLAND_DISPLAY='')
    assert reader.call('capabilities') == dict(files=True, sourceApp=True, paste=True, permissionRequired=False)
    source = reader.call('source')
    assert source['name'] == 'ENestClipboardTest' and source['evidence'] == 'owner', source
    captured = reader.call('target')
    assert captured['name'] == 'ENestClipboardTest' and captured['token']
    assert reader.call('paste', target='invented-target')['pasted'] is False
    assert reader.call('paste', target=captured['token'])['pasted'] is True
    time.sleep(.04)
    x.sync()
    events = []
    while x.pending_events():
        event = x.next_event()
        if event.type in (X.KeyPress, X.KeyRelease):
            events.append(event)
    key = x.keysym_to_keycode(XK.string_to_keysym('v'))
    assert any(event.type == X.KeyPress and event.detail == key and event.state & X.ControlMask for event in events), 'no Ctrl+V reached the exact target'
    assert any(event.type == X.KeyRelease and event.detail == key for event in events), 'V was not released'
    control = x.keysym_to_keycode(XK.string_to_keysym('Control_L'))
    xtest.fake_input(x, X.KeyPress, control)
    x.sync()
    assert reader.call('paste', target=captured['token'])['pasted'] is False, 'must not alter physically held modifier'
    xtest.fake_input(x, X.KeyRelease, control)
    x.sync()
    # Xvfb has no window manager: an activation request must not steal focus.
    other = root.create_window(220, 0, 100, 100, 0, screen.root_depth, X.InputOutput, X.CopyFromParent)
    other.map()
    other.set_input_focus(X.RevertToParent, X.CurrentTime)
    x.sync()
    assert reader.call('paste', target=captured['token'])['pasted'] is False
    assert x.get_input_focus().focus.id == other.id, 'helper must not force keyboard focus'
    window.set_input_focus(X.RevertToParent, X.CurrentTime)
    other.destroy()
    x.sync()
    # No clipboard owner means unknown source even while a known app is focused.
    root.set_selection_owner(clipboard, X.CurrentTime)
    x.sync()
    assert reader.call('source') is None
    with tempfile.TemporaryDirectory(prefix='enest-clipboard-') as directory:
        paths = []
        for index in range(700):
            path = Path(directory) / f'颜色 test # {index:04d} ' / 'a long file name with spaces.txt'
            path.parent.mkdir()
            path.touch()
            paths.append(str(path))
        small = paths[:3]
        assert writer.call('writeFiles', paths=small) is True
        assert reader.call('readFiles') == small
        # INCR transfers are required for a file list above the single chunk size.
        assert writer.call('writeFiles', paths=paths) is True
        assert reader.call('readFiles') == paths
        bad = writer.raw(json.dumps(dict(id=9900, command='writeFiles', paths=['relative/file'])))
        assert 'error' in bad
    # WM identity mutation and destruction both invalidate the opaque capture token.
    window.set_wm_class('different', 'DifferentApp')
    x.sync()
    assert reader.call('paste', target=captured['token'])['pasted'] is False
    window.set_wm_class('enest-clipboard-test', 'ENestClipboardTest')
    x.sync()
    destroyed = reader.call('target')
    window.destroy()
    x.sync()
    assert reader.call('paste', target=destroyed['token'])['pasted'] is False
    assert 'error' in reader.raw('{broken')
    assert 'error' in reader.raw(json.dumps(dict(id=9901, command='exec', argv=['anything'])))
    assert 'error' in reader.raw('x' * (1024 * 1024 + 1)), 'oversized request must fail without crashing'
    assert reader.call('capabilities')['paste'] is True, 'invalid input must not terminate helper'
    reader.close()
    writer.close()
    wayland = Helper(binary, WAYLAND_DISPLAY='wayland-test', XDG_SESSION_TYPE='wayland', DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent/enest-test')
    capability = wayland.call('capabilities')
    assert capability['paste'] is False and capability['sourceApp'] is False
    assert wayland.call('target') is None and wayland.call('source') is None
    assert wayland.call('paste', target=captured['token'])['pasted'] is False
    assert wayland.call('readFiles') == []
    assert wayland.call('requestPermission')['permissionRequired'] is False
    wayland.close()
    x.close()
    print('PASS: Xvfb JSON protocol, known clipboard owner, opaque exact-window target, XTest Ctrl+V, held-modifier refusal, small/INCR URI file transfer, target mutation/destruction, Wayland fail-closed fallback')


if __name__ == '__main__':
    main(sys.argv[1])
