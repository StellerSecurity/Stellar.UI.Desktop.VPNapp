#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface LocalSchemeHandler : NSObject <WKURLSchemeHandler>
@property(nonatomic, strong) NSURL *webRoot;
- (instancetype)initWithWebRoot:(NSURL *)webRoot;
@end

@implementation LocalSchemeHandler

- (instancetype)initWithWebRoot:(NSURL *)webRoot {
    self = [super init];
    if (self) _webRoot = webRoot;
    return self;
}

- (NSString *)mimeTypeForExtension:(NSString *)extension {
    NSDictionary<NSString *, NSString *> *types = @{
        @"html": @"text/html",
        @"css": @"text/css",
        @"js": @"application/javascript",
        @"json": @"application/json",
        @"geojson": @"application/geo+json",
        @"svg": @"image/svg+xml",
        @"png": @"image/png"
    };
    return types[extension.lowercaseString] ?: @"application/octet-stream";
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSURL *requestURL = urlSchemeTask.request.URL;
    NSString *relativePath = requestURL.path.stringByRemovingPercentEncoding ?: @"";
    while ([relativePath hasPrefix:@"/"]) relativePath = [relativePath substringFromIndex:1];
    if (relativePath.length == 0) relativePath = @"index.html";

    NSURL *rootURL = self.webRoot.URLByStandardizingPath;
    NSURL *fileURL = [[self.webRoot URLByAppendingPathComponent:relativePath] URLByStandardizingPath];
    NSString *rootPath = [rootURL.path stringByAppendingString:@"/"];
    if (![fileURL.path hasPrefix:rootPath]) {
        NSError *error = [NSError errorWithDomain:@"StellarVPNResources" code:403 userInfo:@{NSLocalizedDescriptionKey: @"Resource path is outside the application bundle."}];
        [urlSchemeTask didFailWithError:error];
        return;
    }

    NSError *readError = nil;
    NSData *data = [NSData dataWithContentsOfURL:fileURL options:NSDataReadingMappedIfSafe error:&readError];
    if (!data) {
        NSError *error = readError ?: [NSError errorWithDomain:@"StellarVPNResources" code:404 userInfo:@{NSLocalizedDescriptionKey: @"Bundled resource not found."}];
        [urlSchemeTask didFailWithError:error];
        return;
    }

    NSString *mimeType = [self mimeTypeForExtension:fileURL.pathExtension];
    NSDictionary<NSString *, NSString *> *headers = @{
        @"Content-Type": mimeType,
        @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)data.length],
        @"Access-Control-Allow-Origin": @"*",
        @"Cache-Control": @"no-cache"
    };
    NSURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:requestURL
        statusCode:200
        HTTPVersion:@"HTTP/1.1"
        headerFields:headers];
    [urlSchemeTask didReceiveResponse:response];
    [urlSchemeTask didReceiveData:data];
    [urlSchemeTask didFinish];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {}

@end

