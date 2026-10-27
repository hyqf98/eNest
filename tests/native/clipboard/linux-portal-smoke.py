#!/usr/bin/env python3
"""Exercise the Linux helper against a private fake portal, never a real desktop."""
import json
import os
import select
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def serve():
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib
    DBusGMainLoop(set_as_default=True)
    connection = dbus.SessionBus()
    name = dbus.service.BusName('org.freedesktop.portal.Desktop', connection)
    documents_name = dbus.service.BusName('org.freedesktop.portal.Documents', connection)
    request_iface = 'org.freedesktop.portal.Request'
    session_iface = 'org.freedesktop.portal.Session'
    remote_iface = 'org.freedesktop.portal.RemoteDesktop'
    clipboard_iface = 'org.freedesktop.portal.Clipboard'
    active_objects = []

    class Documents(dbus.service.Object):
        @dbus.service.method('org.freedesktop.portal.FileTransfer', in_signature='sa{sv}', out_signature='as')
        def RetrieveFiles(self, key, options):
            assert key == 'enest-test-transfer-key'
            return [os.environ['ENEST_PORTAL_TEST_FILE']]

    class Request(dbus.service.Object):
        @dbus.service.signal(request_iface, signature='ua{sv}')
        def Response(self, code, result):
            pass

        @dbus.service.method(request_iface, in_signature='', out_signature='')
        def Close(self):
            pass

    class Session(dbus.service.Object):
        @dbus.service.signal(session_iface, signature='a{sv}')
        def Closed(self, details):
            pass

        @dbus.service.method(session_iface, in_signature='', out_signature='')
        def Close(self):
            self.Closed({})

    class Portal(dbus.service.Object):
        def __init__(self):
            super().__init__(name, '/org/freedesktop/portal/desktop')
            self.session = None
            self.written = b''
            self.done = False
            self.requested = False
            self.scenario = os.environ.get('ENEST_PORTAL_SCENARIO', 'success')

        def response(self, sender, token, result, code=0):
            path = '/org/freedesktop/portal/desktop/request/' + sender[1:].replace('.', '_') + '/' + str(token)
            request = Request(name, path)
            active_objects.append(request)
            GLib.idle_add(lambda: request.Response(code, result) or False)
            return dbus.ObjectPath(path)

        @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
        def Get(self, interface, key):
            if key != 'version' or interface not in (clipboard_iface, remote_iface):
                raise dbus.exceptions.DBusException('unknown property')
            return dbus.UInt32(1 if interface == clipboard_iface else 2, variant_level=1)

        @dbus.service.method(remote_iface, in_signature='a{sv}', out_signature='o', sender_keyword='sender')
        def CreateSession(self, options, sender):
            path = '/org/freedesktop/portal/desktop/session/' + sender[1:].replace('.', '_') + '/' + str(options['session_handle_token'])
            self.session = Session(name, path)
            active_objects.append(self.session)
            return self.response(sender, options['handle_token'], {'session_handle': path})

        @dbus.service.method(remote_iface, in_signature='oa{sv}', out_signature='o', sender_keyword='sender')
        def SelectDevices(self, session, options, sender):
            assert int(options['types']) == 0, 'clipboard permission must not request keyboard/pointer control'
            if self.scenario == 'unsupported':
                raise dbus.exceptions.DBusException('clipboard-only sessions are not supported')
            return self.response(sender, options['handle_token'], {})

        @dbus.service.method(clipboard_iface, in_signature='oa{sv}', out_signature='')
        def RequestClipboard(self, session, options):
            self.requested = True

        @dbus.service.method(remote_iface, in_signature='osa{sv}', out_signature='o', sender_keyword='sender')
        def Start(self, session, parent, options, sender):
            assert self.requested
            if self.scenario in ('cancelled', 'denied'):
                return self.response(sender, options['handle_token'], {}, 1 if self.scenario == 'cancelled' else 2)
            response = self.response(sender, options['handle_token'], {'clipboard_enabled': dbus.Boolean(self.scenario != 'disabled'), 'devices': dbus.UInt32(0)})
            mime = 'application/vnd.portal.filetransfer' if self.scenario == 'filetransfer' else 'text/uri-list'
            GLib.timeout_add(40, lambda: self.SelectionOwnerChanged(session, {'mime_types': dbus.Array([mime], signature='s'), 'session_is_owner': dbus.Boolean(False)}) or False)
            return response

        @dbus.service.signal(clipboard_iface, signature='oa{sv}')
        def SelectionOwnerChanged(self, session, options):
            pass

        @dbus.service.signal(clipboard_iface, signature='osu')
        def SelectionTransfer(self, session, mime, serial):
            pass

        @dbus.service.method(clipboard_iface, in_signature='os', out_signature='h')
        def SelectionRead(self, session, mime):
            expected = 'application/vnd.portal.filetransfer' if self.scenario == 'filetransfer' else 'text/uri-list'
            assert mime == expected
            read, write = os.pipe()
            payload = 'enest-test-transfer-key' if self.scenario == 'filetransfer' else Path(os.environ['ENEST_PORTAL_TEST_FILE']).as_uri() + '\r\n'
            os.write(write, payload.encode())
            os.close(write)
            value = dbus.types.UnixFd(read)
            os.close(read)
            return value

        @dbus.service.method(clipboard_iface, in_signature='oa{sv}', out_signature='')
        def SetSelection(self, session, options):
            assert 'text/uri-list' in options['mime_types']
            GLib.idle_add(lambda: self.SelectionTransfer(session, 'text/uri-list', dbus.UInt32(7)) or False)

        @dbus.service.method(clipboard_iface, in_signature='ou', out_signature='h')
        def SelectionWrite(self, session, serial):
            assert int(serial) == 7
            read, write = os.pipe()
            def receive():
                chunks = []
                while True:
                    data = os.read(read, 8192)
                    if not data:
                        break
                    chunks.append(data)
                os.close(read)
                self.written = b''.join(chunks)
            threading.Thread(target=receive, daemon=True).start()
            value = dbus.types.UnixFd(write)
            os.close(write)
            return value

        @dbus.service.method(clipboard_iface, in_signature='oub', out_signature='')
        def SelectionWriteDone(self, session, serial, success):
            self.done = bool(success)

        @dbus.service.method('org.enest.TestPortal', in_signature='', out_signature='sb')
        def GetWritten(self):
            return self.written.decode(), self.done

        @dbus.service.method('org.enest.TestPortal', in_signature='', out_signature='')
        def Revoke(self):
            self.session.Closed({})

    portal = Portal()
    documents = Documents(documents_name, '/org/freedesktop/portal/documents')
    print('ready', flush=True)
    GLib.MainLoop().run()


