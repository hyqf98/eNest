#include <libsecret/secret.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include <string.h>

typedef struct { SecretService parent; } QuietService;
typedef struct { SecretServiceClass parent; } QuietServiceClass;
G_DEFINE_TYPE(QuietService, quiet_service, SECRET_TYPE_SERVICE)

static GVariant *deny_sync(SecretService *service, SecretPrompt *prompt, GCancellable *cancel, const GVariantType *type, GError **error) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "Interaction required");
    return NULL;
}
static void deny_async(SecretService *service, SecretPrompt *prompt, const GVariantType *type, GCancellable *cancel, GAsyncReadyCallback callback, gpointer data) {
    g_task_report_new_error(service, callback, data, deny_async, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "Interaction required");
}
static GVariant *deny_finish(SecretService *service, GAsyncResult *result, GError **error) {
    return g_task_propagate_pointer(G_TASK(result), error);
}
static void quiet_service_class_init(QuietServiceClass *type) {
    SecretServiceClass *service = SECRET_SERVICE_CLASS(type);
    service->prompt_sync = deny_sync;
    service->prompt_async = deny_async;
    service->prompt_finish = deny_finish;
}
static void quiet_service_init(QuietService *service) {}

static const SecretSchema schema = {
    .name = "com.github.eNest.AccountStorage", .flags = SECRET_SCHEMA_NONE,
    .attributes = { { "channel", SECRET_SCHEMA_ATTRIBUTE_STRING }, { NULL, 0 } }
};

static int lookup_key(const char *channel, const unsigned char *candidate, unsigned char result[32]) {
    g_autoptr(GError) error = NULL;
    g_autoptr(GDBusConnection) bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!bus) return 0;
    g_autoptr(GVariant) owner = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
        g_variant_new("(s)", "org.freedesktop.secrets"), G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 2000, NULL, &error);
    if (!owner) return 0;
    const char *bus_name;
    g_variant_get(owner, "(&s)", &bus_name);
    g_autoptr(SecretService) service = secret_service_open_sync(quiet_service_get_type(), bus_name, SECRET_SERVICE_OPEN_SESSION, NULL, &error);
    if (!service) return 0;
    g_autoptr(SecretCollection) collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT, SECRET_COLLECTION_NONE, NULL, &error);
    if (!collection || secret_collection_get_locked(collection)) return 0;
    g_autoptr(GHashTable) attributes = secret_attributes_build(&schema, "channel", channel, NULL);
    GList *items = secret_collection_search_sync(collection, &schema, attributes, SECRET_SEARCH_ALL, NULL, &error);
    if (items) {
        SecretItem *item = SECRET_ITEM(items->data);
        int ok = 0;
        if (!items->next && !secret_item_get_locked(item) && secret_item_load_secret_sync(item, NULL, &error)) {
            g_autoptr(SecretValue) value = secret_item_get_secret(item);
            gsize size = 0;
            const char *bytes = value ? secret_value_get(value, &size) : NULL;
            if (bytes && size == 32) { memcpy(result, bytes, 32); ok = 1; }
        }
        g_list_free_full(items, g_object_unref);
        return ok;
    }
    if (error || !candidate) return 0;
    g_autoptr(SecretValue) value = secret_value_new((const char *)candidate, 32, "application/octet-stream");
    g_autoptr(SecretItem) item = secret_item_create_sync(collection, &schema, attributes, "eNest GitHub account storage", value, SECRET_ITEM_CREATE_NONE, NULL, &error);
    if (!item) return 0;
    memcpy(result, candidate, 32);
    return 1;
}

int enest_account_key(const char *channel, const unsigned char *candidate, unsigned char result[32]) {
    if (!candidate) return lookup_key(channel, NULL, result);
    g_autofree char *path = g_build_filename(g_get_user_runtime_dir(), "enest-account-key.lock", NULL);
    int lock = open(path, O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_RDWR, 0600);
    if (lock < 0) return 0;
    int ok = flock(lock, LOCK_EX) == 0 && lookup_key(channel, candidate, result);
    close(lock);
    return ok;
}
