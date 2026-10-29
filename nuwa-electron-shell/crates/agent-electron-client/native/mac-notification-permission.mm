// Keep authorization and IM delivery on the modern API in the Electron host identity.
// Forward unrelated modern notifications to the previously installed delegate.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

struct NotificationListener {
  napi_env env;
  napi_threadsafe_function callback;
};
struct NotificationEvent { const char *name; int32_t code; };
static std::mutex listenersMutex;
static std::unordered_map<std::string, NotificationListener> listeners;
struct PendingNotification { napi_env env; bool closed = false; };
static std::unordered_map<std::string, std::shared_ptr<PendingNotification>> pendingNotifications;

static void RemoveNotification(const std::string &id) {
  @autoreleasepool {
    @try {
      NSArray<NSString *> *ids = @[[NSString stringWithUTF8String:id.c_str()]];
      UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
      [center removePendingNotificationRequestsWithIdentifiers:ids];
      [center removeDeliveredNotificationsWithIdentifiers:ids];
    } @catch (NSException *exception) { /* Account cleanup remains best-effort. */ }
  }
}

static void CallNotificationListener(napi_env env, napi_value callback, void *, void *data) {
  NotificationEvent *event = static_cast<NotificationEvent *>(data);
  if (env && callback) {
    napi_value receiver, args[2];
    napi_get_undefined(env, &receiver);
    napi_create_string_utf8(env, event->name, NAPI_AUTO_LENGTH, &args[0]);
    napi_create_int32(env, event->code, &args[1]);
    napi_call_function(env, receiver, callback, 2, args, nullptr);
  }
  delete event;
}

static void ReleaseNotificationListener(const std::string &id) {
  std::lock_guard<std::mutex> lock(listenersMutex);
  auto found = listeners.find(id);
  if (found == listeners.end()) return;
  napi_release_threadsafe_function(found->second.callback, napi_tsfn_abort);
  listeners.erase(found);
}

static void EmitNotificationEvent(const std::string &id, const char *name, int32_t code = 0, bool terminal = true) {
  std::lock_guard<std::mutex> lock(listenersMutex);
  auto found = listeners.find(id);
  if (found == listeners.end()) return;
  auto callback = found->second.callback;
  if (terminal) listeners.erase(found);
  auto *event = new NotificationEvent{name, code};
  if (napi_call_threadsafe_function(callback, event, napi_tsfn_nonblocking) != napi_ok) delete event;
  if (terminal) napi_release_threadsafe_function(callback, napi_tsfn_release);
}

static bool OwnNotification(NSString *id) { return [id hasPrefix:@"nuwax.im."]; }

@interface NuwaxNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, strong) id<UNUserNotificationCenterDelegate> previousDelegate;
@end

@implementation NuwaxNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  if (OwnNotification(notification.request.identifier)) {
    UNNotificationPresentationOptions options = UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
    if (notification.request.content.sound) options |= UNNotificationPresentationOptionSound;
    completion(options);
  } else if ([self.previousDelegate respondsToSelector:_cmd]) {
    [self.previousDelegate userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion];
  } else {
    completion(UNNotificationPresentationOptionNone);
  }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
  NSString *id = response.notification.request.identifier;
  if (OwnNotification(id)) {
    const char *event = [response.actionIdentifier isEqualToString:UNNotificationDismissActionIdentifier] ? "close" : "click";
    EmitNotificationEvent(id.UTF8String, event);
    completion();
  } else if ([self.previousDelegate respondsToSelector:_cmd]) {
    [self.previousDelegate userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completion];
  } else {
    completion();
  }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center openSettingsForNotification:(UNNotification *)notification {
  if ([self.previousDelegate respondsToSelector:_cmd]) {
    [self.previousDelegate userNotificationCenter:center openSettingsForNotification:notification];
  }
}
@end

static NuwaxNotificationDelegate *notificationDelegate;

static void CleanupNotificationListeners(void *data) {
  std::lock_guard<std::mutex> lock(listenersMutex);
  for (const auto &entry : pendingNotifications) {
    if (entry.second->env == data) entry.second->closed = true;
  }
  for (auto it = listeners.begin(); it != listeners.end();) {
    if (it->second.env == data) {
      napi_release_threadsafe_function(it->second.callback, napi_tsfn_abort);
      it = listeners.erase(it);
    } else ++it;
  }
}

static bool ReadString(napi_env env, napi_value value, std::string &result, size_t limit) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  result.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &length) != napi_ok) return false;
  result.resize(length);
  return true;
}

