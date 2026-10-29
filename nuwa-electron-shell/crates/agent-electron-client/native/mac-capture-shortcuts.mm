#include <node_api.h>
#include <Carbon/Carbon.h>
#include <pthread.h>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <unordered_map>

namespace {
struct Binding {
  EventHotKeyRef key;
  napi_threadsafe_function callback;
};
struct Registry {
  napi_env env;
  UInt32 signature;
  UInt32 next = 1;
  EventHandlerRef handler = nullptr;
  EventHandlerUPP procedure = nullptr;
  std::unordered_map<UInt32, Binding> bindings;
};

void CallJavaScript(napi_env env, napi_value callback, void *, void *) {
  if (!env || !callback) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value receiver;
  if (napi_get_undefined(env, &receiver) == napi_ok)
    napi_call_function(env, receiver, callback, 0, nullptr, nullptr);
  napi_close_handle_scope(env, scope);
}

OSStatus OnHotKey(EventHandlerCallRef, EventRef event, void *data) {
  auto *registry = static_cast<Registry *>(data);
  EventHotKeyID id{};
  if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, nullptr,
      sizeof(id), nullptr, &id) != noErr || id.signature != registry->signature)
    return eventNotHandledErr;
  const auto found = registry->bindings.find(id.id);
  if (found == registry->bindings.end()) return eventNotHandledErr;
  napi_call_threadsafe_function(found->second.callback, nullptr, napi_tsfn_nonblocking);
  return noErr;
}

void RemoveIdleHandler(Registry *registry) {
  if (!registry->bindings.empty()) return;
  if (registry->handler) { RemoveEventHandler(registry->handler); registry->handler = nullptr; }
  if (registry->procedure) { DisposeEventHandlerUPP(registry->procedure); registry->procedure = nullptr; }
}

OSStatus Release(Registry *registry, UInt32 id) {
  const auto found = registry->bindings.find(id);
  if (found == registry->bindings.end()) return paramErr;
  const Binding binding = found->second;
  registry->bindings.erase(found);
  const OSStatus status = UnregisterEventHotKey(binding.key);
  napi_release_threadsafe_function(binding.callback, napi_tsfn_abort);
  RemoveIdleHandler(registry);
  return status;
}

void Cleanup(void *data) {
  auto *registry = static_cast<Registry *>(data);
  while (!registry->bindings.empty()) Release(registry, registry->bindings.begin()->first);
  RemoveIdleHandler(registry);
  delete registry;
}

napi_value Result(napi_env env, UInt32 id, OSStatus status) {
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, id, &value); napi_set_named_property(env, result, "id", value);
  napi_create_int32(env, status, &value); napi_set_named_property(env, result, "status", value);
  return result;
}

bool ReadInteger(napi_env env, napi_value value, double maximum, UInt32 &result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number)
      || number < 0 || number > maximum || std::floor(number) != number) return false;
  result = static_cast<UInt32>(number);
  return true;
}

napi_value Register(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3];
  void *data = nullptr;
  napi_get_cb_info(env, info, &count, args, nullptr, &data);
  auto *registry = static_cast<Registry *>(data);
  UInt32 keyCode = 0, modifiers = 0;
  napi_valuetype type;
  const UInt32 allowed = cmdKey | optionKey | shiftKey;
  if (!pthread_main_np() || count != 3 || !ReadInteger(env, args[0], 127, keyCode)
      || !ReadInteger(env, args[1], allowed, modifiers) || (modifiers & ~allowed)
      || !(modifiers & (cmdKey | optionKey)) || napi_typeof(env, args[2], &type) != napi_ok
      || type != napi_function || registry->next == 0) return Result(env, 0, paramErr);

  napi_value name;
  napi_create_string_utf8(env, "capture-exclusive-hotkey", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  if (napi_create_threadsafe_function(env, args[2], nullptr, name, 1, 1, nullptr,
      nullptr, nullptr, CallJavaScript, &callback) != napi_ok) return Result(env, 0, memFullErr);
  napi_unref_threadsafe_function(env, callback);

  OSStatus status = noErr;
  if (!registry->handler) {
    registry->procedure = NewEventHandlerUPP(OnHotKey);
    const EventTypeSpec kind = {kEventClassKeyboard, kEventHotKeyPressed};
    status = InstallApplicationEventHandler(registry->procedure, 1, &kind, registry, &registry->handler);
  }
  const UInt32 id = registry->next++;
  EventHotKeyRef key = nullptr;
  if (status == noErr) {
    const EventHotKeyID identity = {registry->signature, id};
    // OS exclusivity is best-effort across applications and macOS versions.
    // Do not downgrade a rejected exclusive registration to an ordinary one.
    status = RegisterEventHotKey(keyCode, modifiers, identity, GetApplicationEventTarget(), kEventHotKeyExclusive, &key);
  }
  if (status != noErr) {
    napi_release_threadsafe_function(callback, napi_tsfn_abort);
    RemoveIdleHandler(registry);
    return Result(env, 0, status);
  }
  registry->bindings.emplace(id, Binding{key, callback});
  return Result(env, id, noErr);
}

napi_value Unregister(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument, value;
  void *data = nullptr;
  napi_get_cb_info(env, info, &count, &argument, nullptr, &data);
  UInt32 id = 0;
  const OSStatus status = pthread_main_np() && count == 1 && ReadInteger(env, argument, UINT32_MAX, id)
    ? Release(static_cast<Registry *>(data), id) : paramErr;
  napi_create_int32(env, status, &value);
  return value;
}

napi_value Init(napi_env env, napi_value exports) {
  auto *registry = new Registry{env, arc4random()};
  if (registry->signature == 0) registry->signature = 0x4e574350;
  const napi_property_descriptor functions[] = {
    {"register", nullptr, Register, nullptr, nullptr, nullptr, napi_default, registry},
    {"unregister", nullptr, Unregister, nullptr, nullptr, nullptr, napi_default, registry},
  };
  napi_define_properties(env, exports, 2, functions);
  napi_value version;
  napi_create_uint32(env, 1, &version); napi_set_named_property(env, exports, "apiVersion", version);
  napi_add_env_cleanup_hook(env, Cleanup, registry);
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
