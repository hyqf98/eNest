/* eNest clipboard helper: fixed JSON-line operations, never arbitrary commands.
 * X11: selection MIME transfer + exact-window targeting + XTest paste.
 * Wayland: optional, consented Clipboard portal session; no unsafe Xwayland
 * or blind global-key fallback when the original native window is unknown.
 */
#define _POSIX_C_SOURCE 200809L
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_BYTES (1024 * 1024)
#define MAX_FILES 1000
#define TRANSFER_CHUNK 32768
#define PORTAL_BUS "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define CLIP_IFACE "org.freedesktop.portal.Clipboard"
#define REMOTE_IFACE "org.freedesktop.portal.RemoteDesktop"

static GMainLoop *main_loop;
static Display *display;
static Window selection_window;
static gboolean wayland, xtest_available, x_error;
static Atom clipboard_atom, uri_atom, gnome_atom, targets_atom, incr_atom, property_atom;
static GDBusConnection *bus;
static gchar *portal_session, *portal_reason;
static gboolean portal_available, portal_clipboard, portal_owns;
static gchar **portal_mimes;
static GHashTable *targets;
static GPtrArray *owned_paths;
static gchar *owned_uris, *owned_gnome;
static GString *input_buffer;
static gboolean discard_input;

typedef struct { Window window; guint64 pid; gchar *started; gchar *name; gint64 captured; } Target;
typedef struct { Window requestor; Atom property, type; gchar *data; gsize length, offset; gint64 deadline; } OutTransfer;
static GPtrArray *transfers;
typedef struct { gboolean done, incremental, failed; Atom target; GByteArray *bytes; } ReadTransfer;
static ReadTransfer *incoming;

static gint64 now_ms(void) { return g_get_monotonic_time() / 1000; }
static JsonNode *node_null(void) { return json_node_new(JSON_NODE_NULL); }
static JsonNode *node_bool(gboolean value) { JsonNode *node = json_node_new(JSON_NODE_VALUE); json_node_set_boolean(node, value); return node; }
static JsonNode *object_node(JsonObject *object) { JsonNode *node = json_node_new(JSON_NODE_OBJECT); json_node_take_object(node, object); return node; }
static JsonNode *array_node(JsonArray *array) { JsonNode *node = json_node_new(JSON_NODE_ARRAY); json_node_take_array(node, array); return node; }
static const gchar *string_member(JsonObject *object, const gchar *key) {
  JsonNode *node = json_object_get_member(object, key);
  return node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
}
static JsonNode *paste_result(gboolean pasted, const gchar *reason) {
  JsonObject *object = json_object_new(); json_object_set_boolean_member(object, "pasted", pasted);
  if (reason) json_object_set_string_member(object, "reason", reason);
  return object_node(object);
}
static int on_x_error(Display *d, XErrorEvent *event) { (void)d; (void)event; x_error = TRUE; return 0; }
static void target_free(gpointer value) { Target *target = value; g_free(target->started); g_free(target->name); g_free(target); }
static void transfer_free(gpointer value) { OutTransfer *transfer = value; g_free(transfer->data); g_free(transfer); }
static void clear_owned(void) { g_clear_pointer(&owned_paths, g_ptr_array_unref); g_clear_pointer(&owned_uris, g_free); g_clear_pointer(&owned_gnome, g_free); }