static napi_value ShowNotification(napi_env env, napi_callback_info info) {
  size_t count = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  std::string id, title, body;
  bool silent;
  napi_valuetype callbackType;
  if (count != 5 || !ReadString(env, args[0], id, 256) || id.rfind("nuwax.im.", 0) != 0 ||
      !ReadString(env, args[1], title, 2048) || !ReadString(env, args[2], body, 4096) ||
      napi_get_value_bool(env, args[3], &silent) != napi_ok ||
      napi_typeof(env, args[4], &callbackType) != napi_ok || callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "Invalid native notification arguments");
    return nullptr;
  }
  napi_value resourceName;
  napi_create_string_utf8(env, "nuwax-im-notification", NAPI_AUTO_LENGTH, &resourceName);
  napi_threadsafe_function callback;
  if (napi_create_threadsafe_function(env, args[4], nullptr, resourceName, 0, 1, nullptr, nullptr,
                                    nullptr, CallNotificationListener, &callback) != napi_ok) {
    napi_throw_error(env, nullptr, "Cannot create native notification listener");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, callback);
  ReleaseNotificationListener(id);
  auto pending = std::make_shared<PendingNotification>();
  pending->env = env;
  {
    std::lock_guard<std::mutex> lock(listenersMutex);
    listeners.emplace(id, NotificationListener{env, callback});
    pendingNotifications[id] = pending;
  }
  @autoreleasepool {
    @try {
      UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
      if (!notificationDelegate) notificationDelegate = [NuwaxNotificationDelegate new];
      if (center.delegate != notificationDelegate) {
        notificationDelegate.previousDelegate = center.delegate;
        center.delegate = notificationDelegate;
      }
      UNMutableNotificationContent *content = [UNMutableNotificationContent new];
      content.title = [NSString stringWithUTF8String:title.c_str()];
      content.body = [NSString stringWithUTF8String:body.c_str()];
      if (!silent) content.sound = UNNotificationSound.defaultSound;
      UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[NSString stringWithUTF8String:id.c_str()] content:content trigger:nil];
      // Permission is requested only by the explicit settings action, never by message delivery.
      [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        bool closed;
        {
          std::lock_guard<std::mutex> lock(listenersMutex);
          closed = pending->closed;
          pendingNotifications.erase(id);
        }
        // clear()/logout may run before the asynchronous add finishes. Remove
        // again after completion so an old account's request cannot arrive late.
        if (closed) RemoveNotification(id);
        else if (error) EmitNotificationEvent(id, "failed", static_cast<int32_t>(error.code));
        // Accepted by the OS, not proof that a banner or Notification Center row is visible.
        // Keep the listener alive for the later click/dismiss callback.
        else EmitNotificationEvent(id, "submitted", 0, false);
      }];
    } @catch (NSException *exception) {
      {
        std::lock_guard<std::mutex> lock(listenersMutex);
        pendingNotifications.erase(id);
      }
      EmitNotificationEvent(id, "failed", -1);
    }
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value ReleaseOrCloseNotification(napi_env env, napi_callback_info info, bool close) {
  size_t count = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  std::string id;
  if (count != 1 || !ReadString(env, arg, id, 256) || id.rfind("nuwax.im.", 0) != 0) {
    napi_throw_type_error(env, nullptr, "Invalid native notification identifier");
    return nullptr;
  }
  ReleaseNotificationListener(id);
  if (close) {
    {
      std::lock_guard<std::mutex> lock(listenersMutex);
      auto pending = pendingNotifications.find(id);
      if (pending != pendingNotifications.end()) pending->second->closed = true;
    }
    RemoveNotification(id);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value ReleaseNotification(napi_env env, napi_callback_info info) { return ReleaseOrCloseNotification(env, info, false); }
static napi_value CloseNotification(napi_env env, napi_callback_info info) { return ReleaseOrCloseNotification(env, info, true); }

struct Query {
  napi_async_work work;
  napi_deferred deferred;
  UNUserNotificationCenter *__strong center;
  int32_t status = -1;
  bool request = false;
};

static void Execute(napi_env env, void *data) {
  Query *query = static_cast<Query *>(data);
  @autoreleasepool {
    @try {
      // completion 可能晚于超时到达，不能捕获随后会被释放的 query。
      __block int32_t status = -1;
      dispatch_semaphore_t signal = dispatch_semaphore_create(0);
      UNUserNotificationCenter *center = query->center;
      void (^readSettings)(void) = ^{
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
          status = static_cast<int32_t>(settings.authorizationStatus);
          dispatch_semaphore_signal(signal);
        }];
      };
      if (query->request) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge
                            completionHandler:^(BOOL granted, NSError *error) {
          if (error) {
            dispatch_semaphore_signal(signal);
          } else {
            readSettings();
          }
        }];
      } else {
        readSettings();
      }
      // An authorization prompt needs time for a human response. All completion
      // blocks own their state, so a response after the timeout remains safe.
      int64_t timeout = query->request ? 60 * NSEC_PER_SEC : 1500 * NSEC_PER_MSEC;
      if (dispatch_semaphore_wait(signal, dispatch_time(DISPATCH_TIME_NOW, timeout)) == 0) {
        query->status = status;
      }
    } @catch (NSException *exception) {
      query->status = -1;
    }
  }
}

