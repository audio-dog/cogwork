# OS notifications from the desktop shell ("Notify me")

**Question:** when a workflow wants the person's attention (a notification, or a plan waiting for
approval), how should the desktop shell raise an OS-level notification whose click opens the item
in the app — on macOS first (the maintainer runs macOS 26), then Windows and Linux? What does
Electron 43 give us, what does it need from the build, and what do shipped Electron apps on this
machine do?

Sources were read on 2026-10-27. Electron claims come from the Electron source tagged
[`v43.3.0`](https://github.com/electron/electron/tree/v43.3.0) (the version installed in
`node_modules/.pnpm/electron@43.3.0`), its `docs/` tree at that tag, and the typings it ships
(`node_modules/.pnpm/electron@43.3.0/node_modules/electron/electron.d.ts`). Links to source files
below point at that tag. Where a claim is my reading of source and not a documented or tested
behaviour, it says so.

**TL;DR:** Use the main-process `Notification` module. Since Electron 42 it posts through Apple's
`UNUserNotificationCenter`, which only delivers for a code-signed app; the dev `Electron.app` that
`electron-vite dev` runs is ad-hoc signed, so expect `failed` instead of a banner in dev. Electron
has no "request permission" or "permission status" API: the first call into the `Notification`
module triggers the macOS prompt, and a denial shows up as a `failed` event. Electron also gives no
payload field on macOS, so put the item reference in the notification `id`. The shell already
stays resident (close-to-hide, tray), which covers "window closed"; "app quit" needs either a login
item or a daemon-side launcher, and the shell can't recover a click on a notification from a
previous process in a reliable way. Fix the app id mismatch by calling `setAppUserModelId` with the
`appId` from `electron-builder.yml`.

## 1. What backs `Notification` on macOS in Electron 43

**Framework.** Electron 42 replaced the deprecated `NSUserNotification` with the User
Notifications framework (`UNUserNotificationCenter`). Sources:

