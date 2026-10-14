#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static AXUIElementRef capturedWindow = NULL;
static AXUIElementRef capturedElement = NULL;
static NSString *capturedToken;
static pid_t capturedPid;
static NSTimeInterval capturedLaunch;

static id capabilities(void) {
  BOOL trusted = AXIsProcessTrusted();
  return @{ @"files": @YES, @"sourceApp": @NO, @"paste": @(trusted), @"permissionRequired": trusted ? @NO : @YES };
}
static id command(NSDictionary *request) {
  NSString *op = request[@"command"];
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  if ([op isEqual:@"capabilities"]) return capabilities();
  if ([op isEqual:@"requestPermission"]) {
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
    return capabilities();
  }
  if ([op isEqual:@"source"]) return NSNull.null; // Public pasteboard APIs do not expose a reliable owner.
  if ([op isEqual:@"target"]) {
    capturedToken = nil;
    if (capturedWindow) { CFRelease(capturedWindow); capturedWindow = NULL; }
    if (capturedElement) { CFRelease(capturedElement); capturedElement = NULL; }
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || [app.bundleIdentifier isEqual:@"com.enest.shell"] || [app.bundleIdentifier hasPrefix:@"com.github.Electron"]) return NSNull.null;
    if (!AXIsProcessTrusted()) return NSNull.null;
    AXUIElementRef axApp = AXUIElementCreateApplication(app.processIdentifier);
    AXError windowResult = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute, (CFTypeRef *)&capturedWindow);
    AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute, (CFTypeRef *)&capturedElement);
    CFRelease(axApp);
    if (windowResult != kAXErrorSuccess || !capturedWindow) return NSNull.null;
    capturedPid = app.processIdentifier; capturedLaunch = app.launchDate.timeIntervalSince1970;
    capturedToken = NSUUID.UUID.UUIDString;
    return @{ @"token": capturedToken, @"name": app.localizedName ?: @"" };
  }
  if ([op isEqual:@"readFiles"]) {
    NSArray *urls = [board readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    NSMutableArray *paths = NSMutableArray.array;
    for (NSURL *url in urls) if (url.isFileURL && paths.count < 1000) [paths addObject:url.path];
    return paths;
  }
  if ([op isEqual:@"writeFiles"]) {
    NSArray *paths = request[@"paths"];
    if (![paths isKindOfClass:NSArray.class] || !paths.count || paths.count > 1000) @throw [NSException exceptionWithName:@"files" reason:@"无效的文件列表" userInfo:nil];
    NSMutableArray *urls = NSMutableArray.array;
    for (id path in paths) {
      if (![path isKindOfClass:NSString.class] || ![path isAbsolutePath] || ![NSFileManager.defaultManager fileExistsAtPath:path]) @throw [NSException exceptionWithName:@"files" reason:@"文件已移动或删除" userInfo:nil];
      [urls addObject:[NSURL fileURLWithPath:path]];
    }
    [board clearContents]; return @([board writeObjects:urls]);
  }
  if ([op isEqual:@"paste"]) {
    if (!AXIsProcessTrusted()) return @{ @"pasted": @NO, @"reason": @"需要在系统设置中允许辅助功能" };
    if (!capturedToken || ![capturedToken isEqual:request[@"target"]] || !capturedWindow) return @{ @"pasted": @NO, @"reason": @"回贴目标无效，请重新呼出 Quick" };
    pid_t pid = capturedPid;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app || app.terminated || fabs(app.launchDate.timeIntervalSince1970 - capturedLaunch) > 0.001) return @{ @"pasted": @NO, @"reason": @"原应用已关闭" };
    [app activateWithOptions:0];
    AXUIElementSetAttributeValue(capturedWindow, kAXMainAttribute, kCFBooleanTrue);
    AXUIElementPerformAction(capturedWindow, kAXRaiseAction);
    if (capturedElement) AXUIElementSetAttributeValue(capturedElement, kAXFocusedAttribute, kCFBooleanTrue);
    AXUIElementRef axApp = AXUIElementCreateApplication(pid);
    BOOL matched = NO;
    for (int i = 0; i < 30; i++) {
      AXUIElementRef focused = NULL;
      AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute, (CFTypeRef *)&focused);
      matched = focused && CFEqual(focused, capturedWindow) && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid;
      if (focused) CFRelease(focused);
      if (matched) break;
      [NSThread sleepForTimeInterval:0.01];
    }
    CFRelease(axApp);
    if (!matched) return @{ @"pasted": @NO, @"reason": @"无法恢复原窗口焦点" };
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    CGEventRef down = CGEventCreateKeyboardEvent(source, 9, true), up = CGEventCreateKeyboardEvent(source, 9, false);
    if (source) CFRelease(source);
    if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); return @{ @"pasted": @NO, @"reason": @"无法创建粘贴事件" }; }
    CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up); CFRelease(down); CFRelease(up);
    return @{ @"pasted": @YES };
  }
  @throw [NSException exceptionWithName:@"command" reason:@"Unknown command" userInfo:nil];
}
int main(void) {
  @autoreleasepool {
    char *line = NULL; size_t size = 0; ssize_t length;
    while ((length = getline(&line, &size, stdin)) != -1) {
      @autoreleasepool {
        id ident = @0; NSDictionary *reply;
        @try {
          if (length > 1024 * 1024) @throw [NSException exceptionWithName:@"request" reason:@"Request too large" userInfo:nil];
          id input = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:length] options:0 error:NULL];
          if (![input isKindOfClass:NSDictionary.class]) @throw [NSException exceptionWithName:@"request" reason:@"Invalid JSON request" userInfo:nil];
          ident = input[@"id"] ?: @0;
          reply = @{ @"id": ident, @"result": command(input) ?: NSNull.null };
        } @catch (NSException *exception) { reply = @{ @"id": ident, @"error": exception.reason ?: @"System operation failed" }; }
        NSData *json = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
        fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
      }
    }
    free(line);
  }
  return 0;
}
