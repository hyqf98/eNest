#include <Security/Security.h>
#include <string.h>

int enest_account_key(const char *channel, const unsigned char *candidate, unsigned char result[32]) {
    static const char service[] = "com.github.eNest.shell.account-storage";
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 0;
    SecKeychainRef keychain = NULL;
    SecKeychainStatus status = 0;
    if (SecKeychainCopyDefault(&keychain) != errSecSuccess || !keychain) return 0;
    int success = 0;
    if (SecKeychainGetStatus(keychain, &status) == errSecSuccess && (status & kSecUnlockStateStatus)) {
        for (int attempt = 0; attempt < 2; ++attempt) {
            UInt32 size = 0;
            void *secret = NULL;
            OSStatus found = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service, (UInt32)strlen(channel), channel, &size, &secret, NULL);
            if (found == errSecSuccess) {
                if (size == 32 && secret) { memcpy(result, secret, 32); success = 1; }
                SecKeychainItemFreeContent(NULL, secret);
                break;
            }
            if (found != errSecItemNotFound || !candidate || attempt != 0) break;
            OSStatus added = SecKeychainAddGenericPassword(keychain, sizeof(service) - 1, service, (UInt32)strlen(channel), channel, 32, candidate, NULL);
            if (added == errSecSuccess) { memcpy(result, candidate, 32); success = 1; break; }
            if (added != errSecDuplicateItem) break;
        }
    }
    CFRelease(keychain);
    return success;
}