/* Every returned identity is tied to a real selection owner or active window. */
static gboolean cardinal(Window window, Atom property, guint64 *value) {
  Atom actual; int format; unsigned long length, remaining; unsigned char *data = NULL;
  x_error = FALSE;
  int result = XGetWindowProperty(display, window, property, 0, 1, False, XA_CARDINAL, &actual, &format, &length, &remaining, &data);
  XSync(display, False);
  gboolean ok = !x_error && result == Success && actual == XA_CARDINAL && format == 32 && length == 1;
  if (ok) *value = *(unsigned long *)data;
  if (data) XFree(data);
  return ok;
}
static Window window_property(Window window, const gchar *name) {
  Atom actual; int format; unsigned long length, remaining; unsigned char *data = NULL;
  x_error = FALSE;
  int result = XGetWindowProperty(display, window, XInternAtom(display, name, False), 0, 1, False, XA_WINDOW, &actual, &format, &length, &remaining, &data);
  XSync(display, False);
  Window value = !x_error && result == Success && actual == XA_WINDOW && format == 32 && length ? *(Window *)data : None;
  if (data) XFree(data);
  return value;
}
static gchar *window_class(Window window) {
  XClassHint hint = {0}; x_error = FALSE;
  gboolean ok = XGetClassHint(display, window, &hint); XSync(display, False);
  gchar *name = ok && !x_error ? g_strdup(hint.res_class ? hint.res_class : hint.res_name) : NULL;
  if (hint.res_name) XFree(hint.res_name);
  if (hint.res_class) XFree(hint.res_class);
  if (name && !g_utf8_validate(name, -1, NULL)) g_clear_pointer(&name, g_free);
  return name;
}
static Window parent_window(Window window) {
  Window root, parent, *children = NULL; unsigned int count; x_error = FALSE;
  gboolean ok = XQueryTree(display, window, &root, &parent, &children, &count); XSync(display, False);
  if (children) XFree(children);
  return ok && !x_error ? parent : None;
}
static Window client_with_pid(Window window, guint64 *pid) {
  Atom property = XInternAtom(display, "_NET_WM_PID", False);
  for (int depth = 0; window && window != DefaultRootWindow(display) && depth < 32; depth++) {
    if (cardinal(window, property, pid) && *pid > 0) return window;
    Window parent = parent_window(window); if (parent == window) break; window = parent;
  }
  return None;
}
static gchar *process_start(guint64 pid) {
  if (!pid || pid > G_MAXINT32) return NULL;
  gchar *path = g_strdup_printf("/proc/%" G_GUINT64_FORMAT "/stat", pid), *data = NULL;
  gsize length = 0; gboolean ok = g_file_get_contents(path, &data, &length, NULL); g_free(path);
  if (!ok || length > 16384) { g_free(data); return NULL; }
  gchar *end = strrchr(data, ')'), *result = NULL;
  if (end && end[1] == ' ') {
    gchar **fields = g_strsplit(end + 2, " ", 0);
    if (g_strv_length(fields) > 19 && fields[19][0] && strspn(fields[19], "0123456789") == strlen(fields[19])) result = g_strdup(fields[19]);
    g_strfreev(fields);
  }
  g_free(data); return result;
}
static Window active_window(void) {
  Window active = window_property(DefaultRootWindow(display), "_NET_ACTIVE_WINDOW");
  if (!active) { int revert; XGetInputFocus(display, &active, &revert); if (active == PointerRoot) active = None; }
  return active;
}
static gboolean descendant_of(Window window, Window ancestor) {
  for (int depth = 0; window && window != PointerRoot && depth < 32; depth++) {
    if (window == ancestor) return TRUE;
    if (window == DefaultRootWindow(display)) return FALSE;
    Window parent = parent_window(window); if (parent == window) break; window = parent;
  }
  return FALSE;
}
static gboolean has_focus(Window window) {
  Window focus; int revert; XGetInputFocus(display, &focus, &revert);
  Window active = window_property(DefaultRootWindow(display), "_NET_ACTIVE_WINDOW");
  return (!active || active == window) && descendant_of(focus, window);
}
static gboolean target_valid(Target *target) {
  if (!target || now_ms() - target->captured > 30 * 60 * 1000) return FALSE;
  guint64 pid = 0;
  if (!cardinal(target->window, XInternAtom(display, "_NET_WM_PID", False), &pid) || pid != target->pid) return FALSE;
  gchar *start = process_start(pid), *name = window_class(target->window);
  gboolean valid = start && name && g_str_equal(start, target->started) && g_str_equal(name, target->name);
  g_free(start); g_free(name); return valid;
}
static JsonNode *capture_target(void) {
  if (wayland || !display) return node_null();
  guint64 pid = 0; Window window = client_with_pid(active_window(), &pid);
  if (!window || window == selection_window) return node_null();
  gchar *name = window_class(window), *started = process_start(pid);
  if (!name || !started || g_ascii_strcasecmp(name, "enest") == 0 || g_ascii_strcasecmp(name, "electron") == 0) { g_free(name); g_free(started); return node_null(); }
  Target *target = g_new0(Target, 1); target->window = window; target->pid = pid; target->name = name; target->started = started; target->captured = now_ms();
  XWindowAttributes attrs; x_error = FALSE;
  if (!XGetWindowAttributes(display, window, &attrs)) { target_free(target); return node_null(); }
  XSelectInput(display, window, attrs.your_event_mask | StructureNotifyMask); XSync(display, False);
  if (x_error) { target_free(target); return node_null(); }
  if (g_hash_table_size(targets) >= 16) g_hash_table_remove_all(targets);
  gchar *token = g_uuid_string_random(); g_hash_table_insert(targets, g_strdup(token), target);
  JsonObject *object = json_object_new(); json_object_set_string_member(object, "token", token); json_object_set_string_member(object, "name", name); g_free(token);
  return object_node(object);
}
static JsonNode *source_app(void) {
  if (wayland || !display) return node_null();
  Window owner = XGetSelectionOwner(display, clipboard_atom);
  if (!owner || owner == selection_window) return node_null();
  guint64 pid = 0; Window client = client_with_pid(owner, &pid);
  if (!client) return node_null();
  gchar *name = window_class(client); if (!name || !*name) { g_free(name); return node_null(); }
  /* Recheck ownership: a focus change is never evidence of clipboard ownership. */
  if (XGetSelectionOwner(display, clipboard_atom) != owner) { g_free(name); return node_null(); }
  JsonObject *object = json_object_new(); json_object_set_string_member(object, "name", name); json_object_set_string_member(object, "id", name); json_object_set_string_member(object, "evidence", "owner"); g_free(name);
  return object_node(object);
}