- The breaking-changes entry under "Planned Breaking API Changes (42.0)", which says the new API
  "requires that an application be code-signed in order for notifications to be displayed. If an
  application is not code-signed, notifications will emit a `failed` event"
  ([`docs/breaking-changes.md`](https://github.com/electron/electron/blob/v43.3.0/docs/breaking-changes.md#behavior-changed-macos-notifications-now-use-unnotification-api)).
- The [Electron 42 release post](https://www.electronjs.org/blog/electron-42-0#behavior-changed-macos-notifications-now-use-unnotification-api),
  which repeats this.
- The implementing PR, [electron/electron#47817](https://github.com/electron/electron/pull/47817),
  merged 2026-03-05.

Apple deprecated `NSUserNotification` in macOS 11 with the note "All NSUserNotifications API should
be replaced with UserNotifications.frameworks API"
([NSUserNotification](https://developer.apple.com/documentation/foundation/nsusernotification)).

**What the v43.3.0 source does:**

- **Authorization.** `NotificationPresenterMac`'s constructor sets the delegate and calls
  `requestAuthorizationWithOptions:(Alert | Sound | Badge)`. The completion result is only logged,
  and only when `ELECTRON_DEBUG_NOTIFICATIONS` is set
  ([`notification_presenter_mac.mm`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/mac/notification_presenter_mac.mm)).
- **When the presenter is created.** `ElectronBrowserClient::GetNotificationPresenter()` creates the
  presenter lazily on first use
  ([`electron_browser_client.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/electron_browser_client.cc)).
  The only callers are the `Notification` module (its constructor, `isSupported`, `getHistory`,
  `remove*`) and the renderer's web-notification service
  ([`electron_api_notification.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/api/electron_api_notification.cc),
  [`platform_notification_service.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/platform_notification_service.cc)).
  **So the first call into the `Notification` module is what shows the macOS permission prompt.**
  This includes `Notification.isSupported()`.
- **`isSupported()`.** It returns whether a presenter exists
  (`electron_api_notification.cc`, `Notification::IsSupported`). On macOS a presenter is always
  created, so the call does not report whether the person has granted permission.
- **No permission API.** The v43.3.0 typings declare no permission-request or permission-status
  method on `Notification`. Electron's tutorial points to the third-party module
  `macos-notification-state` instead
  ([`docs/tutorial/notifications.md`](https://github.com/electron/electron/blob/v43.3.0/docs/tutorial/notifications.md)).
  That module reports screen-lock and Do Not Disturb, not whether the app is authorized
  ([README](https://github.com/felixrieseberg/macos-notification-state)). It was last pushed
  2023-07-11, per the GitHub API.
- **Denial and unsigned apps.** `addNotificationRequest`'s completion error becomes the `failed`
  event, carrying `error.localizedDescription`
  ([`cocoa_notification.mm`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/mac/cocoa_notification.mm)).
  Electron's CI saw the error "Notifications are not allowed for this application" when
  `usernotificationsd` did not recognise the bundle
  ([#52177](https://github.com/electron/electron/pull/52177)).
- **Foreground presentation.** The delegate shows banner, list and sound even when the app is
  frontmost (`willPresentNotification`, in
  [`notification_center_delegate.mm`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/mac/notification_center_delegate.mm)).
- **Debugging.** `ELECTRON_DEBUG_NOTIFICATIONS=1` logs each notification's lifecycle
  ([`docs/api/environment-variables.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/environment-variables.md)).

**New APIs since the switch (all present in the 43.3.0 typings):**

- `id` and `groupId` constructor options
  ([#50097](https://github.com/electron/electron/pull/50097)).
- `Notification.getHistory()` (macOS)
  ([#50325](https://github.com/electron/electron/pull/50325)).
- `Notification.remove()`, `removeAll()` and `removeGroup()` (macOS)
  ([#51182](https://github.com/electron/electron/pull/51182), backported to 43-x-y).
- `Notification.handleActivation()` (Windows), from the
  [Electron 42 release post](https://www.electronjs.org/blog/electron-42-0).

**Unsigned and dev builds.** `electron-vite dev` runs the npm-installed binary. On this machine,
`codesign -dv` on `node_modules/.pnpm/electron@43.3.0/node_modules/electron/dist/Electron.app`
reports:

- `flags=0x20002(adhoc,linker-signed)`
- `Signature=adhoc`
- `TeamIdentifier=not set`
- `Info.plist=not bound`
- bundle id `com.github.Electron`

The `Electron Framework.framework` inside it reports the same. Electron's docs say UNNotification
"requires an application to be code-signed in order for notifications to appear. Unsigned binaries
will emit a `failed` event"
([`docs/api/notification.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/notification.md)).
`getHistory()` "will resolve with an empty array" in unsigned dev builds (same page).

Electron's own macOS test job does three things so that "macOS system integrations
(UNNotifications, dock bounce, etc.) work in tests":

1. It creates and trusts a self-signed codesigning identity (`script/codesign/generate-identity.sh`).
2. It runs `codesign -s "$identity" --deep --force` on `Electron.app`.
3. It registers the bundle with `lsregister -f`.

The source is
[`.github/workflows/pipeline-segment-electron-test.yml`](https://github.com/electron/electron/blob/v43.3.0/.github/workflows/pipeline-segment-electron-test.yml)
plus [#52177](https://github.com/electron/electron/pull/52177).

I did not test whether the ad-hoc signature that ships with `Electron.app` is enough. Electron's CI
re-signs with a real identity, which suggests it is not. Treat dev-build delivery as unverified.

## 2. macOS features through Electron 43

All from [`docs/api/notification.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/notification.md)
and the typings unless noted.

- **Events.**
  - `show`, `click` and `close` fire on all platforms.
  - `reply`, `action` and `failed` fire on macOS and Windows.
  - On macOS, the delegate maps the default action to `click`, the dismiss action to `close`,
    `ACTION_n` to `action`, and `REPLY_ACTION` to `reply` (`notification_center_delegate.mm`).
  - `close` "is not guaranteed to be emitted in all cases".
- **Action buttons.** `actions: [{ type: 'button', text }]`. Electron builds a
  `UNNotificationCategory` for each distinct set of actions and registers it on the fly
  (`cocoa_notification.mm`). The `NotificationAction` doc still says extra buttons need a signed
  app and `NSUserNotificationAlertStyle` set to `alert` in `Info.plist`
  ([`structures/notification-action.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/structures/notification-action.md)).
  That Info.plist key belongs to the `NSUserNotification` era. Under UserNotifications, Apple
  describes the alert style as the person's choice ("The user may choose to display alerts as
  automatically disappearing banners or as modal windows")
  ([`UNNotificationSettings.alertStyle`](https://developer.apple.com/documentation/usernotifications/unnotificationsettings/alertstyle)).
  I did not verify whether the key still has an effect.
- **Inline reply.** `hasReply` and `replyPlaceholder` produce a `UNTextInputNotificationAction`
  (`cocoa_notification.mm`).
- **Grouping.** `groupId` maps to `UNNotificationContent.threadIdentifier`. `Notification.removeGroup(groupId)`
  clears a group. Apple: "assign the same thread identifier string to all notifications that you
  want to group together visually"
  ([threadIdentifier](https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/threadidentifier)).
- **Sound.** By default Electron plays `UNNotificationSound.defaultSound`. `silent: true` turns
  sound off, and `sound: '<name>'` plays a named sound from the bundle's `Resources` or a system
  Sounds folder (`cocoa_notification.mm`, and "Playing Sounds" in the API doc).
- **No payload.** Electron never sets `UNNotificationContent.userInfo` (`cocoa_notification.mm`
  sets only title, subtitle, body, thread, sound, category and attachments). To find the item
  again, use the `id` option (the `UNNotificationRequest` identifier).
- **Focus / Do Not Disturb.** Electron never sets `interruptionLevel`, so notifications get
  Apple's default, `.active`. Apple says active notifications "won't break through system
  notification controls"
  ([`.active`](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/active)).
  Breaking through Focus needs `.timeSensitive`
  ([`.timeSensitive`](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive)),
  and Electron does not expose it.
- **Persistence and garbage collection.** Delivered notifications stay in Notification Center
  until they are removed. But a `new Notification()` that is garbage-collected removes its
  delivered notification: `~CocoaNotification` calls `removeDeliveredNotificationsWithIdentifiers`
  unless the notification was restored (`cocoa_notification.mm`). The API doc contrasts this with
  restored notifications, which "remain visible in Notification Center when the object is garbage
  collected". **Keep a reference to every live notification**, for example in a `Map` keyed by `id`.
- **After the app quits.** `NotificationPresenter`'s destructor deletes every notification it
  owns
  ([`notification_presenter.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/notification_presenter.cc)).
  Each deletion runs the removal above. My reading of the source is that a clean quit clears this
  process's notifications. I did not confirm that the presenter is destroyed at shutdown, and I did
  not test it.
- **Clicking a notification from a previous process.** Two mechanisms exist:
  - **`getHistory()` (macOS).** It returns live objects for notifications still in Notification
    Center, and `click`, `reply`, `action` and `close` fire on them.
  - **The `app` `ready` event.** Its `launchInfo` "holds … information from
    `UNNotificationResponse` … if it was launched from Notification Center"
    ([`docs/api/app.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/app.md#event-ready)).
    That information is `identifier`, `actionIdentifier`, `userInfo` and `userText`
    ([`structures/notification-response.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/structures/notification-response.md),
    filled in by
    [`electron_application_delegate.mm`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/mac/electron_application_delegate.mm)).

  The gap: Apple says "You must assign your delegate object to the `UNUserNotificationCenter`
  object before your app finishes launching … Assigning a delegate after the system calls these
  methods might cause you to miss incoming notifications"
  ([UNUserNotificationCenterDelegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate)).
  Electron assigns its delegate only when the presenter is first created, which happens after
  `ready`. **A cold-start click can therefore be lost unless `launchInfo` carries it.** I did not
  test which path fires on macOS 26.
- **Dock badge.** `app.setBadgeCount([count])` works on macOS and Linux and shows on the dock icon.
  The doc warns "you need to ensure that your application has the permission to display
  notifications for this method to work"
  ([`app.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/app.md#appsetbadgecountcount-linux-macos)).
  `app.dock.setBadge(text)` sets a string badge
  ([`dock.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/dock.md)). In
  `browser_mac.mm`, `SetBadgeCount` sets the dock badge text directly and does not request
  authorization.
- **Size.** Electron's tutorial says "notifications are limited to 256 bytes in size and will be
  truncated" (`docs/tutorial/notifications.md`).

## 3. Renderer `window.Notification` or main-process `Notification`

The API page opens with "If you want to show notifications from a renderer process you should use
the web Notifications API"
([`docs/api/notification.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/notification.md)).
The tutorial presents both ways as equal options, one for each process type
([`docs/tutorial/notifications.md`](https://github.com/electron/electron/blob/v43.3.0/docs/tutorial/notifications.md)).
Electron does not prefer one for this use case. The source shows what the renderer path loses:

- Both paths use the same native presenter. `PlatformNotificationService::DisplayNotification`
  calls `GetNotificationPresenter()`, so the code-signing and permission rules are the same.
- The web path passes only title, body, tag, icon and silent, and sets `has_reply = false`. It
  sends no actions, no `groupId`, no `subtitle`, and no custom `id` beyond the tag
  (`platform_notification_service.cc`, `OnWebNotificationAllowed`).
- "Electron doesn't support persistent notifications" (`ReadNextPersistentNotificationId`, same
  file). So there is no service-worker notification, and `onclick` needs the renderer that created
  the notification to be alive.
- `getHistory`, `remove*` and `handleActivation` exist only on the main-process module.

For cogwork, the trigger comes from the daemon, and the click must open the window. That matches
the main-process API, which owns app lifecycle and window focus.

## 4. Windows and Linux

### Windows: AppUserModelID

- **Electron's requirement.** The tutorial says the app "needs to have a Start Menu shortcut with
  an AppUserModelID and a corresponding ToastActivatorCLSID". In development "you may have to call
  `app.setAppUserModelId()` yourself" (`docs/tutorial/notifications.md`).
- **What Electron 43 does itself.** On first use,
  `NotificationActivator::RegisterActivator()` runs `EnsureShortcut()` and
  `EnsureCLSIDRegistry()` for unpackaged apps
  ([`windows_toast_activator.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/win/windows_toast_activator.cc)):
  - `EnsureShortcut()` writes `%APPDATA%\…\Start Menu\Programs\<product name>.lnk` with the
    process's current AUMID and the activator CLSID. If a shortcut with that name exists but
    carries a different AUMID or CLSID, it rewrites the shortcut.
  - The toast notifier is created with `CreateToastNotifierWithId(<process AUMID>)`
    ([`windows_toast_notification.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/win/windows_toast_notification.cc)).
  - With no explicit AUMID, the process AUMID defaults to `electron.app.<product name>`
    ([`application_info_win.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/common/application_info_win.cc)).
  - `app.setToastActivatorCLSID()` pins the CLSID. Without it, the CLSID "is randomly generated
    for the app" ([`app.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/app.md#appsettoastactivatorclsidid-windows)).
- **What electron-builder does.** `appId` is "Used as … Application User Model ID for Windows
  (NSIS target only, Squirrel.Windows not supported)" (`app-builder-lib@26.15.3/scheme.json`). The
  NSIS installer runs `WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"` on the Start Menu and
  desktop shortcuts (`app-builder-lib/templates/nsis/include/installer.nsh`). The Start Menu
  shortcut is named `${SHORTCUT_NAME}.lnk` (`templates/nsis/common.nsh`).
- **cogwork's mismatch.** `electron-builder.yml` sets `appId: com.scribehow.cogwork`, and
  `apps/desktop/src/main/index.ts:135` calls `electronApp.setAppUserModelId("com.cogwork")`.
  `@electron-toolkit/utils` does `app.setAppUserModelId(is.dev ? process.execPath : id)` on Windows
  only (`node_modules/.pnpm/@electron-toolkit+utils*/dist/index.mjs`). So a packaged build runs as
  `com.cogwork`, while the installer stamps `com.scribehow.cogwork` on the shortcuts.
  - **Effect on toasts (my reading, not tested on Windows).** They probably still show, because
    Electron 43 rewrites `Programs\cogwork.lnk` to `com.cogwork` when the AUMIDs differ. That
    rewrite fights the installer's shortcut, and the uninstaller's `UninstAppUserModelId` targets
    the other id.
  - **Microsoft's rule.** "If an application uses an explicit AppUserModelID, it must also assign
    the same AppUserModelID to all running windows or processes, shortcuts, and file associations"
    ([Application User Model IDs](https://learn.microsoft.com/en-us/windows/win32/shell/appids)).
    The mismatch breaks that rule however toasts behave.
- **`toastXml`.** It replaces all other options with a full toast XML document (API doc). It
  matters for cold-start clicks: Electron's generated XML sets no `launch` string (the header's
  `arguments` is `""` in `windows_toast_notification.cc`). Microsoft's toast schema defines
  `<toast launch="…">` as "a string that is passed to the application when it is activated by the
  toast … allows it to show the user a view relevant to the toast content"
  ([toast element](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-toast)).
  `Notification.handleActivation(cb)` delivers `ActivationArguments.arguments`, "the raw activation
  arguments string from Windows", including on cold start
  ([`structures/activation-arguments.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/structures/activation-arguments.md)).
  On Windows, `id` and `groupId` may be at most 64 UTF-16 characters, or the constructor throws
  (`electron_api_notification.cc`).

### Linux: libnotify

- **Delivery.** Electron's tutorial says notifications "are sent using `libnotify`, which can show
  notifications on any desktop environment that follows Desktop Notifications Specification"
  (`docs/tutorial/notifications.md`;
  [spec 1.3](https://specifications.freedesktop.org/notification/latest-single/)).
  `NotificationPresenter::Create()` returns nothing if libnotify cannot be loaded, so
  `isSupported()` is `false` there
  ([`notification_presenter_linux.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/linux/notification_presenter_linux.cc)).
- **What 43.3.0 sends**
  ([`libnotify_notification.cc`](https://github.com/electron/electron/blob/v43.3.0/shell/browser/notifications/linux/libnotify_notification.cc)):
  - a `default` action (the click) when the server advertises the `actions` capability
  - urgency
  - `timeoutType`
  - the `append` hints
  - the `desktop-entry` hint from the XDG app id
  - `sender-pid`
- **Action buttons on Linux** arrived later, in
  [#54516](https://github.com/electron/electron/pull/54516) (merged 2026-10-13, labelled
  `merged/44-x-y`). They are not in 43.
- **The spec's rules.** The click is the action keyed `"default"`. Servers may ignore actions, and
  clients "should check if it is available" through `GetCapabilities`. `ActivationToken` can come
  before `ActionInvoked`, so the app can raise a window on Wayland (spec §9.2.2–9.2.3).

## 5. When the window is closed or the app has quit

**cogwork's starting point.** `apps/desktop/CONTEXT.md` ("Close-to-hide") says: "Closing the
window hides it and leaves the engine running; the app stays in the dock and tray. Quit … is the
only path that stops a spawned engine". An **adopted** engine "is left running on Quit". The main
process stays alive while the window is hidden, so a hidden window is not a problem. The open case
is a daemon that outlives the shell: an adopted engine after Quit, or the CLI as headless host.

**What Electron offers:**

- **`app.setLoginItemSettings({ openAtLogin })`** (macOS and Windows). On macOS 13 and later,
  `type` can also register an `agentService`, `daemonService` or `loginItemService` from the
  bundle's `Contents/Library/…` through `SMAppService`
  ([`app.md`](https://github.com/electron/electron/blob/v43.3.0/docs/api/app.md#appsetloginitemsettingssettings-macos-windows)).
  `openAsHidden` "does not work on macOS 13 and up".
- **`app.setActivationPolicy('accessory')`.** The app does not appear in the Dock and has no menu
  bar (`app.md`).
- **Starting the app from outside.** `app.setAsDefaultProtocolClient(protocol)` together with the
  `open-url` event (macOS needs `CFBundleURLTypes` in Info.plist, and the listener must be
  registered before `ready`). `app.requestSingleInstanceLock()` / `second-instance` hands the URL to
  a running instance (`app.md`). cogwork already holds the single-instance lock and listens for
  `second-instance` (`apps/desktop/src/main/index.ts:175-179`).

**What shipped apps on this machine write to disk** (read from `Contents/Info.plist`,
`Electron Framework.framework/Resources/Info.plist`, and `codesign -d --entitlements -`;
`/Applications/Codex.app` is not installed):

| App | Bundle id | Electron | `LSUIElement` | `NSUserNotificationAlertStyle` | Notable |
| --- | --- | --- | --- | --- | --- |
| Cursor 3.27.14 | `com.todesktop.230313mzl4w4u92` | 42.11.16 | absent | absent | hardened runtime, team `VDXQ22DGB9`; URL scheme `cursor` |
| Claude 3.6556.2 | `com.anthropic.claudefordesktop` | 44.9.3 | absent | absent | hardened runtime, team `Q6L2SF6YDW`; URL scheme `claude` |
| Slack 4.52.171 | `com.tinyspeck.slackmacgap` | 44.4.5 | absent | absent | hardened runtime + library validation, team `BQR82RBBHL`; URL scheme `slack` |

None of the three has an `aps-environment` (push) entitlement or a notification entitlement. All
three are Developer-ID-signed with a team identifier. More detail on each:

- **Cursor** ships `Contents/Library/LaunchAgents/com.todesktop.230313mzl4w4u92.BackgroundActivityCheck.plist`,
  whose comment says it is "Registered only so the app can read its App Background Activity switch.
  It has no launch trigger, so it never runs" (`Program` is `/usr/bin/true`). Its `out/main.js`
  calls `app.setLoginItemSettings({ openAtLogin: true, type: "agentService", serviceName })` for
  that plist.
- **Claude** (strings in `Resources/app.asar`):
  - **Two notification backends.** One is Electron's `Notification`. It keeps every live
    notification in an `activeNotifications` `Map`, passes `id`, `subtitle` (darwin only) and
    button `actions`, and wires `show`, `failed`, `click`, `close` and `action`. The other is its
    own Swift addon (`app.asar.unpacked/node_modules/@ant/claude-swift/build/Release/swift_addon.node`).
    The addon's strings include `UNUserNotificationCenterDelegate`,
    `requestAuthorizationWithOptions:completionHandler:`,
    `getNotificationSettingsWithCompletionHandler:`, `authorizationStatus`,
    `setInterruptionLevel:`, `setThreadIdentifier:` and `setUserInfo:`.
  - **Logs.** The app logs either "NotificationService initialized with UNUserNotificationCenter
    (macOS)" or "… with Electron notifications".
  - **Permission requests.** It raises notifications for tool permission requests, with an
    "Allow once" action and a per-session `groupId`.
  - **Login item.** It sets `app.setLoginItemSettings({ openAtLogin, enabled, name: "Claude" })`
    from a setting.
- **Slack** ships the native modules `macos-notification-state` and `windows-focus-assist`
  (`app.asar.unpacked/node_modules/…`). Its bundle has `setLoginItemSettings`/`openAtLogin`,
  `dock.setBadge`, and a notification schema with `hasReply`, `launchUri` and `actionButtons`.

These are minified bundles, so string matches show what code exists, not when it runs. What the
apps share: a Developer ID signature, no special Info.plist keys, a resident process for delivery
(no push), an optional login item, and a URL scheme for deep links. Claude's addon shows a shipped
app adding the UN features that Electron does not expose: `userInfo`, authorization status, and
interruption level.

**What the daemon could do itself (inference, not researched further).** The daemon is a plain
Node child (`apps/desktop/CONTEXT.md`, "Engine supervisor"), not an app bundle. It has no
notification identity of its own under UserNotifications, which is keyed to a signed bundle
(section 1). The route that fits the sources is for the daemon to **start the shell** through its
URL scheme or bundle id. The shell then posts the notification. When the shell is already running,
the single-instance lock routes the URL to it.

## 6. Libraries and deprecated paths

- **Electron's tutorial names only userland helpers:** `electron-windows-notifications`,
  `electron-windows-interactive-notifications`, `windows-notification-state` and
  `macos-notification-state` (`docs/tutorial/notifications.md`). The Windows ones predate
  Electron's own toast activator and `handleActivation` (42), and `macos-notification-state` does
  not read UN authorization (section 1). None is needed for click-to-open.
- **No primary source recommends a third-party wrapper over the built-in module.** I found no
  Electron reference to `node-notifier`. Nothing primary supports adding it.
- **Avoid NSUserNotification-era assumptions.**
  - Don't rely on `NSUserNotificationAlertStyle` (section 2).
  - Don't expect notifications from unsigned builds (section 1).
  - Don't expect a `userInfo` payload from Electron's API. The `app` `ready` doc still mentions
    `NSUserNotification` `userInfo`, but 43 never sets `userInfo` on the notifications it posts.

## Recommendation for cogwork

1. **API and process.** Use the main-process `Notification` from `electron`, behind one small
   `main` module that owns a `Map<id, Notification>`, so live notifications are not
   garbage-collected and removed. Use `groupId` = the work item or Run, so a Run's notifications
   group together and `Notification.removeGroup` clears them once the person has seen the item.
   Leave out action buttons and inline reply for v1. Approving a plan from a banner is a
   trust-boundary decision, and buttons need extra conditions on macOS.
2. **Who decides to notify.** The trigger is a daemon event ("needs attention"). Note the existing
   rule in `apps/desktop/CONTEXT.md`: "`main` is a dumb pipe — it never decodes the RPC". There are
   two clean options:
   - Give `main` its own narrow subscription to an attention event, and update the context doc and
     an ADR to say so.
   - Have the renderer's activity session forward "notify" requests over the typed IPC seam.
   
   The first keeps working when the renderer is reloading or crashed. The second keeps `main` dumb.
   Decide this explicitly; don't let it happen by accident.
3. **Permission flow.** The first `Notification` call (even `isSupported()`) shows the macOS
   prompt. Make that first call when the person turns on "Notify me", not at boot, as Apple
   advises: "Make the request in a context that helps people understand why"
   ([Asking permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)).
   Treat `failed` as "not allowed or not signed": log the error string, keep the in-app indicator,
   and offer to open System Settings → Notifications. Don't rely on `isSupported()` to mean
   "allowed".
4. **Click opens the item.** Make each `id` a short stable reference (`run:<id>`,
   `plan:<id>`; ≤ 64 UTF-16 characters for Windows). On `click`, call `showWindow()` and send the
   reference to the renderer over the typed IPC seam, which navigates the TanStack Router route.
   Register a `cogwork://` scheme (`CFBundleURLTypes` through electron-builder `protocols`, plus
   `setAsDefaultProtocolClient`) so the same reference also works from outside the app. On
   Windows, set `toastXml` with `launch="cogwork://…"` and handle `Notification.handleActivation`.
5. **When the app is closed.**
   - **Window hidden:** already covered by close-to-hide and the tray.
   - **App quit:** on launch, call `Notification.getHistory()` once (macOS) and re-attach `click`
     handlers by `id`. Also read `launchInfo.identifier` from the `ready` event, in case the
     launch came from a notification click.
   - **Daemon outlives the shell:** offer an opt-in "Open at login" (`setLoginItemSettings`). If
     the daemon must notify while no shell runs, have it start the shell through `cogwork://` or
     `open -b <bundle id>` instead of notifying itself.
   - **Unverified:** cold-start click delivery on macOS 26 (see the delegate-timing gap in
     section 2). Test it on a signed build before relying on it.
6. **App id fix.** Make `index.ts` call `electronApp.setAppUserModelId("com.scribehow.cogwork")`,
   the `appId` in `electron-builder.yml`. Better, read both from one constant so they cannot drift.
   Consider pinning a CLSID with `app.setToastActivatorCLSID` so the Windows registration stays
   stable across runs.
7. **Dev builds.** Expect `failed` in `electron-vite dev`, because the npm `Electron.app` is ad-hoc
   signed (`com.github.Electron`). Log it clearly and fall back to in-app attention. To exercise
   real notifications, either:
   - test a signed `build:unpack` output, or
   - follow Electron's CI recipe on the dev `Electron.app`: a trusted self-signed identity, then
     `codesign --deep --force`, then `lsregister -f`. Notifications will then show as "Electron",
     not cogwork.
   
   Set `ELECTRON_DEBUG_NOTIFICATIONS=1` while testing. Packaged macOS builds must be signed
   (`mac.notarize: false` in `electron-builder.yml` is a separate concern from signing).