static void Complete(napi_env env, napi_status status, void *data) {
  Query *query = static_cast<Query *>(data);
  napi_value result;
  napi_create_int32(env, status == napi_ok ? query->status : -1, &result);
  napi_resolve_deferred(env, query->deferred, result);
  napi_delete_async_work(env, query->work);
  delete query;
}

static napi_value StartQuery(napi_env env, bool request) {
  Query *query = new Query();
  query->request = request;
  // currentNotificationCenter 必须在宿主应用身份下初始化；裸 node 不查询其他应用。
  @autoreleasepool {
    @try {
      if (NSBundle.mainBundle.bundleIdentifier.length > 0) {
        query->center = UNUserNotificationCenter.currentNotificationCenter;
      }
    } @catch (NSException *exception) {
      query->center = nil;
    }
  }
  napi_value promise, name;
  if (napi_create_promise(env, &query->deferred, &promise) != napi_ok) {
    delete query;
    return nullptr;
  }
  if (!query->center) {
    napi_value result;
    napi_create_int32(env, -1, &result);
    napi_resolve_deferred(env, query->deferred, result);
    delete query;
    return promise;
  }
  napi_create_string_utf8(env, "mac-notification-permission", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, query, &query->work) != napi_ok) {
    delete query;
    napi_throw_error(env, nullptr, "Cannot create notification settings query");
    return nullptr;
  }
  if (napi_queue_async_work(env, query->work) != napi_ok) {
    napi_delete_async_work(env, query->work);
    delete query;
    napi_throw_error(env, nullptr, "Cannot queue notification settings query");
    return nullptr;
  }
  return promise;
}

static napi_value ReadSettings(napi_env env, napi_callback_info info) {
  return StartQuery(env, false);
}

static napi_value RequestAuthorization(napi_env env, napi_callback_info info) {
  return StartQuery(env, true);
}

// Only inspect the public geometry of System Settings. This never requests
// Accessibility, Screen Recording, Automation, or another app's window titles.
static napi_value SystemSettingsWindow(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_null(env, &result);
  @autoreleasepool {
    NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"];
    if (apps.count == 0) return result;
    pid_t pid = apps.firstObject.processIdentifier;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *window in windows) {
      if ([window[(id)kCGWindowOwnerPID] intValue] != pid || [window[(id)kCGWindowLayer] intValue] != 0 || [window[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
      CGRect bounds;
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds) || bounds.size.width < 300 || bounds.size.height < 300) continue;
      napi_create_object(env, &result);
      const char *keys[] = {"x", "y", "width", "height"};
      const double values[] = {bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height};
      for (int i = 0; i < 4; ++i) {
        napi_value number;
        napi_create_double(env, values[i], &number);
        napi_set_named_property(env, result, keys[i], number);
      }
      break;
    }
  }
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, CleanupNotificationListeners, env);
  const napi_property_descriptor notificationMethods[] = {
    {"showNotification", nullptr, ShowNotification, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseNotification", nullptr, ReleaseNotification, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeNotification", nullptr, CloseNotification, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, notificationMethods);
  napi_value readSettings;
  napi_create_function(env, "readSettings", NAPI_AUTO_LENGTH, ReadSettings, nullptr, &readSettings);
  napi_set_named_property(env, exports, "readSettings", readSettings);
  napi_value requestAuthorization;
  napi_create_function(env, "requestAuthorization", NAPI_AUTO_LENGTH, RequestAuthorization, nullptr, &requestAuthorization);
  napi_set_named_property(env, exports, "requestAuthorization", requestAuthorization);
  napi_value systemSettingsWindow;
  napi_create_function(env, "systemSettingsWindow", NAPI_AUTO_LENGTH, SystemSettingsWindow, nullptr, &systemSettingsWindow);
  napi_set_named_property(env, exports, "systemSettingsWindow", systemSettingsWindow);
  return exports;
}

NAPI_MODULE(mac_notification_permission, Init)
