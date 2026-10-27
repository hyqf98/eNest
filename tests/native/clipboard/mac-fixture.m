#import <Cocoa/Cocoa.h>
static void reply(id value) { NSData *json=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL]; fwrite(json.bytes,1,json.length,stdout); fputc('\n',stdout); fflush(stdout); }
static NSMutableArray *keyEvents;
@interface CaptureTextView : NSTextView
@end
@implementation CaptureTextView
- (void)keyDown:(NSEvent *)event { [keyEvents addObject:@{@"key":@(event.keyCode),@"flags":@(event.modifierFlags),@"chars":event.characters?:@""}]; [super keyDown:event]; }
@end
@interface Fixture : NSObject <NSApplicationDelegate>
@property NSWindow *first;
@property NSWindow *second;
@property NSTextView *firstText;
@property NSTextView *secondText;
@property NSArray *saved;
@property NSRunningApplication *previous;
@property NSInteger ownedChange;
@end
@implementation Fixture
- (NSWindow *)window:(NSString *)title field:(NSTextView **)text x:(CGFloat)x {
  NSWindow *win=[[NSWindow alloc] initWithContentRect:NSMakeRect(x,250,420,160) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  win.releasedWhenClosed=NO;win.title=title;
  *text=[[CaptureTextView alloc] initWithFrame:NSMakeRect(10,10,400,140)];win.contentView=*text;return win;
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  keyEvents=NSMutableArray.array;
  self.previous=NSWorkspace.sharedWorkspace.frontmostApplication;
  NSMenu *bar=NSMenu.new; NSMenuItem *application=NSMenuItem.new; application.submenu=[[NSMenu alloc] initWithTitle:@"Fixture"]; [bar addItem:application]; NSMenuItem *edit=NSMenuItem.new;NSMenu *menu=[[NSMenu alloc] initWithTitle:@"Edit"];
  NSMenuItem *paste=[[NSMenuItem alloc] initWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];paste.keyEquivalentModifierMask=NSEventModifierFlagCommand;[menu addItem:paste];edit.submenu=menu;[bar addItem:edit];NSApp.mainMenu=bar;
  NSMutableArray *saved=NSMutableArray.array;
  NSUInteger bytes=0;
  for(NSPasteboardItem *item in NSPasteboard.generalPasteboard.pasteboardItems){NSMutableDictionary *values=NSMutableDictionary.dictionary;for(NSString *type in item.types){NSData *data=[item dataForType:type];if(data){values[type]=data;bytes+=data.length;}}[saved addObject:values];}
  if(bytes>32*1024*1024){reply(@{@"ready":@NO,@"reason":@"Current clipboard too large for reversible test"});[NSApp terminate:nil];return;}
  self.saved=saved;self.ownedChange=-1;
  NSTextView *one,*two;self.first=[self window:@"eNest clipboard test — original" field:&one x:150];self.firstText=one;self.second=[self window:@"eNest clipboard test — decoy" field:&two x:620];self.secondText=two;
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[NSApp activateIgnoringOtherApps:YES];[self.first makeKeyAndOrderFront:nil];[self.first makeFirstResponder:one];reply(@{@"ready":@YES});
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{char *line=NULL;size_t size=0;while(getline(&line,&size,stdin)!=-1){NSData *data=[[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];NSDictionary *request=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];dispatch_async(dispatch_get_main_queue(),^{[self perform:request];});}free(line);});
}
- (void)perform:(NSDictionary *)request {
  NSString *op=request[@"op"];id result=@YES;NSPasteboard *board=NSPasteboard.generalPasteboard;
  if([op isEqual:@"text"]){[board clearContents];[board setString:@"enest-native-paste-fixture" forType:NSPasteboardTypeString];self.ownedChange=board.changeCount;[self.first makeKeyAndOrderFront:nil];[self.first makeFirstResponder:self.firstText];}
  else if([op isEqual:@"files"]){[board clearContents];[board writeObjects:@[[NSURL fileURLWithPath:request[@"path"]]]];self.ownedChange=board.changeCount;}
  else if([op isEqual:@"readFiles"]){NSMutableArray *paths=NSMutableArray.array;for(NSURL *url in [board readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}])[paths addObject:url.path];self.ownedChange=board.changeCount;result=paths;}
  else if([op isEqual:@"decoy"]){[self.second makeKeyAndOrderFront:nil];[self.second makeFirstResponder:self.secondText];}
  else if([op isEqual:@"closeOriginal"]){[self.first close];}
  else if([op isEqual:@"state"]){result=@{@"original":self.firstText.string,@"decoy":self.secondText.string,@"keys":keyEvents};}
  else if([op isEqual:@"finish"]){[self restore];reply(@{@"id":request[@"id"]?:@0,@"result":@YES});[NSApp terminate:nil];return;}
  reply(@{@"id":request[@"id"]?:@0,@"result":result});
}
- (void)restore {
  NSPasteboard *board=NSPasteboard.generalPasteboard;
  if(self.saved && self.ownedChange==board.changeCount){NSMutableArray *items=NSMutableArray.array;for(NSDictionary *values in self.saved){NSPasteboardItem *item=NSPasteboardItem.new;for(NSString *type in values)[item setData:values[type] forType:type];[items addObject:item];}[board clearContents];[board writeObjects:items];}
  self.saved=nil;
  if(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==NSProcessInfo.processInfo.processIdentifier)[self.previous activateWithOptions:0];
}
- (void)applicationWillTerminate:(NSNotification *)note{[self restore];}
@end
int main(void){@autoreleasepool{Fixture *fixture=Fixture.new;NSApplication *app=NSApplication.sharedApplication;app.delegate=fixture;[app run];}return 0;}
