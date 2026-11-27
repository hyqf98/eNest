#include <node_api.h>
#include <string.h>

extern int enest_account_key(const char *channel, const unsigned char *candidate, unsigned char result[32]);

static napi_value get_account_key(napi_env env, napi_callback_info info) {
    size_t argc = 2, length = 0;
    napi_value args[2], output;
    char channel[16];
    void *candidate = NULL;
    bool buffer = false;
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
        napi_get_value_string_utf8(env, args[0], channel, sizeof(channel), &length) != napi_ok ||
        (strcmp(channel, "desktop") != 0 && strcmp(channel, "development") != 0) ||
        napi_is_buffer(env, args[1], &buffer) != napi_ok || !buffer ||
        napi_get_buffer_info(env, args[1], &candidate, &length) != napi_ok || (length != 0 && length != 32)) {
        napi_throw_error(env, NULL, "Invalid account key request");
        return NULL;
    }
    unsigned char key[32] = {0};
    if (!enest_account_key(channel, length ? candidate : NULL, key) ||
        napi_create_buffer_copy(env, sizeof(key), key, NULL, &output) != napi_ok) {
        napi_throw_error(env, NULL, "Noninteractive account storage unavailable");
        return NULL;
    }
    return output;
}

NAPI_MODULE_INIT() {
    napi_value getter;
    if (napi_create_function(env, "accountKey", NAPI_AUTO_LENGTH, get_account_key, NULL, &getter) != napi_ok) return NULL;
    return getter;
}