def verify(binary, scenario='success'):
    import dbus
    with tempfile.TemporaryDirectory(prefix='enest-portal-') as directory:
        path = Path(directory) / '颜色 file #1.txt'
        path.touch()
        server = subprocess.Popen([sys.executable, __file__, '--server'], env={**os.environ, 'ENEST_PORTAL_TEST_FILE': str(path), 'ENEST_PORTAL_SCENARIO': scenario}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert select.select([server.stdout], [], [], 5)[0], 'fixture portal did not start'
        assert server.stdout.readline().strip() == 'ready', server.stderr.read()
        helper = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, 'WAYLAND_DISPLAY': 'wayland-test', 'XDG_SESSION_TYPE': 'wayland'})
        try:
            sequence = 0
            def call(command, **values):
                nonlocal sequence
                sequence += 1
                helper.stdin.write(json.dumps(dict(id=sequence, command=command, **values)) + '\n')
                helper.stdin.flush()
                assert select.select([helper.stdout], [], [], 5)[0], 'helper timed out'
                response = json.loads(helper.stdout.readline())
                assert response['id'] == sequence and 'error' not in response, response
                return response['result']
            before = call('capabilities')
            assert before['permissionRequired'] is True and before['files'] is False and before['paste'] is False, before
            after = call('requestPermission')
            if scenario not in ('success', 'filetransfer'):
                assert after['files'] is False and after['permissionRequired'] is True and after['paste'] is False and after['reason'], after
                if scenario == 'cancelled':
                    assert '取消' in after['reason'], after
                if scenario == 'denied':
                    assert '拒绝' in after['reason'], after
                assert call('readFiles') == [] and call('target') is None
                helper.stdin.close()
                helper.wait(timeout=3)
                errors = helper.stderr.read()
                assert helper.returncode == 0 and 'CRITICAL' not in errors, errors
                print('PASS: private portal graceful fallback:', scenario)
                return
            assert after['files'] is True and after['permissionRequired'] is False and after['paste'] is False, after
            assert call('source') is None and call('target') is None
            time.sleep(.08)
            assert call('readFiles') == [str(path)]
            assert call('writeFiles', paths=[str(path)]) is True
            proxy = dbus.SessionBus().get_object('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
            for _ in range(40):
                data, done = proxy.GetWritten(dbus_interface='org.enest.TestPortal')
                if done:
                    break
                time.sleep(.03)
            assert done and data.strip() == path.as_uri(), (data, done)
            assert call('paste', target='not-a-wayland-window')['pasted'] is False
            proxy.Revoke(dbus_interface='org.enest.TestPortal')
            time.sleep(.08)
            revoked = call('capabilities')
            assert revoked['files'] is False and revoked['permissionRequired'] is True
            helper.stdin.close()
            helper.wait(timeout=3)
            errors = helper.stderr.read()
            assert helper.returncode == 0 and 'CRITICAL' not in errors, errors
            print('PASS: private D-Bus portal CreateSession / clipboard-only SelectDevices / RequestClipboard / Start, FD read/write, permission revocation, safe Wayland paste refusal:', scenario)
        finally:
            if helper.poll() is None:
                helper.terminate()
                helper.wait(timeout=3)
            server.terminate()
            server.wait(timeout=3)


if __name__ == '__main__':
    if sys.argv[1] == '--server':
        serve()
    else:
        for scenario in ('success', 'filetransfer', 'cancelled', 'denied', 'disabled', 'unsupported'):
            verify(sys.argv[1], scenario)
