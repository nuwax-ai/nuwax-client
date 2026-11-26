/** The UOS 20 desktop recorder's KWayland v2 frame transport. */
export const uosFrameHelper = String.raw`
import ctypes as c
import mmap
import os
import select
import struct
import sys
try:
    from gi.repository import Gio, GLib
except ImportError:
    sys.exit(2)

SESSION_NAME = 'com.deepin.SessionManager'
SESSION_PATH = '/com/deepin/SessionManager'
PROPERTIES = 'org.freedesktop.DBus.Properties'
locked = False

def lock_changed(_connection, _sender, _path, _interface, _signal, parameters):
    global locked
    interface, changes, invalidated = parameters.unpack()
    if interface == SESSION_NAME and (changes.get('Locked') or 'Locked' in invalidated):
        locked = True

try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    bus.signal_subscribe(SESSION_NAME, PROPERTIES, 'PropertiesChanged', SESSION_PATH,
                         SESSION_NAME, Gio.DBusSignalFlags.NONE, lock_changed)
    context = GLib.MainContext.default()
    session_lock = bus.call_sync(
        SESSION_NAME, SESSION_PATH, PROPERTIES, 'Get',
        GLib.Variant('(ss)', (SESSION_NAME, 'Locked')),
        GLib.VariantType.new('(v)'), Gio.DBusCallFlags.NO_AUTO_START, 1500, None)
    if session_lock.unpack() != (False,):
        sys.exit(4)
except GLib.Error:
    sys.exit(2)

class Message(c.Structure):
    _fields_ = [('name', c.c_char_p), ('signature', c.c_char_p), ('types', c.c_void_p)]

class Interface(c.Structure):
    _fields_ = [('name', c.c_char_p), ('version', c.c_int), ('method_count', c.c_int),
                ('methods', c.POINTER(Message)), ('event_count', c.c_int), ('events', c.POINTER(Message))]

try:
    wl = c.CDLL('libwayland-client.so.0')
    kde = c.CDLL('libKF5WaylandClient.so.5')
    registry_iface = Interface.in_dll(wl, 'wl_registry_interface')
    output_iface = Interface.in_dll(wl, 'wl_output_interface')
    access_iface = Interface.in_dll(kde, 'org_kde_kwin_remote_access_manager_interface')
    buffer_iface = Interface.in_dll(kde, 'org_kde_kwin_remote_buffer_interface')
except (OSError, ValueError):
    sys.exit(2)

def messages(entries, count):
    return [(entries[i].name, entries[i].signature) for i in range(count)]

# The UOS fork adds a frame sequence to gbm_handle. Do not bind upstream KDE v1.
if (access_iface.version != 2 or buffer_iface.version != 1 or access_iface.method_count < 2 or
        messages(access_iface.methods, 2) != [(b'get_buffer', b'ni'), (b'release', b'')] or
        messages(access_iface.events, access_iface.event_count) != [(b'buffer_ready', b'io'), (b'rendersequence', b'i')] or
        messages(buffer_iface.events, buffer_iface.event_count) != [(b'gbm_handle', b'huuuui')] or
        messages(buffer_iface.methods, buffer_iface.method_count) != [(b'release', b'')]):
    sys.exit(2)

ptr, uint, sint = c.c_void_p, c.c_uint32, c.c_int32

def native(name, result, *args):
    fn = getattr(wl, name)
    fn.restype, fn.argtypes = result, args
    return fn

connect = native('wl_display_connect', ptr, c.c_char_p)
disconnect = native('wl_display_disconnect', None, ptr)
roundtrip = native('wl_display_roundtrip', sint, ptr)
get_fd = native('wl_display_get_fd', sint, ptr)
dispatch = native('wl_display_dispatch', sint, ptr)
flush = native('wl_display_flush', sint, ptr)
construct = native('wl_proxy_marshal_constructor', ptr, ptr, uint, c.POINTER(Interface))
bind_version = native('wl_proxy_marshal_constructor_versioned', ptr, ptr, uint, c.POINTER(Interface), uint)
marshal = native('wl_proxy_marshal', None, ptr, uint)
destroy = native('wl_proxy_destroy', None, ptr)
listen = native('wl_proxy_add_listener', sint, ptr, c.POINTER(ptr), ptr)

display = connect(None)
if not display:
    sys.exit(2)
registry = construct(display, 1, c.byref(registry_iface), ptr())
outputs = set()
manager_name = None
manager_version = 0
manager = None
output = None
requested = False
buffer_pending = False
frame = None
failed = False

def callbacks(*functions):
    return (ptr * len(functions))(*(c.cast(fn, ptr) for fn in functions))

@c.CFUNCTYPE(None, ptr, ptr, uint, c.c_char_p, uint)
def added(_, __, name, interface, version):
    global manager_name, manager_version, failed
    if interface == b'wl_output':
        outputs.add(name)
        if manager:
            failed = True
    if interface == access_iface.name:
        manager_name, manager_version = name, version

@c.CFUNCTYPE(None, ptr, ptr, uint)
def removed(_, __, name):
    global failed
    if name in outputs or name == manager_name:
        failed = True

@c.CFUNCTYPE(None, ptr, ptr, sint, uint, uint, uint, uint, sint)
def handle(copy_frame, buffer, fd, width, height, stride, pixel_format, _):
    global requested, buffer_pending, frame, failed
    try:
        if not copy_frame:
            return
        row_bytes = width * 4
        fourcc = struct.pack('<I', pixel_format)
        if (width < 1 or height < 1 or width > 8192 or height > 8192 or
                stride < row_bytes or stride * height > 64 * 1024 * 1024 or
                fourcc not in (b'XR24', b'AR24', b'XB24', b'AB24')):
            failed = True
            return
        with mmap.mmap(fd, stride * height, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ) as pixels:
            if stride == row_bytes:
                data = pixels[:]
            else:
                data = b''.join(pixels[y * stride:y * stride + row_bytes] for y in range(height))
        frame = (struct.pack('<III', width, height, pixel_format), data)
    except (ValueError, OSError):
        failed = True
    finally:
        os.close(fd)
        marshal(buffer, 0)
        destroy(buffer)
        if copy_frame:
            requested = buffer_pending = False

buffer_callbacks = callbacks(handle)

@c.CFUNCTYPE(None, ptr, ptr, sint, ptr)
def ready(_, proxy, buffer_id, source):
    global buffer_pending
    copy_frame = requested and not buffer_pending and source == output
    if copy_frame:
        buffer_pending = True
    # Every announcement owns a server-side reference, even while paused.
    buffer = construct(proxy, 0, c.byref(buffer_iface), ptr(), sint(buffer_id))
    listen(buffer, buffer_callbacks, ptr(int(copy_frame)))

@c.CFUNCTYPE(None, ptr, ptr, sint)
def render_sequence(_, __, ___):
    pass

registry_callbacks = callbacks(added, removed)
manager_callbacks = callbacks(ready, render_sequence)

try:
    listen(registry, registry_callbacks, None)
    if roundtrip(display) < 0 or len(outputs) != 1 or manager_version != 2:
        sys.exit(2)
    # With one output we can match physical pixels to the screen unambiguously.
    name = next(iter(outputs))
    output = bind_version(registry, 0, c.byref(output_iface), 1, uint(name), output_iface.name, uint(1), ptr())
    manager = bind_version(registry, 0, c.byref(access_iface), 2, uint(manager_name), access_iface.name, uint(2), ptr())
    listen(manager, manager_callbacks, None)
    if roundtrip(display) < 0 or failed:
        sys.exit(2)
    connection = get_fd(display)
    while not failed:
        reads, _, _ = select.select([0, connection], [connection] if flush(display) < 0 else [], [], 0.05)
        while context.pending():
            context.iteration(False)
        if locked or bus.is_closed():
            sys.exit(4)
        if failed:
            break
        if connection in reads and dispatch(display) < 0:
            break
        if 0 in reads:
            command = os.read(0, 1)
            if command != b'F':
                break
            requested = True
        if frame is not None:
            flush(display)
            for block in frame:
                sys.stdout.buffer.write(block)
            frame = None
    sys.exit(3 if failed else 0)
finally:
    if manager:
        marshal(manager, 1)
        flush(display)
    disconnect(display)
`;