static void x_events(void);
static gboolean modifiers_released(void) {
  char keys[32]; XQueryKeymap(display, keys);
  KeySym symbols[] = { XK_Control_L, XK_Control_R, XK_Shift_L, XK_Shift_R, XK_Alt_L, XK_Alt_R, XK_Super_L, XK_Super_R, XK_Meta_L, XK_Meta_R };
  for (guint i = 0; i < G_N_ELEMENTS(symbols); i++) { KeyCode code = XKeysymToKeycode(display, symbols[i]); if (code && (keys[code / 8] & (1 << (code % 8)))) return FALSE; }
  return TRUE;
}
static gboolean terminal_class(const gchar *name) {
  gchar *lower = g_ascii_strdown(name, -1);
  const gchar *names[] = { "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "wezterm", "terminator", "tilix" };
  gboolean match = FALSE; for (guint i = 0; i < G_N_ELEMENTS(names); i++) if (strstr(lower, names[i])) match = TRUE;
  g_free(lower); return match;
}
static JsonNode *paste_target(const gchar *token) {
  if (wayland) return paste_result(FALSE, "Wayland 未提供通用的原窗口身份与焦点恢复接口；已复制，请手动粘贴");
  if (!display || !xtest_available) return paste_result(FALSE, "当前 X11 会话不支持 XTest 回贴，请手动粘贴");
  x_events();
  Target *target = token ? g_hash_table_lookup(targets, token) : NULL;
  if (!target_valid(target)) return paste_result(FALSE, "原窗口已关闭或身份已变化，请手动粘贴");
  if (!modifiers_released()) return paste_result(FALSE, "请松开修饰键后重试，或手动粘贴");
  Window window = target->window;
  XEvent event = {0}; event.xclient.type = ClientMessage; event.xclient.window = window; event.xclient.message_type = XInternAtom(display, "_NET_ACTIVE_WINDOW", False); event.xclient.format = 32; event.xclient.data.l[0] = 2; event.xclient.data.l[1] = CurrentTime;
  XMapRaised(display, window); XSendEvent(display, DefaultRootWindow(display), False, SubstructureRedirectMask | SubstructureNotifyMask, &event); XFlush(display);
  gint64 deadline = now_ms() + 450;
  while (now_ms() < deadline && !has_focus(window)) { x_events(); g_usleep(5000); }
  target = token ? g_hash_table_lookup(targets, token) : NULL;
  if (!target_valid(target) || !has_focus(window)) return paste_result(FALSE, "窗口管理器未恢复原窗口焦点；已复制，请手动粘贴");
  KeyCode control = XKeysymToKeycode(display, XK_Control_L), key = XKeysymToKeycode(display, XK_v), shift = terminal_class(target->name) ? XKeysymToKeycode(display, XK_Shift_L) : 0;
  if (!control || !key) return paste_result(FALSE, "当前键盘布局无法生成粘贴快捷键");
  /* Keep the final focus check and input injection in the same server turn. */
  XGrabServer(display);
  gboolean valid = target_valid(target) && has_focus(window) && modifiers_released();
  gboolean ok = FALSE;
  if (valid) {
    ok = XTestFakeKeyEvent(display, control, True, CurrentTime);
    if (shift) ok = XTestFakeKeyEvent(display, shift, True, CurrentTime) && ok;
    if (ok) ok = XTestFakeKeyEvent(display, key, True, CurrentTime);
    /* Always release exactly the keys this helper attempted to press. */
    ok = XTestFakeKeyEvent(display, key, False, CurrentTime) && ok;
    if (shift) ok = XTestFakeKeyEvent(display, shift, False, CurrentTime) && ok;
    ok = XTestFakeKeyEvent(display, control, False, CurrentTime) && ok;
  }
  XUngrabServer(display); XSync(display, False);
  return paste_result(ok, ok ? NULL : "系统拒绝回贴或焦点已改变；已复制，请手动粘贴");
}

static JsonNode *paths_from_text(const gchar *text, gsize length) {
  JsonArray *result = json_array_new();
  if (!text || length > MAX_BYTES || memchr(text, 0, length) || !g_utf8_validate(text, length, NULL)) return array_node(result);
  gchar *copy = g_strndup(text, length); gchar **lines = g_strsplit(copy, "\n", 0);
  GHashTable *seen = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
  for (guint i = 0; lines[i] && json_array_get_length(result) < MAX_FILES; i++) {
    gchar *line = g_strchomp(lines[i]);
    if (!g_str_has_prefix(line, "file://")) continue;
    gchar *host = NULL, *path = g_filename_from_uri(line, &host, NULL);
    if (path && g_path_is_absolute(path) && (!host || !*host || g_ascii_strcasecmp(host, "localhost") == 0) && g_utf8_validate(path, -1, NULL) && !g_hash_table_contains(seen, path)) {
      json_array_add_string_element(result, path); g_hash_table_add(seen, g_strdup(path));
    }
    g_free(host); g_free(path);
  }
  g_hash_table_unref(seen); g_strfreev(lines); g_free(copy); return array_node(result);
}
static gboolean set_owned_files(JsonObject *request, gchar **error) {
  JsonNode *node = json_object_get_member(request, "paths");
  if (!node || !JSON_NODE_HOLDS_ARRAY(node)) { *error = g_strdup("paths must be an array"); return FALSE; }
  JsonArray *array = json_node_get_array(node); guint count = json_array_get_length(array);
  if (!count || count > MAX_FILES) { *error = g_strdup("文件数量必须为 1 至 1000"); return FALSE; }
  GPtrArray *paths = g_ptr_array_new_with_free_func(g_free); GString *uris = g_string_new(NULL);
  for (guint i = 0; i < count; i++) {
    JsonNode *item = json_array_get_element(array, i);
    const gchar *path = item && JSON_NODE_HOLDS_VALUE(item) && json_node_get_value_type(item) == G_TYPE_STRING ? json_node_get_string(item) : NULL;
    if (!path || !g_path_is_absolute(path) || !g_file_test(path, G_FILE_TEST_EXISTS)) { *error = g_strdup("文件路径无效或文件已不存在"); goto fail; }
    gchar *uri = g_filename_to_uri(path, NULL, NULL); if (!uri) { *error = g_strdup("文件路径无法编码"); goto fail; }
    g_ptr_array_add(paths, g_strdup(path)); g_string_append(uris, uri); g_string_append(uris, "\r\n"); g_free(uri);
    if (uris->len > MAX_BYTES) { *error = g_strdup("文件列表过大"); goto fail; }
  }
  clear_owned(); owned_paths = paths; owned_uris = g_string_free(uris, FALSE); owned_gnome = g_strconcat("copy\n", owned_uris, NULL); return TRUE;
fail:
  g_ptr_array_unref(paths); g_string_free(uris, TRUE); return FALSE;
}
static void selection_request(XSelectionRequestEvent *request) {
  XEvent response = {0}; response.xselection.type = SelectionNotify; response.xselection.display = request->display; response.xselection.requestor = request->requestor; response.xselection.selection = request->selection; response.xselection.target = request->target; response.xselection.time = request->time; response.xselection.property = None;
  Atom property = request->property ? request->property : request->target;
  if (request->selection == clipboard_atom && owned_uris) {
    if (request->target == targets_atom) {
      Atom values[] = { targets_atom, uri_atom, gnome_atom };
      XChangeProperty(display, request->requestor, property, XA_ATOM, 32, PropModeReplace, (unsigned char *)values, G_N_ELEMENTS(values)); response.xselection.property = property;
    } else if (request->target == uri_atom || request->target == gnome_atom) {
      const gchar *data = request->target == uri_atom ? owned_uris : owned_gnome; gsize length = strlen(data);
      if (length <= TRANSFER_CHUNK) { XChangeProperty(display, request->requestor, property, request->target, 8, PropModeReplace, (unsigned char *)data, length); response.xselection.property = property; }
      else if (transfers->len < 8) {
        OutTransfer *transfer = g_new0(OutTransfer, 1); transfer->requestor = request->requestor; transfer->property = property; transfer->type = request->target; transfer->data = g_strdup(data); transfer->length = length; transfer->deadline = now_ms() + 3000;
        XWindowAttributes attrs;
        if (XGetWindowAttributes(display, request->requestor, &attrs)) {
          XSelectInput(display, request->requestor, attrs.your_event_mask | PropertyChangeMask | StructureNotifyMask);
          unsigned long total = length; XChangeProperty(display, request->requestor, property, incr_atom, 32, PropModeReplace, (unsigned char *)&total, 1); g_ptr_array_add(transfers, transfer); response.xselection.property = property;
        } else transfer_free(transfer);
      }
    }
  }
  XSendEvent(display, request->requestor, False, 0, &response); XFlush(display);
}
static void read_property(gboolean incremental) {
  Atom actual; int format; unsigned long length, remaining; unsigned char *data = NULL;
  if (!incoming) return;
  if (XGetWindowProperty(display, selection_window, property_atom, 0, MAX_BYTES / 4, False, AnyPropertyType, &actual, &format, &length, &remaining, &data) != Success) { incoming->failed = incoming->done = TRUE; return; }
  if (!incremental && actual == incr_atom) { incoming->incremental = TRUE; XDeleteProperty(display, selection_window, property_atom); }
  else if (actual == incoming->target && format == 8 && !remaining && incoming->bytes->len + length <= MAX_BYTES) {
    if (length) g_byte_array_append(incoming->bytes, data, length);
    if (!incremental || !length) incoming->done = TRUE;
    XDeleteProperty(display, selection_window, property_atom);
  } else { incoming->failed = incoming->done = TRUE; XDeleteProperty(display, selection_window, property_atom); }
  if (data) XFree(data);
  XFlush(display);
}
static void x_events(void) {
  if (!display) return;
  while (XPending(display)) {
    XEvent event; XNextEvent(display, &event);
    if (event.type == SelectionRequest) selection_request(&event.xselectionrequest);
    else if (event.type == SelectionClear && event.xselectionclear.selection == clipboard_atom && XGetSelectionOwner(display, clipboard_atom) != selection_window) clear_owned();
    else if (event.type == DestroyNotify) {
      GHashTableIter iter; gpointer key, value; g_hash_table_iter_init(&iter, targets);
      while (g_hash_table_iter_next(&iter, &key, &value)) if (((Target *)value)->window == event.xdestroywindow.window) g_hash_table_iter_remove(&iter);
    } else if (event.type == SelectionNotify && incoming && event.xselection.requestor == selection_window && event.xselection.target == incoming->target) {
      if (!event.xselection.property) incoming->failed = incoming->done = TRUE; else read_property(FALSE);
    } else if (event.type == PropertyNotify) {
      if (incoming && incoming->incremental && event.xproperty.window == selection_window && event.xproperty.atom == property_atom && event.xproperty.state == PropertyNewValue) read_property(TRUE);
      if (event.xproperty.state == PropertyDelete) for (guint i = 0; i < transfers->len; i++) {
        OutTransfer *transfer = g_ptr_array_index(transfers, i);
        if (transfer->requestor == event.xproperty.window && transfer->property == event.xproperty.atom) {
          gsize chunk = MIN(TRANSFER_CHUNK, transfer->length - transfer->offset);
          XChangeProperty(display, transfer->requestor, transfer->property, transfer->type, 8, PropModeReplace, (unsigned char *)transfer->data + transfer->offset, chunk); transfer->offset += chunk; XFlush(display);
          if (!chunk) g_ptr_array_remove_index(transfers, i);
          break;
        }
      }
    }
  }
}
static JsonNode *read_x_files(void) {
  if (!display) return array_node(json_array_new());
  if (XGetSelectionOwner(display, clipboard_atom) == selection_window && owned_uris) return paths_from_text(owned_uris, strlen(owned_uris));
  Atom formats[] = { uri_atom, gnome_atom };
  for (guint i = 0; i < G_N_ELEMENTS(formats); i++) {
    ReadTransfer transfer = { .target = formats[i], .bytes = g_byte_array_new() };
    x_events(); incoming = &transfer; XDeleteProperty(display, selection_window, property_atom);
    XConvertSelection(display, clipboard_atom, formats[i], property_atom, selection_window, CurrentTime); XFlush(display);
    gint64 deadline = now_ms() + 650;
    while (!transfer.done && now_ms() < deadline) { x_events(); if (!transfer.done) g_usleep(2000); }
    incoming = NULL;
    JsonNode *result = transfer.done && !transfer.failed ? paths_from_text((gchar *)transfer.bytes->data, transfer.bytes->len) : array_node(json_array_new());
    g_byte_array_unref(transfer.bytes);
    if (json_array_get_length(json_node_get_array(result))) return result;
    json_node_free(result);
  }
  return array_node(json_array_new());
}

static GVariant *empty_options(void) { return g_variant_new_array(G_VARIANT_TYPE("{sv}"), NULL, 0); }
static GVariant *portal_call(const gchar *iface, const gchar *method, GVariant *parameters, const GVariantType *reply, gint timeout, GError **error) {
  if (!bus) { g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_NOT_CONNECTED, "Desktop portal unavailable"); return NULL; }
  return g_dbus_connection_call_sync(bus, PORTAL_BUS, PORTAL_PATH, iface, method, parameters, reply, G_DBUS_CALL_FLAGS_NONE, timeout, NULL, error);
}
static guint portal_version(const gchar *iface) {
  GVariant *response = portal_call("org.freedesktop.DBus.Properties", "Get", g_variant_new("(ss)", iface, "version"), G_VARIANT_TYPE("(v)"), 600, NULL);
  if (!response) return 0;
  GVariant *wrapped, *value; g_variant_get(response, "(@v)", &wrapped); value = g_variant_get_variant(wrapped);
  guint version = g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32) ? g_variant_get_uint32(value) : 0;
  g_variant_unref(value); g_variant_unref(wrapped); g_variant_unref(response); return version;
}
static void close_portal(void) {
  if (portal_session && bus) g_dbus_connection_call(bus, PORTAL_BUS, portal_session, "org.freedesktop.portal.Session", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL, NULL);
  g_clear_pointer(&portal_session, g_free); g_clear_pointer(&portal_mimes, g_strfreev); portal_clipboard = portal_owns = FALSE; clear_owned();
}
static void session_closed(GDBusConnection *connection, const gchar *sender, const gchar *path, const gchar *iface, const gchar *signal, GVariant *parameters, gpointer user) {
  (void)connection; (void)sender; (void)iface; (void)signal; (void)parameters; (void)user;
  if (portal_session && g_str_equal(path, portal_session)) { g_clear_pointer(&portal_session, g_free); portal_clipboard = portal_owns = FALSE; clear_owned(); g_clear_pointer(&portal_mimes, g_strfreev); g_free(portal_reason); portal_reason = g_strdup("剪贴板授权已结束，请重新授权或手动复制"); }
}
typedef struct { gboolean done; guint response; GVariant *results; } PortalResponse;
static void portal_response(GDBusConnection *connection, const gchar *sender, const gchar *path, const gchar *iface, const gchar *signal, GVariant *parameters, gpointer user) {
  (void)connection; (void)sender; (void)path; (void)iface; (void)signal;
  PortalResponse *result = user; if (result->done) return;
  g_variant_get(parameters, "(u@a{sv})", &result->response, &result->results); result->done = TRUE;
}
static GVariant *portal_request(const gchar *method, GVariant *parameters, const gchar *token, gint64 deadline, gchar **error) {
  gchar *sender = g_strdup(g_dbus_connection_get_unique_name(bus) + 1);
  for (gchar *c = sender; *c; c++) if (*c == '.') *c = '_';
  gchar *path = g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", sender, token); g_free(sender);
  PortalResponse wait = {0};
  guint subscription = g_dbus_connection_signal_subscribe(bus, PORTAL_BUS, "org.freedesktop.portal.Request", "Response", path, NULL, G_DBUS_SIGNAL_FLAGS_NONE, portal_response, &wait, NULL);
  GError *failure = NULL;
  GVariant *reply = portal_call(REMOTE_IFACE, method, parameters, G_VARIANT_TYPE("(o)"), MIN(1500, MAX(1, deadline - now_ms())), &failure);
  if (reply) {
    while (!wait.done && now_ms() < deadline) { while (g_main_context_iteration(NULL, FALSE)) {} if (!wait.done) g_usleep(5000); }
    const gchar *returned_path; g_variant_get(reply, "(&o)", &returned_path);
    if (!wait.done) g_dbus_connection_call(bus, PORTAL_BUS, returned_path, "org.freedesktop.portal.Request", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL, NULL);
    g_variant_unref(reply);
  }
  g_dbus_connection_signal_unsubscribe(bus, subscription); g_free(path);
  if (!reply || !wait.done || wait.response != 0) {
    *error = g_strdup(failure ? "当前桌面无法创建剪贴板授权会话" : !wait.done ? "剪贴板授权等待超时，请重试" : wait.response == 1 ? "已取消剪贴板授权" : "桌面拒绝剪贴板授权");
    g_clear_error(&failure); if (wait.results) g_variant_unref(wait.results); return NULL;
  }
  return wait.results;
}
static gchar *request_token(void) { gchar *token = g_uuid_string_random(); for (gchar *c = token; *c; c++) if (*c == '-') *c = '_'; return token; }
static gboolean authorize_portal(void) {
  if (portal_clipboard && portal_session) return TRUE;
  g_clear_pointer(&portal_reason, g_free);
  if (!portal_available) { portal_reason = g_strdup("桌面未提供 Clipboard 与 RemoteDesktop portal；来源未知，回贴不可用"); return FALSE; }
  close_portal(); gint64 deadline = now_ms() + 12000;
  gchar *token = request_token(), *session_token = request_token(), *error = NULL;
  GVariantBuilder options; g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token)); g_variant_builder_add(&options, "{sv}", "session_handle_token", g_variant_new_string(session_token));
  GVariant *result = portal_request("CreateSession", g_variant_new("(@a{sv})", g_variant_builder_end(&options)), token, deadline, &error);
  g_free(token); g_free(session_token);
  if (!result) goto failed;
  const gchar *session = NULL;
  if (g_variant_lookup(result, "session_handle", "&s", &session) && g_variant_is_object_path(session)) portal_session = g_strdup(session);
  g_variant_unref(result);
  if (!portal_session) { error = g_strdup("桌面未返回有效授权会话"); goto failed; }
  token = request_token(); g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
  /* Clipboard-only session: never request keyboard, pointer or screen access. */
  g_variant_builder_add(&options, "{sv}", "types", g_variant_new_uint32(0));
  result = portal_request("SelectDevices", g_variant_new("(o@a{sv})", portal_session, g_variant_builder_end(&options)), token, deadline, &error); g_free(token);
  if (!result) goto failed;
  g_variant_unref(result);
  if (!portal_session) { error = g_strdup("剪贴板授权会话已被桌面关闭"); goto failed; }
  result = portal_call(CLIP_IFACE, "RequestClipboard", g_variant_new("(o@a{sv})", portal_session, empty_options()), NULL, 1200, NULL);
  if (!result) { error = g_strdup("桌面不支持此会话的剪贴板访问"); goto failed; } g_variant_unref(result);
  token = request_token(); g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT); g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
  result = portal_request("Start", g_variant_new("(os@a{sv})", portal_session, "", g_variant_builder_end(&options)), token, deadline, &error); g_free(token);
  if (!result) goto failed;
  gboolean enabled = FALSE; g_variant_lookup(result, "clipboard_enabled", "b", &enabled); g_variant_unref(result);
  if (!enabled || !portal_session) { error = g_strdup("桌面未授予剪贴板访问，或授权会话已结束；仍可使用普通复制"); goto failed; }
  portal_clipboard = TRUE;
  portal_reason = g_strdup("已授权剪贴板；Wayland 无通用原窗口恢复接口，来源未知，请手动粘贴"); return TRUE;
