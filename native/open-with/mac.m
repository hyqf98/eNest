/*
 * Fixed, read-only default-handler switcher for macOS 12+.
 *
 * Usage: open-with-helper <ext|scheme> <value> <bundlePath>
 * Prints {"status":"ok"} or {"status":"error","message":"..."} and exits nonzero on failure.
 * Only NSWorkspace's public setDefaultApplicationAtURL: APIs are used; nothing else is
 * read, written or reported. Argument values are validated before any system call.
 */
#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void emit(NSString *status, NSString *message, int code) {
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"status"] = status;
  if (message.length) payload[@"message"] = message;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:NULL];
  if (data) fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  exit(code);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 4) emit(@"error", @"expected <ext|scheme> <value> <bundlePath>", 2);

    NSString *kind = [NSString stringWithUTF8String:argv[1]];
    NSString *value = [NSString stringWithUTF8String:argv[2]];
    NSString *path = [NSString stringWithUTF8String:argv[3]];
    if (!kind || !value || !path) emit(@"error", @"invalid argument encoding", 2);

    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyz0123456789.-+"];
    if (![[value lowercaseString] isEqualToString:value] || value.length == 0 || value.length > 128
        || [value rangeOfCharacterFromSet:[allowed invertedSet]].location != NSNotFound) {
      emit(@"error", @"invalid type value", 2);
    }
    if (![path isAbsolutePath] || ![[path pathExtension] isEqualToString:@"app"]) {
      emit(@"error", @"invalid application path", 2);
    }
    NSURL *appURL = [NSURL fileURLWithPath:path isDirectory:YES];
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
      emit(@"error", @"application not found", 3);
    }

    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSString *failure = nil;
    void (^finish)(NSError *) = ^(NSError *error) {
      if (error) failure = error.localizedDescription ?: @"system rejected the change";
      dispatch_semaphore_signal(done);
    };

    NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
    if ([kind isEqualToString:@"ext"]) {
      UTType *type = [UTType typeWithFilenameExtension:value];
      if (!type) emit(@"error", @"unknown file type", 4);
      [workspace setDefaultApplicationAtURL:appURL toOpenContentType:type completionHandler:finish];
    } else if ([kind isEqualToString:@"scheme"]) {
      [workspace setDefaultApplicationAtURL:appURL toOpenURLsWithScheme:value completionHandler:finish];
    } else {
      emit(@"error", @"unknown kind", 2);
    }

    // A missing callback must never hang the host; treat it as an explicit failure.
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
      emit(@"error", @"system did not respond", 5);
    }
    if (failure) emit(@"error", failure, 1);
    emit(@"ok", nil, 0);
  }
}
