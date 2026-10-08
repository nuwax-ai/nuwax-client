// 在 Electron 主进程中查询当前应用的通知授权；只读，不申请授权或替换 delegate。
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

struct Query {
  napi_async_work work;
  napi_deferred deferred;
  UNUserNotificationCenter *__strong center;
  int32_t status = -1;
};

static void Execute(napi_env env, void *data) {
  Query *query = static_cast<Query *>(data);
  @autoreleasepool {
    @try {
      // completion 可能晚于超时到达，不能捕获随后会被释放的 query。
      __block int32_t status = -1;
      dispatch_semaphore_t signal = dispatch_semaphore_create(0);
      [query->center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        status = static_cast<int32_t>(settings.authorizationStatus);
        dispatch_semaphore_signal(signal);
      }];
      if (dispatch_semaphore_wait(signal, dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC)) == 0) {
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

static napi_value ReadSettings(napi_env env, napi_callback_info info) {
  Query *query = new Query();
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value readSettings;
  napi_create_function(env, "readSettings", NAPI_AUTO_LENGTH, ReadSettings, nullptr, &readSettings);
  napi_set_named_property(env, exports, "readSettings", readSettings);
  return exports;
}

NAPI_MODULE(mac_notification_permission, Init)