failed:
  close_portal(); portal_reason = error ? error : g_strdup("剪贴板授权不可用"); return FALSE;
}
static gboolean fd_transfer(int fd, GByteArray *bytes, const gchar *output, gsize length, gint64 request_deadline) {
  int flags = fcntl(fd, F_GETFL); if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  gint64 deadline = MIN(now_ms() + 700, request_deadline); gsize offset = 0; gboolean success = FALSE;
  while (now_ms() < deadline) {
    if (output && offset == length) { success = TRUE; break; }
    struct pollfd pollfd = { .fd = fd, .events = output ? POLLOUT : POLLIN };
    int result = poll(&pollfd, 1, MIN(60, MAX(1, deadline - now_ms())));
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || (pollfd.revents & (POLLERR | POLLNVAL))) break;
    if (!result) continue;
    if (output) {
      ssize_t count = write(fd, output + offset, length - offset);
      if (count > 0) offset += count; else if (count < 0 && errno != EAGAIN && errno != EINTR) break;
    } else {
      guint8 buffer[8192]; ssize_t count = read(fd, buffer, sizeof buffer);
      if (count == 0) { success = TRUE; break; }
      if (count < 0) { if (errno != EAGAIN && errno != EINTR) break; }
      else { if (bytes->len + count > MAX_BYTES) break; g_byte_array_append(bytes, buffer, count); }
    }
  }
  close(fd); return success;
}
static GByteArray *portal_read_mime(const gchar *mime, gint64 deadline) {
  GUnixFDList *fds = NULL;
  GVariant *reply = g_dbus_connection_call_with_unix_fd_list_sync(bus, PORTAL_BUS, PORTAL_PATH, CLIP_IFACE, "SelectionRead", g_variant_new("(os)", portal_session, mime), G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, MIN(700, MAX(1, deadline - now_ms())), NULL, &fds, NULL, NULL);
  if (!reply) return NULL;
  gint handle; g_variant_get(reply, "(h)", &handle); int fd = fds ? g_unix_fd_list_get(fds, handle, NULL) : -1;
  g_variant_unref(reply); g_clear_object(&fds); if (fd < 0) return NULL;
  GByteArray *bytes = g_byte_array_new(); if (fd_transfer(fd, bytes, NULL, 0, deadline)) return bytes; g_byte_array_unref(bytes); return NULL;
}
static JsonNode *portal_file_transfer(GByteArray *bytes, gint64 deadline) {
  if (!bytes->len || bytes->len > 4096 || memchr(bytes->data, 0, bytes->len) || !g_utf8_validate((gchar *)bytes->data, bytes->len, NULL)) return array_node(json_array_new());
  gchar *key = g_strndup((gchar *)bytes->data, bytes->len); g_strstrip(key);
  GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Documents", "/org/freedesktop/portal/documents", "org.freedesktop.portal.FileTransfer", "RetrieveFiles", g_variant_new("(s@a{sv})", key, empty_options()), G_VARIANT_TYPE("(as)"), G_DBUS_CALL_FLAGS_NONE, MIN(800, MAX(1, deadline - now_ms())), NULL, NULL); g_free(key);
  JsonArray *array = json_array_new();
  if (reply) { gchar **paths; g_variant_get(reply, "(^as)", &paths); for (guint i = 0; paths[i] && i < MAX_FILES; i++) if (g_path_is_absolute(paths[i])) json_array_add_string_element(array, paths[i]); g_strfreev(paths); g_variant_unref(reply); }
  return array_node(array);
}
static JsonNode *read_portal_files(void) {
  if (!portal_clipboard || !portal_session) return array_node(json_array_new());
  if (portal_owns && owned_uris) return paths_from_text(owned_uris, strlen(owned_uris));
  const gchar *formats[] = { "text/uri-list", "x-special/gnome-copied-files", "application/vnd.portal.filetransfer" };
  gint64 deadline = now_ms() + 1700;
  for (guint i = 0; i < G_N_ELEMENTS(formats); i++) {
    if (now_ms() >= deadline) break;
    if (portal_mimes && !g_strv_contains((const gchar *const *)portal_mimes, formats[i])) continue;
    GByteArray *bytes = portal_read_mime(formats[i], deadline); if (!bytes) continue;
    JsonNode *result = i == 2 ? portal_file_transfer(bytes, deadline) : paths_from_text((gchar *)bytes->data, bytes->len); g_byte_array_unref(bytes);
    if (json_array_get_length(json_node_get_array(result))) return result;
    json_node_free(result);
  }
  return array_node(json_array_new());
}
static void clipboard_signal(GDBusConnection *connection, const gchar *sender, const gchar *path, const gchar *iface, const gchar *signal, GVariant *parameters, gpointer user) {
  (void)connection; (void)sender; (void)path; (void)iface; (void)user;
  if (!portal_session) return;
  if (g_str_equal(signal, "SelectionOwnerChanged")) {
    const gchar *session; GVariant *options; g_variant_get(parameters, "(&o@a{sv})", &session, &options);
    if (g_str_equal(session, portal_session)) { g_clear_pointer(&portal_mimes, g_strfreev); g_variant_lookup(options, "mime_types", "^as", &portal_mimes); portal_owns = FALSE; g_variant_lookup(options, "session_is_owner", "b", &portal_owns); if (!portal_owns) clear_owned(); }
    g_variant_unref(options);
  } else if (g_str_equal(signal, "SelectionTransfer")) {
    const gchar *session, *mime; guint serial; g_variant_get(parameters, "(&o&su)", &session, &mime, &serial);
    if (!g_str_equal(session, portal_session)) return;
    const gchar *data = g_str_equal(mime, "text/uri-list") ? owned_uris : g_str_equal(mime, "x-special/gnome-copied-files") ? owned_gnome : NULL;
    gboolean success = FALSE;
    if (data) {
      GUnixFDList *fds = NULL;
      GVariant *reply = g_dbus_connection_call_with_unix_fd_list_sync(bus, PORTAL_BUS, PORTAL_PATH, CLIP_IFACE, "SelectionWrite", g_variant_new("(ou)", session, serial), G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, 700, NULL, &fds, NULL, NULL);
      if (reply) { gint handle; g_variant_get(reply, "(h)", &handle); int fd = fds ? g_unix_fd_list_get(fds, handle, NULL) : -1; g_variant_unref(reply); g_clear_object(&fds); if (fd >= 0) success = fd_transfer(fd, NULL, data, strlen(data), now_ms() + 700); }
    }
    GVariant *reply = portal_call(CLIP_IFACE, "SelectionWriteDone", g_variant_new("(oub)", session, serial, success), NULL, 500, NULL); if (reply) g_variant_unref(reply);
  }
}
static JsonNode *capabilities(void) {
  JsonObject *object = json_object_new();
  json_object_set_boolean_member(object, "files", wayland ? portal_clipboard : display != NULL);
  json_object_set_boolean_member(object, "sourceApp", !wayland && display != NULL);
  json_object_set_boolean_member(object, "paste", !wayland && display && xtest_available);
  json_object_set_boolean_member(object, "permissionRequired", wayland && portal_available && !portal_clipboard);
  if (wayland) json_object_set_string_member(object, "reason", portal_reason ? portal_reason : portal_available ? "可授权 Clipboard portal 读取文件；Wayland 不支持通用原窗口恢复，来源未知，请手动粘贴" : "当前桌面未提供 Clipboard portal；来源未知，回贴不可用，普通复制仍可使用");
  else if (!display) json_object_set_string_member(object, "reason", "未连接 X11 显示服务");
  else if (!xtest_available) json_object_set_string_member(object, "reason", "X11 未启用 XTest，回贴不可用");
  return object_node(object);
}
static JsonNode *dispatch(JsonObject *request, gchar **error) {
  const gchar *command = string_member(request, "command");
  if (!command) { *error = g_strdup("command must be a string"); return NULL; }
  if (g_str_equal(command, "capabilities")) return capabilities();
  if (g_str_equal(command, "requestPermission")) { if (wayland) authorize_portal(); return capabilities(); }
  if (g_str_equal(command, "target")) return capture_target();
  if (g_str_equal(command, "source")) return source_app();
  if (g_str_equal(command, "paste")) return paste_target(string_member(request, "target"));
  if (g_str_equal(command, "readFiles")) return wayland ? read_portal_files() : read_x_files();
  if (g_str_equal(command, "writeFiles")) {
    if ((!wayland && !display) || (wayland && !portal_clipboard)) { *error = g_strdup("当前会话未提供文件剪贴板访问"); return NULL; }
    if (!set_owned_files(request, error)) return NULL;
    if (wayland) {
      GVariantBuilder options; const gchar *mimes[] = { "text/uri-list", "x-special/gnome-copied-files", NULL };
      g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT); g_variant_builder_add(&options, "{sv}", "mime_types", g_variant_new_strv(mimes, -1));
      GVariant *reply = portal_call(CLIP_IFACE, "SetSelection", g_variant_new("(o@a{sv})", portal_session, g_variant_builder_end(&options)), NULL, 900, NULL);
      if (!reply) { clear_owned(); *error = g_strdup("桌面拒绝文件剪贴板写入"); return NULL; } g_variant_unref(reply); portal_owns = TRUE;
    } else { XSetSelectionOwner(display, clipboard_atom, selection_window, CurrentTime); XSync(display, False); if (XGetSelectionOwner(display, clipboard_atom) != selection_window) { clear_owned(); *error = g_strdup("无法取得剪贴板所有权"); return NULL; } }
    return node_bool(TRUE);
  }
  *error = g_strdup("Unknown command"); return NULL;
}
static void respond(const gchar *line) {
  JsonParser *parser = json_parser_new(); gchar *error = NULL; JsonNode *result = NULL; gint64 id = 0;
  if (!json_parser_load_from_data(parser, line, -1, NULL) || !JSON_NODE_HOLDS_OBJECT(json_parser_get_root(parser))) error = g_strdup("Invalid JSON request");
  else {
    JsonObject *request = json_node_get_object(json_parser_get_root(parser)); JsonNode *id_node = json_object_get_member(request, "id");
    if (id_node && JSON_NODE_HOLDS_VALUE(id_node) && json_node_get_value_type(id_node) == G_TYPE_INT64) id = json_node_get_int(id_node);
    result = dispatch(request, &error);
  }
  JsonObject *response = json_object_new(); json_object_set_int_member(response, "id", id);
  if (error) json_object_set_string_member(response, "error", error); else json_object_set_member(response, "result", result ? result : node_null());
  if (error && result) json_node_free(result);
  JsonNode *node = object_node(response); JsonGenerator *generator = json_generator_new(); json_generator_set_root(generator, node); gchar *data = json_generator_to_data(generator, NULL);
  fputs(data, stdout); fputc('\n', stdout); fflush(stdout);
  g_free(data); g_object_unref(generator); json_node_free(node); g_free(error); g_object_unref(parser);
}
static gboolean stdin_ready(gint fd, GIOCondition condition, gpointer data) {
  (void)data; gchar buffer[8192];
  if (condition & G_IO_ERR) { g_main_loop_quit(main_loop); return G_SOURCE_REMOVE; }
  ssize_t count = read(fd, buffer, sizeof buffer);
  if (count <= 0) { if (count == 0 || (errno != EINTR && errno != EAGAIN)) { g_main_loop_quit(main_loop); return G_SOURCE_REMOVE; } return G_SOURCE_CONTINUE; }
  for (ssize_t i = 0; i < count; i++) {
    if (buffer[i] == '\n') {
      if (discard_input) respond("{\"command\":\"oversized-request\"}"); else if (input_buffer->len) respond(input_buffer->str);
      g_string_truncate(input_buffer, 0); discard_input = FALSE;
    } else if (!discard_input) {
      if (input_buffer->len >= MAX_BYTES || buffer[i] == '\0') { discard_input = TRUE; g_string_truncate(input_buffer, 0); }
      else g_string_append_c(input_buffer, buffer[i]);
    }
  }
  return G_SOURCE_CONTINUE;
}
static gboolean display_ready(gint fd, GIOCondition condition, gpointer data) { (void)fd; (void)data; if (condition & (G_IO_ERR | G_IO_HUP)) { g_main_loop_quit(main_loop); return G_SOURCE_REMOVE; } x_events(); return G_SOURCE_CONTINUE; }
static gboolean cleanup_tick(gpointer data) {
  (void)data; x_events();
  for (guint i = 0; i < transfers->len;) { OutTransfer *transfer = g_ptr_array_index(transfers, i); if (transfer->deadline < now_ms()) g_ptr_array_remove_index(transfers, i); else i++; }
  GHashTableIter iter; gpointer key, value; g_hash_table_iter_init(&iter, targets);
  while (g_hash_table_iter_next(&iter, &key, &value)) if (now_ms() - ((Target *)value)->captured > 30 * 60 * 1000) g_hash_table_iter_remove(&iter);
  return G_SOURCE_CONTINUE;
}
int main(void) {
  signal(SIGPIPE, SIG_IGN);
  /* A bundled GIO must not load a different distro's extension modules. The
   * helper only uses local files and the session bus, so no GIO modules are
   * needed. Keep ordinary unbundled development builds unchanged. */
  gchar *executable = g_file_read_link("/proc/self/exe", NULL);
  if (executable) {
    gchar *directory = g_path_get_dirname(executable), *modules = g_build_filename(directory, "lib", "gio", "modules", NULL);
    if (g_file_test(modules, G_FILE_TEST_IS_DIR)) { g_setenv("GIO_MODULE_DIR", modules, TRUE); g_setenv("GIO_EXTRA_MODULES", "", TRUE); g_setenv("GIO_USE_VFS", "local", TRUE); }
    g_free(modules); g_free(directory); g_free(executable);
  }
  main_loop = g_main_loop_new(NULL, FALSE); input_buffer = g_string_new(NULL);
  targets = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, target_free); transfers = g_ptr_array_new_with_free_func(transfer_free);
  wayland = (g_getenv("WAYLAND_DISPLAY") && *g_getenv("WAYLAND_DISPLAY")) || g_strcmp0(g_getenv("XDG_SESSION_TYPE"), "wayland") == 0;
  if (!wayland) display = XOpenDisplay(NULL);
  if (display) {
    XSetErrorHandler(on_x_error); selection_window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0); XSelectInput(display, selection_window, PropertyChangeMask);
    clipboard_atom = XInternAtom(display, "CLIPBOARD", False); uri_atom = XInternAtom(display, "text/uri-list", False); gnome_atom = XInternAtom(display, "x-special/gnome-copied-files", False); targets_atom = XInternAtom(display, "TARGETS", False); incr_atom = XInternAtom(display, "INCR", False); property_atom = XInternAtom(display, "_ENEST_CLIP_FILES", False);
    int event, error, major, minor; xtest_available = XTestQueryExtension(display, &event, &error, &major, &minor);
    g_unix_fd_add(ConnectionNumber(display), G_IO_IN | G_IO_HUP | G_IO_ERR, display_ready, NULL);
  }
  if (wayland) {
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
    portal_available = bus && portal_version(CLIP_IFACE) >= 1 && portal_version(REMOTE_IFACE) >= 2;
    if (bus) { g_dbus_connection_signal_subscribe(bus, PORTAL_BUS, CLIP_IFACE, NULL, PORTAL_PATH, NULL, G_DBUS_SIGNAL_FLAGS_NONE, clipboard_signal, NULL, NULL); g_dbus_connection_signal_subscribe(bus, PORTAL_BUS, "org.freedesktop.portal.Session", "Closed", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, session_closed, NULL, NULL); }
  }
  g_unix_fd_add(STDIN_FILENO, G_IO_IN | G_IO_HUP | G_IO_ERR, stdin_ready, NULL); g_timeout_add(250, cleanup_tick, NULL);
  g_main_loop_run(main_loop);
  close_portal(); clear_owned(); if (bus) g_object_unref(bus); if (display) { XDestroyWindow(display, selection_window); XCloseDisplay(display); }
  g_hash_table_unref(targets); g_ptr_array_unref(transfers); g_free(portal_reason); g_string_free(input_buffer, TRUE); g_main_loop_unref(main_loop); return 0;
}