@interface AppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) LocalSchemeHandler *schemeHandler;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self configureMainMenu];

    NSURL *webRoot = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Web" isDirectory:YES];
    if (!webRoot) {
        [self showLaunchError:@"The bundled interface could not be found."];
        return;
    }

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    WKWebpagePreferences *pagePreferences = [[WKWebpagePreferences alloc] init];
    pagePreferences.allowsContentJavaScript = YES;
    configuration.defaultWebpagePreferences = pagePreferences;
    self.schemeHandler = [[LocalSchemeHandler alloc] initWithWebRoot:webRoot];
    [configuration setURLSchemeHandler:self.schemeHandler forURLScheme:@"stellar"];

    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.webView.allowsMagnification = NO;

    NSWindowStyleMask style = NSWindowStyleMaskTitled
        | NSWindowStyleMaskClosable
        | NSWindowStyleMaskMiniaturizable
        | NSWindowStyleMaskResizable;
    self.window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 1280, 820)
        styleMask:style
        backing:NSBackingStoreBuffered
        defer:NO];
    self.window.title = @"Stellar VPN";
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.tabbingMode = NSWindowTabbingModeDisallowed;
    self.window.minSize = NSMakeSize(960, 640);
    self.window.backgroundColor = [NSColor colorWithRed:10.0 / 255.0 green:52.0 / 255.0 blue:124.0 / 255.0 alpha:1.0];
    self.window.contentView = self.webView;
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];

    NSURL *indexURL = [NSURL URLWithString:@"stellar://app/index.html"];
    [self.webView loadRequest:[NSURLRequest requestWithURL:indexURL]];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) [self.window makeKeyAndOrderFront:nil];
    return YES;
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if (!url) {
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    if (url.isFileURL || [url.scheme isEqualToString:@"stellar"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
    } else {
        [NSWorkspace.sharedWorkspace openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
    }
}

- (nullable WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
    forNavigationAction:(WKNavigationAction *)navigationAction
    windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = navigationAction.request.URL;
    if (url && !url.isFileURL) [NSWorkspace.sharedWorkspace openURL:url];
    return nil;
}

- (void)reloadPage:(id)sender {
    [self.webView reload];
}

- (NSMenuItem *)menuItemWithTitle:(NSString *)title action:(SEL)action key:(NSString *)key {
    return [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
}

- (void)configureMainMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    NSMenuItem *applicationItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:applicationItem];
    NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Stellar VPN"];
    applicationItem.submenu = applicationMenu;
    [applicationMenu addItem:[self menuItemWithTitle:@"About Stellar VPN" action:@selector(orderFrontStandardAboutPanel:) key:@""]];
    [applicationMenu addItem:NSMenuItem.separatorItem];
    [applicationMenu addItem:[self menuItemWithTitle:@"Hide Stellar VPN" action:@selector(hide:) key:@"h"]];
    NSMenuItem *hideOthers = [self menuItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) key:@"h"];
    hideOthers.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [applicationMenu addItem:hideOthers];
    [applicationMenu addItem:[self menuItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) key:@""]];
    [applicationMenu addItem:NSMenuItem.separatorItem];
    [applicationMenu addItem:[self menuItemWithTitle:@"Quit Stellar VPN" action:@selector(terminate:) key:@"q"]];

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    editItem.submenu = editMenu;
    [editMenu addItem:[self menuItemWithTitle:@"Undo" action:@selector(undo:) key:@"z"]];
    [editMenu addItem:[self menuItemWithTitle:@"Redo" action:@selector(redo:) key:@"Z"]];
    [editMenu addItem:NSMenuItem.separatorItem];
    [editMenu addItem:[self menuItemWithTitle:@"Cut" action:@selector(cut:) key:@"x"]];
    [editMenu addItem:[self menuItemWithTitle:@"Copy" action:@selector(copy:) key:@"c"]];
    [editMenu addItem:[self menuItemWithTitle:@"Paste" action:@selector(paste:) key:@"v"]];
    [editMenu addItem:[self menuItemWithTitle:@"Select All" action:@selector(selectAll:) key:@"a"]];

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    viewItem.submenu = viewMenu;
    NSMenuItem *reloadItem = [self menuItemWithTitle:@"Reload" action:@selector(reloadPage:) key:@"r"];
    reloadItem.target = self;
    [viewMenu addItem:reloadItem];
    [viewMenu addItem:NSMenuItem.separatorItem];
    NSMenuItem *fullScreen = [self menuItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) key:@"f"];
    fullScreen.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    [viewMenu addItem:fullScreen];

    NSMenuItem *windowItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:windowItem];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    windowItem.submenu = windowMenu;
    [windowMenu addItem:[self menuItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) key:@"m"]];
    [windowMenu addItem:[self menuItemWithTitle:@"Zoom" action:@selector(performZoom:) key:@""]];
    [windowMenu addItem:NSMenuItem.separatorItem];
    [windowMenu addItem:[self menuItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) key:@""]];
    NSApp.windowsMenu = windowMenu;

    NSApp.mainMenu = mainMenu;
}

- (void)showLaunchError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = @"Stellar VPN could not start";
    alert.informativeText = message;
    [alert runModal];
    [NSApp terminate:nil];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        AppDelegate *delegate = [[AppDelegate alloc] init];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
